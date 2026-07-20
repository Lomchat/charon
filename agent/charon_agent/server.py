"""Main daemon: Unix socket server + JSON-RPC dispatch + session mgmt."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import sys
import time
import traceback
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Awaitable

from . import __version__


def _compute_pyz_sha() -> str:
    """SHA256 (first 12 chars) of the .pyz file we're running.

    Used by the dashboard to detect that an agent update is available
    without having to bump __version__ on every change. sys.argv[0] points to
    the .pyz when the agent is launched via `python charon-agent.pyz`. If the
    file is not found (dev case without pyz), returns "dev".
    """
    try:
        pyz = sys.argv[0]
        if not pyz or not os.path.isfile(pyz):
            return "dev"
        h = hashlib.sha256()
        with open(pyz, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()[:12]
    except Exception:
        return "unknown"


_PYZ_SHA = _compute_pyz_sha()
from . import protocol
from .protocol import (
    ERR_INTERNAL,
    ERR_INVALID_PARAMS,
    ERR_METHOD_NOT_FOUND,
    ERR_PARSE,
    ERR_SDK_UNAVAILABLE,
    ERR_SESSION_DEAD,
    ERR_SESSION_NOT_FOUND,
    RpcError,
)
from .event_log import EventLog, cleanup_orphans
from .session import AgentSession, SDK_AVAILABLE, SDK_IMPORT_ERROR, SDK_VERSION
from .shell import AgentShell
from .state import load_state, save_state


RING_SIZE = 2000  # events buffered per session for late subscribers
# Why 2000: deltas (assistant_text, thinking) arrive at ~50-100/sec during
# a streaming response. The previous 300 saturated in ~3-6s, which meant a
# normal Charon `systemctl restart` during a long response could lose events
# the hub never persisted (cf. CLAUDE.md gotchas around layer-4 resilience).
# 2000 covers ~20-40s of high-throughput streaming, which is well above any
# expected hub-side downtime window. Memory cost is bounded: payloads are
# small dicts (~200 bytes typical), so 2000 events × ~16 active sessions
# fits in a few MB.


class Server:
    def __init__(self, *, socket_path: Path, state_path: Path) -> None:
        self.socket_path = socket_path
        self.state_path = state_path
        # Durable event logs live next to state.json, in ~/.charon/events/.
        self.events_dir = state_path.parent / "events"
        # Persistent PTY shells (>= 0.7.0). Same _emit + rings + subscribers
        # plumbing as sessions, but the durable log lives in a SEPARATE dir
        # (`~/.charon/shells/`) so shell IDs can't collide with session IDs
        # in the filesystem namespace. Since 0.10.0 the PTY + bash live in a
        # DETACHED holder process (holder.py) that survives agent restarts;
        # boot re-attaches via the `*.sock` files in that same dir.
        self.shells_dir = state_path.parent / "shells"
        self.shells: dict[str, AgentShell] = {}
        self.shell_event_logs: dict[str, EventLog] = {}
        self.sessions: dict[str, AgentSession] = {}
        self.rings: dict[str, deque[dict[str, Any]]] = {}
        # Per-session durable log. Created on first emit (lazy via _emit),
        # cleaned up on kill. Lookups via _event_log(session_id).
        self.event_logs: dict[str, EventLog] = {}
        # subscribers: session_id → set[Client]   (shared between sessions and
        # shells; the routing key is the id, and session/shell IDs never
        # collide in practice — sessions are 32-hex UUIDs, shells are 16-hex).
        self.subscribers: dict[str, set[Client]] = {}
        # shell_watchers: clients that asked for shell LIFECYCLE events
        # (shell_status / shell_exit / shell_idle) across ALL shells, WITHOUT
        # the high-volume shell_output byte stream. Charon's notification
        # consumer uses this to learn when a shell "finished something" while
        # the heavy output keeps flowing only to the WS subscribers (avoids
        # doubling egress — see CLAUDE.md §14 on the shell idle-notify path).
        self.shell_watchers: set[Client] = set()
        self._state_lock = asyncio.Lock()
        self._save_pending = False
        self._stopping = False

    def _event_log(self, session_id: str) -> EventLog:
        log = self.event_logs.get(session_id)
        if log is None:
            log = EventLog(session_id, self.events_dir)
            self.event_logs[session_id] = log
        return log

    # ── Persistence ──────────────────────────────────────────────────────────
    async def _save_state_now(self) -> None:
        async with self._state_lock:
            try:
                sessions = [s.to_persist() for s in self.sessions.values()]
                # save_state is sync (short file). No need for a threadpool.
                save_state(self.state_path, sessions)
            except Exception:
                traceback.print_exc(file=sys.stderr)

    def schedule_save(self) -> None:
        """Save async, debounced (to avoid writing several times in a burst)."""
        if self._save_pending:
            return
        self._save_pending = True
        asyncio.create_task(self._debounced_save())

    async def _debounced_save(self) -> None:
        try:
            await asyncio.sleep(0.2)
            await self._save_state_now()
        finally:
            self._save_pending = False

    # ── Sessions ─────────────────────────────────────────────────────────────
    def _emit(self, payload: dict[str, Any]) -> None:
        """Callback that sessions / shells call to broadcast an event.

        Order of operations matters here:
        1. Append to durable log FIRST — this attaches `seq` and `ts` to
           the payload in place. Subscribers and the ring then see the
           same fields. If we appended last, the live broadcast would
           reach clients without a seq, which defeats the whole point.
        2. Append to in-memory ring (live replay for re-subscribe).
        3. Broadcast to current subscribers.

        The log append is best-effort: a disk failure logs to stderr but
        does not block the broadcast (the ring is still populated, so
        live UI keeps working).

        Shell events (event name starting with `shell_`) are routed to a
        DEDICATED log dir (`~/.charon/shells/`) so they don't share the
        sessions namespace on disk. Rings + subscribers are the same Map —
        IDs are globally unique in practice (sessions: 32-hex UUID, shells:
        16-hex) so there's no key collision.
        """
        sid = payload.get("session_id")
        if not isinstance(sid, str):
            return
        event_name = payload.get("event") if isinstance(payload.get("event"), str) else ""
        is_shell = event_name.startswith("shell_")
        # TRANSIENT shell events are broadcast live (+ fanned to watchers) but
        # NEVER logged or ringed, so a replay (full-log after_seq:0 OR the
        # tail_bytes replay, cf. gotcha 37) never resurfaces a stale one:
        #   · shell_idle   — a "finished something" hint; replaying it would
        #                    re-fire a bogus "finished" notification.
        #   · shell_status — the live busy/active UI hint (blue-tab parity with
        #                    Claude "thinking", gotcha 42). The CURRENT status is
        #                    recomputed fresh on every shell_subscribe, so it
        #                    needn't survive in the log; and since these carry no
        #                    `data`, read_tail (which budgets on `data` length)
        #                    would otherwise collect EVERY past toggle in the
        #                    tail window and replay them as stale status frames.
        # shell_exit STAYS durable (a reconnect must learn the shell is dead).
        transient = event_name in ("shell_idle", "shell_status", "usage", "bg_task_progress")
        if not transient:
            # 1. durable log (mutates payload to add seq, ts)
            try:
                if is_shell:
                    log = self.shell_event_logs.get(sid)
                    if log is None:
                        log = EventLog(sid, self.shells_dir)
                        self.shell_event_logs[sid] = log
                else:
                    log = self._event_log(sid)
                log.append(payload)
            except Exception as e:
                print(f"[server] event_log.append error sid={sid}: {e}",
                      file=sys.stderr, flush=True)
            # 2. ring buffer (fast path for in-memory replay)
            ring = self.rings.setdefault(sid, deque(maxlen=RING_SIZE))
            ring.append(payload)
        # 3. live broadcast. Shell LIFECYCLE events (everything except the
        #    high-volume shell_output) also fan out to global shell watchers
        #    — lightweight subscribers (Charon's notify consumer) that want
        #    lifecycle signals WITHOUT the output stream.
        targets = self.subscribers.get(sid, ())
        if is_shell and event_name != "shell_output" and self.shell_watchers:
            targets = set(targets) | self.shell_watchers
        for client in list(targets):
            client.send_json(payload)

    async def _create_session(
        self,
        *,
        session_id: str,
        cwd: str,
        name: str | None,
        permission_mode: str,
        claude_session_id: str | None,
        model: str | None = None,
        fallback_model: str | None = None,
        effort: str | None = None,
    ) -> AgentSession:
        s = AgentSession(
            session_id,
            cwd=cwd,
            name=name,
            permission_mode=permission_mode,
            claude_session_id=claude_session_id,
            emit=self._emit,
            on_state_change=self._save_state_now,
            model=model,
            fallback_model=fallback_model,
            effort=effort,
        )
        self.sessions[session_id] = s
        self.rings.setdefault(session_id, deque(maxlen=RING_SIZE))
        await s.start()
        self.schedule_save()
        return s

    async def _restore_existing(self) -> None:
        """At boot: reload state.json and attempt a resume for each session.

        Sessions ignored at restore:
          - status='killed'    → dead for good
          - status='sleeping'  → explicit pause by the user, stays paused
        For sessions being resumed but without a claude_session_id (never out
        of 'starting' before a crash), we add them in memory with status
        'sleeping' so they are visible but not relaunched on their own
        (a user's first query never actually initialized them).
        """
        state = load_state(self.state_path)
        sessions = state.get("sessions", []) or []
        for row in sessions:
            try:
                sid = row.get("session_id")
                cwd = row.get("cwd")
                if not sid or not cwd:
                    continue
                status = row.get("status")
                if status in ("killed",):
                    continue
                if status == "sleeping":
                    # Load in memory without starting the SDK
                    self._register_sleeping(row)
                    continue
                print(f"[boot] restoring session {sid} (cwd={cwd})", file=sys.stderr, flush=True)
                await self._create_session(
                    session_id=sid,
                    cwd=cwd,
                    name=row.get("name"),
                    permission_mode=row.get("permission_mode") or "normal",
                    claude_session_id=row.get("claude_session_id"),
                    model=row.get("model"),
                    fallback_model=row.get("fallback_model"),
                    effort=row.get("effort"),
                )
            except Exception as e:
                print(f"[boot] restore failed: {e}", file=sys.stderr, flush=True)

    def _register_sleeping(self, row: dict[str, Any]) -> None:
        """Registers a session in memory with status 'sleeping' without starting it.
        Used at boot for sessions paused by the user — list_sessions
        sees them, and an explicit resume will start the SDK."""
        s = AgentSession(
            row["session_id"],
            cwd=row["cwd"],
            name=row.get("name"),
            permission_mode=row.get("permission_mode") or "normal",
            claude_session_id=row.get("claude_session_id"),
            emit=self._emit,
            on_state_change=self._save_state_now,
            model=row.get("model"),
            fallback_model=row.get("fallback_model"),
            effort=row.get("effort"),
        )
        s.status = "sleeping"
        self.sessions[row["session_id"]] = s
        self.rings.setdefault(row["session_id"], deque(maxlen=RING_SIZE))

    # ── JSON-RPC dispatch ───────────────────────────────────────────────────
    # `dispatch` is a thin router: it groups methods by domain and delegates
    # to a per-domain async handler. The handlers operate on the same self.*
    # state and contain the moved-over branches verbatim — no behaviour change
    # (same params, return shapes, error codes, and event emission). The set
    # of methods is unchanged (cf. protocol.METHODS).
    _META_METHODS = frozenset({"hello", "ping", "list_sessions"})
    _SESSION_METHODS = frozenset({
        "start_session", "subscribe", "unsubscribe", "send_input", "interrupt",
        "set_permission_mode", "set_model", "set_effort", "respond_permission",
        "respond_question", "respond_exit_plan", "resume_session",
        "sleep_session", "force_stop", "kill_session",
    })
    _SHELL_METHODS = frozenset({
        "shell_list", "shell_start", "shell_input", "shell_resize",
        "shell_subscribe", "shell_unsubscribe", "shell_watch", "shell_unwatch",
        "shell_kill",
    })

    async def dispatch(self, method: str, params: dict[str, Any], client: "Client") -> Any:
        if method in self._META_METHODS:
            return await self._handle_meta_rpc(method, params, client)
        if method in self._SESSION_METHODS:
            return await self._handle_session_rpc(method, params, client)
        if method in self._SHELL_METHODS:
            return await self._handle_shell_rpc(method, params, client)
        raise RpcError(ERR_METHOD_NOT_FOUND, f"unknown method: {method}")

    # ── Meta / lifecycle handlers ────────────────────────────────────────────
    async def _handle_meta_rpc(self, method: str, params: dict[str, Any], client: "Client") -> Any:
        if method == "hello":
            return {
                "agent_version": __version__,
                "agent_pyz_sha": _PYZ_SHA,
                "sdk_available": SDK_AVAILABLE,
                "sdk_error": SDK_IMPORT_ERROR,
                "sdk_version": SDK_VERSION,
                "pid": os.getpid(),
                "sessions": [s.to_info() for s in self.sessions.values()],
            }

        if method == "ping":
            return {"pong": True, "ts": time.time()}

        if method == "list_sessions":
            return [s.to_info() for s in self.sessions.values()]

        raise RpcError(ERR_METHOD_NOT_FOUND, f"unknown method: {method}")

    # ── Session handlers ─────────────────────────────────────────────────────
    async def _handle_session_rpc(self, method: str, params: dict[str, Any], client: "Client") -> Any:
        if method == "start_session":
            session_id = params.get("session_id") or uuid.uuid4().hex
            cwd = params.get("cwd")
            if not isinstance(cwd, str) or not cwd:
                raise RpcError(ERR_INVALID_PARAMS, "cwd required")
            if session_id in self.sessions:
                raise RpcError(ERR_INVALID_PARAMS, f"session {session_id} already exists")
            if not SDK_AVAILABLE:
                raise RpcError(ERR_SDK_UNAVAILABLE, f"SDK unavailable: {SDK_IMPORT_ERROR}")
            await self._create_session(
                session_id=session_id,
                cwd=cwd,
                name=params.get("name"),
                permission_mode=params.get("permission_mode") or "normal",
                claude_session_id=params.get("claude_session_id"),
                model=params.get("model"),
                fallback_model=params.get("fallback_model"),
                effort=params.get("effort"),
            )
            return {"session_id": session_id}

        if method == "subscribe":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            # Two replay modes, prefer after_seq when both are provided:
            #   - `after_seq`: durable replay from event_log (new in 0.4.0).
            #     Returns ALL events with seq > after_seq, across rotations.
            #   - `replay`: in-memory ring tail (backward compat for old hub
            #     clients pre-0.4.0). Capped by RING_SIZE.
            after_seq_param = params.get("after_seq")
            after_seq = int(after_seq_param) if isinstance(after_seq_param, (int, float)) else None
            replay = int(params.get("replay") or 0)
            if sid not in self.subscribers:
                self.subscribers[sid] = set()
            self.subscribers[sid].add(client)
            client.subscribed.add(sid)
            sent = 0
            items: list[dict[str, Any]] = []
            if after_seq is not None:
                try:
                    items = self._event_log(sid).read_since(after_seq)
                except Exception as e:
                    print(f"[server] event_log.read_since error sid={sid}: {e}",
                          file=sys.stderr, flush=True)
                    items = []
            elif replay > 0:
                ring = self.rings.get(sid)
                if ring:
                    items = list(ring)[-replay:]
            # "Replay start" marker so that the client can skip DB
            # persistence for events it already saw before its drop.
            if items:
                client.send_json({"event": "replay_begin", "session_id": sid, "count": len(items)})
                for item in items:
                    client.send_json(item)
                    sent += 1
                client.send_json({"event": "replay_end", "session_id": sid})
            # Emit a status so that the client knows the current state
            client.send_json({"event": "status", "session_id": sid, "status": s.status})
            # `current_seq` lets the caller checkpoint at subscribe time —
            # useful if they want to advance their cursor even when the
            # replay was empty (e.g. they were already caught up).
            try:
                current_seq = self._event_log(sid).current_seq()
            except Exception:
                current_seq = 0
            return {"ok": True, "replay_count": sent, "status": s.status,
                    "current_seq": current_seq}

        if method == "unsubscribe":
            sid = self._require_sid(params)
            self.subscribers.get(sid, set()).discard(client)
            client.subscribed.discard(sid)
            return {"ok": True}

        if method == "send_input":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            content = params.get("content")
            if not isinstance(content, str):
                raise RpcError(ERR_INVALID_PARAMS, "content required (str)")
            await s.send_input(content)
            return {"ok": True}

        if method == "interrupt":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            await s.interrupt()
            return {"ok": True}

        if method == "set_permission_mode":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            mode = params.get("mode") or "normal"
            await s.set_permission_mode(mode)
            return {"ok": True, "mode": s.permission_mode}

        if method == "set_model":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            model = params.get("model")
            fallback_model = params.get("fallback_model")
            if model is not None and not isinstance(model, str):
                raise RpcError(ERR_INVALID_PARAMS, "model must be a string or null")
            if fallback_model is not None and not isinstance(fallback_model, str):
                raise RpcError(ERR_INVALID_PARAMS, "fallback_model must be a string or null")
            await s.set_model(model, fallback_model)
            return {
                "ok": True,
                "model": s.model,
                "fallback_model": s.fallback_model,
                "applied_at_next_start": s._client is not None,
            }

        if method == "set_effort":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            effort = params.get("effort")
            if effort is not None and not isinstance(effort, str):
                raise RpcError(ERR_INVALID_PARAMS, "effort must be a string or null")
            await s.set_effort(effort)
            return {
                "ok": True,
                "effort": s.effort,
                "applied_at_next_start": s._client is not None,
            }

        if method == "respond_permission":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            perm_id = params.get("perm_id") or params.get("id")
            if not isinstance(perm_id, str):
                raise RpcError(ERR_INVALID_PARAMS, "perm_id required")
            s.respond_permission(perm_id, bool(params.get("allow")))
            return {"ok": True}

        if method == "respond_question":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            q_id = params.get("q_id") or params.get("id")
            if not isinstance(q_id, str):
                raise RpcError(ERR_INVALID_PARAMS, "q_id required")
            answers = params.get("answers")
            s.respond_question(q_id, answers if isinstance(answers, dict) else None)
            return {"ok": True}

        if method == "respond_exit_plan":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            q_id = params.get("q_id") or params.get("id")
            if not isinstance(q_id, str):
                raise RpcError(ERR_INVALID_PARAMS, "q_id required")
            decision = params.get("decision") or "reject"
            feedback = params.get("feedback") or ""
            s.respond_exit_plan(q_id, decision, feedback)
            return {"ok": True}

        if method == "resume_session":
            # For a session already in memory (typically after an agent
            # reboot where it was registered 'sleeping'), restart the SDK.
            sid = self._require_sid(params)
            s = self._require_session(sid)
            if s.status in ("active", "thinking", "starting"):
                return {"ok": True, "status": s.status, "noop": True}
            # Reset internal state so we can restart cleanly
            s.status = "starting"
            s._stopped.clear()
            s._ready_evt.clear()
            s._session_id_emitted = False
            s._main_task = None
            await s.start()
            self.schedule_save()
            return {"ok": True, "status": s.status}

        if method == "sleep_session":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            await s.stop(mark="sleeping")
            self.schedule_save()
            return {"ok": True}

        if method == "force_stop":
            # Brutal cancellation (the SDK is blocked and the soft interrupt
            # is ineffective). The session goes to 'sleeping' immediately;
            # the user can resume without waiting for the current tool to finish.
            sid = self._require_sid(params)
            s = self._require_session(sid)
            await s.force_stop()
            self.schedule_save()
            return {"ok": True}

        if method == "kill_session":
            sid = self._require_sid(params)
            s = self.sessions.get(sid)
            if s is not None:
                await s.stop(mark="killed")
            self.sessions.pop(sid, None)
            self.rings.pop(sid, None)
            self.subscribers.pop(sid, None)
            # Tear down the durable event log for this session — it is
            # gone for good, no future subscriber will ever want its
            # history.
            log = self.event_logs.pop(sid, None)
            if log is not None:
                try:
                    log.delete()
                except Exception as e:
                    print(f"[server] event_log.delete error sid={sid}: {e}",
                          file=sys.stderr, flush=True)
            self.schedule_save()
            return {"ok": True}

        raise RpcError(ERR_METHOD_NOT_FOUND, f"unknown method: {method}")

    # ── Persistent PTY shells (>= 0.7.0) ─────────────────────────────────────
    # Same plumbing as sessions (rings, subscribers, durable event log via
    # _emit) but a separate set of RPCs and a dedicated log dir
    # (`~/.charon/shells/`). Shell IDs are the channel key, passed as either
    # `shell_id` or `session_id` (the latter for protocol reuse — the routing
    # layer keys by `session_id` anyway).
    async def _handle_shell_rpc(self, method: str, params: dict[str, Any], client: "Client") -> Any:
        if method == "shell_list":
            return [sh.to_info() for sh in self.shells.values()]

        if method == "shell_start":
            shell_id = params.get("shell_id") or uuid.uuid4().hex
            if not isinstance(shell_id, str) or not shell_id:
                raise RpcError(ERR_INVALID_PARAMS, "shell_id must be a string")
            if shell_id in self.shells:
                raise RpcError(ERR_INVALID_PARAMS, f"shell {shell_id} already exists")
            cwd = params.get("cwd")
            name = params.get("name")
            cols = params.get("cols")
            rows = params.get("rows")
            sh = AgentShell(
                shell_id,
                cwd=cwd if isinstance(cwd, str) and cwd else None,
                name=name if isinstance(name, str) and name else None,
                emit=self._emit,
                shells_dir=self.shells_dir,
            )
            self.shells[shell_id] = sh
            self.rings.setdefault(shell_id, deque(maxlen=RING_SIZE))
            try:
                await sh.start(
                    initial_cols=int(cols) if isinstance(cols, (int, float)) else None,
                    initial_rows=int(rows) if isinstance(rows, (int, float)) else None,
                )
            except Exception as e:
                self.shells.pop(shell_id, None)
                self.rings.pop(shell_id, None)
                self.shell_event_logs.pop(shell_id, None)
                raise RpcError(ERR_INTERNAL, f"shell start failed: {type(e).__name__}: {e}")
            return {"shell_id": shell_id, "pid": sh.pid, "cols": sh.cols, "rows": sh.rows}

        if method == "shell_input":
            sid = self._require_shell_sid(params)
            sh = self._require_shell(sid)
            data = params.get("data")
            if not isinstance(data, str):
                raise RpcError(ERR_INVALID_PARAMS, "data required (str)")
            # Text straight through: the holder client re-encodes into its
            # line-JSON protocol; ctrl codes (\r, \t, \x03, …) survive as-is.
            sh.write(data)
            return {"ok": True}

        if method == "shell_resize":
            sid = self._require_shell_sid(params)
            sh = self._require_shell(sid)
            cols = params.get("cols")
            rows = params.get("rows")
            if not isinstance(cols, (int, float)) or not isinstance(rows, (int, float)):
                raise RpcError(ERR_INVALID_PARAMS, "cols/rows (int) required")
            sh.resize(int(cols), int(rows))
            return {"ok": True, "cols": sh.cols, "rows": sh.rows}

        if method == "shell_subscribe":
            sid = self._require_shell_sid(params)
            sh = self._require_shell(sid)
            after_seq_param = params.get("after_seq")
            after_seq = int(after_seq_param) if isinstance(after_seq_param, (int, float)) else None
            tail_bytes_param = params.get("tail_bytes")
            tail_bytes = (
                int(tail_bytes_param)
                if isinstance(tail_bytes_param, (int, float)) and tail_bytes_param > 0
                else None
            )
            if sid not in self.subscribers:
                self.subscribers[sid] = set()
            self.subscribers[sid].add(client)
            client.subscribed.add(sid)
            # Replay from the durable shell log. No `replay` (ring) fallback
            # for shells: shells are 0.7.0+ and all clients speak the new
            # protocol.
            #   - `tail_bytes` (>= 0.9.0): replay only the suffix of the log
            #     (the last ~N bytes of output) so a reopened shell shows the
            #     latest screen near-instantly with bounded VPS→hub egress.
            #     Wins over `after_seq` when both are sent (server.js sends
            #     after_seq:0 + tail_bytes). Old agents ignore tail_bytes and
            #     fall through to the full read_since(0) — no regression.
            #   - `after_seq`: full (0) or incremental durable replay.
            items: list[dict[str, Any]] = []
            log = self.shell_event_logs.get(sid)
            if log is None:
                log = EventLog(sid, self.shells_dir)
                self.shell_event_logs[sid] = log
            if tail_bytes is not None:
                try:
                    items = log.read_tail(tail_bytes)
                except Exception as e:
                    print(f"[server] shell log read_tail error sid={sid}: {e}",
                          file=sys.stderr, flush=True)
                    items = []
            elif after_seq is not None:
                try:
                    items = log.read_since(after_seq)
                except Exception as e:
                    print(f"[server] shell log read_since error sid={sid}: {e}",
                          file=sys.stderr, flush=True)
                    items = []
            if items:
                client.send_json({"event": "replay_begin", "session_id": sid, "count": len(items)})
                for item in items:
                    client.send_json(item)
                client.send_json({"event": "replay_end", "session_id": sid})
            client.send_json({
                "event": "shell_status",
                "session_id": sid,
                "shell_id": sid,
                "status": "exited" if sh.exited else "active",
                "cols": sh.cols,
                "rows": sh.rows,
                "pid": sh.pid,
            })
            try:
                current_seq = log.current_seq()
            except Exception:
                current_seq = 0
            return {
                "ok": True,
                "replay_count": len(items),
                "status": "exited" if sh.exited else "active",
                "current_seq": current_seq,
            }

        if method == "shell_unsubscribe":
            sid = self._require_shell_sid(params)
            self.subscribers.get(sid, set()).discard(client)
            client.subscribed.discard(sid)
            return {"ok": True}

        if method == "shell_watch":
            # Global, output-free lifecycle watch over ALL shells (current +
            # future). Used by Charon's persistent AgentClient for idle
            # notifications. Takes no params. Returns a snapshot of live
            # shells so the watcher can map ids → names without a separate
            # shell_list round-trip. Lifecycle events (shell_status /
            # shell_exit / shell_idle) are delivered via _emit's watcher
            # fan-out; shell_output is NOT (that stays on the WS subscribers).
            self.shell_watchers.add(client)
            return {"ok": True, "shells": [sh.to_info() for sh in self.shells.values()]}

        if method == "shell_unwatch":
            self.shell_watchers.discard(client)
            return {"ok": True}

        if method == "shell_kill":
            sid = self._require_shell_sid(params)
            sh = self.shells.get(sid)
            if sh is not None:
                sh.kill()
            self.shells.pop(sid, None)
            self.rings.pop(sid, None)
            self.subscribers.pop(sid, None)
            log = self.shell_event_logs.pop(sid, None)
            if log is not None:
                try:
                    log.delete()
                except Exception as e:
                    print(f"[server] shell_event_log.delete error sid={sid}: {e}",
                          file=sys.stderr, flush=True)
            return {"ok": True}

        raise RpcError(ERR_METHOD_NOT_FOUND, f"unknown method: {method}")

    def _require_sid(self, params: dict[str, Any]) -> str:
        sid = params.get("session_id")
        if not isinstance(sid, str) or not sid:
            raise RpcError(ERR_INVALID_PARAMS, "session_id required")
        return sid

    def _require_shell_sid(self, params: dict[str, Any]) -> str:
        # Accept either `shell_id` (the natural Charon-side name) or
        # `session_id` (the protocol's routing key) — they're the same
        # value, just different semantic labels.
        sid = params.get("shell_id") or params.get("session_id")
        if not isinstance(sid, str) or not sid:
            raise RpcError(ERR_INVALID_PARAMS, "shell_id required")
        return sid

    def _require_session(self, sid: str) -> AgentSession:
        s = self.sessions.get(sid)
        if s is None:
            raise RpcError(ERR_SESSION_NOT_FOUND, f"session {sid} not found")
        return s

    def _require_shell(self, sid: str) -> AgentShell:
        sh = self.shells.get(sid)
        if sh is None:
            raise RpcError(ERR_SESSION_NOT_FOUND, f"shell {sid} not found")
        return sh

    # ── Server lifecycle ─────────────────────────────────────────────────────
    async def serve(self) -> None:
        # Clean stale socket
        if self.socket_path.exists():
            try:
                self.socket_path.unlink()
            except OSError as e:
                print(f"[server] can't unlink stale socket: {e}", file=sys.stderr)

        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.socket_path.parent, 0o700)
        except OSError:
            pass

        await self._restore_existing()

        # Cleanup orphan event logs: any .jsonl file in ~/.charon/events/
        # whose session_id is not in our restored state. These accumulate
        # when sessions are deleted while the agent is offline.
        try:
            known = set(self.sessions.keys())
            removed = cleanup_orphans(self.events_dir, known)
            if removed:
                print(f"[boot] cleaned up {removed} orphan event log file(s)",
                      file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[boot] event log cleanup failed: {e}",
                  file=sys.stderr, flush=True)
        # Shells DO survive agent restart since 0.10.0: bash lives in a
        # detached holder process (holder.py). Re-attach to every live
        # holder socket; only shells with NO live holder (stale sock from a
        # crash, or bash exited while we were down) get their logs wiped.
        live_shell_ids: set[str] = set()
        try:
            if self.shells_dir.exists():
                for sock in sorted(self.shells_dir.glob("*.sock")):
                    sid = sock.stem
                    sh = AgentShell(
                        sid, cwd=None, name=None,
                        emit=self._emit, shells_dir=self.shells_dir,
                    )
                    try:
                        await sh.attach()
                        self.shells[sid] = sh
                        self.rings.setdefault(sid, deque(maxlen=RING_SIZE))
                        live_shell_ids.add(sid)
                        print(f"[boot] re-attached shell {sid} "
                              f"(bash pid={sh.pid}, holder pid={sh.holder_pid})",
                              file=sys.stderr, flush=True)
                    except Exception as e:
                        print(f"[boot] stale shell sock {sid}: {e}",
                              file=sys.stderr, flush=True)
                        try:
                            sock.unlink()
                        except OSError:
                            pass
        except Exception as e:
            print(f"[boot] shell re-attach failed: {e}", file=sys.stderr, flush=True)
        try:
            removed_shells = cleanup_orphans(self.shells_dir, live_shell_ids)
            # cleanup_orphans only sweeps `.jsonl*`; also drop spool files
            # left by holders that died while we were away.
            if self.shells_dir.exists():
                for entry in self.shells_dir.glob("*.spool"):
                    if entry.stem not in live_shell_ids:
                        try:
                            entry.unlink()
                            removed_shells += 1
                        except OSError:
                            pass
            if removed_shells:
                print(f"[boot] cleaned up {removed_shells} orphan shell file(s)",
                      file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[boot] shell log cleanup failed: {e}",
                  file=sys.stderr, flush=True)

        server = await asyncio.start_unix_server(
            self._handle_client, path=str(self.socket_path)
        )
        try:
            os.chmod(self.socket_path, 0o600)
        except OSError:
            pass

        print(
            f"[server] charon-agent {__version__} listening on {self.socket_path} "
            f"(sdk_ok={SDK_AVAILABLE}, sessions={len(self.sessions)})",
            file=sys.stderr,
            flush=True,
        )

        loop = asyncio.get_event_loop()
        stop_evt = asyncio.Event()

        def _signal_handler() -> None:
            print("[server] signal received, shutting down…", file=sys.stderr, flush=True)
            stop_evt.set()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _signal_handler)
            except NotImplementedError:
                pass

        async with server:
            serve_task = asyncio.create_task(server.serve_forever())
            await stop_evt.wait()
            self._stopping = True
            serve_task.cancel()
            try:
                await serve_task
            except asyncio.CancelledError:
                pass
            # Save final state and stop sessions
            await self._save_state_now()
            for s in list(self.sessions.values()):
                try:
                    await s.stop(mark="sleeping")
                except Exception:
                    pass
            try:
                self.socket_path.unlink()
            except OSError:
                pass
        print("[server] bye", file=sys.stderr, flush=True)

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        client = Client(self, reader, writer)
        try:
            await client.run()
        finally:
            # Remove from all subscriptions
            for sid in list(client.subscribed):
                self.subscribers.get(sid, set()).discard(client)
            client.subscribed.clear()
            # Drop any global shell-lifecycle watch held by this client.
            self.shell_watchers.discard(client)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass


class Client:
    """An open JSON-RPC connection (multiplexed read/write)."""

    def __init__(
        self,
        server: Server,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        self.server = server
        self.reader = reader
        self.writer = writer
        self.subscribed: set[str] = set()
        self._send_lock = asyncio.Lock()
        self._closed = False

    def send_json(self, obj: dict[str, Any]) -> None:
        """Schedule a send (non-blocking, fire-and-forget)."""
        if self._closed:
            return
        asyncio.create_task(self._send_locked(obj))

    async def _send_locked(self, obj: dict[str, Any]) -> None:
        async with self._send_lock:
            if self._closed:
                return
            try:
                line = json.dumps(obj, default=str) + "\n"
                self.writer.write(line.encode())
                await self.writer.drain()
            except (ConnectionResetError, BrokenPipeError):
                self._closed = True
            except Exception:
                traceback.print_exc(file=sys.stderr)

    async def run(self) -> None:
        while not self._closed:
            try:
                line = await self.reader.readline()
            except (asyncio.IncompleteReadError, ConnectionResetError):
                break
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                await self._send_locked(
                    protocol.make_error(None, ERR_PARSE, f"json parse: {e}")
                )
                continue
            req_id = msg.get("id")
            method = msg.get("method")
            params = msg.get("params") or {}
            if not isinstance(method, str) or not isinstance(params, dict):
                await self._send_locked(
                    protocol.make_error(
                        req_id if isinstance(req_id, int) else None,
                        ERR_INVALID_REQUEST_,
                        "invalid request shape",
                    )
                )
                continue
            # Dispatch async
            asyncio.create_task(self._handle_one(req_id, method, params))

    async def _handle_one(self, req_id: Any, method: str, params: dict[str, Any]) -> None:
        try:
            result = await self.server.dispatch(method, params, self)
            if isinstance(req_id, int):
                await self._send_locked(protocol.make_response(req_id, result))
        except RpcError as e:
            await self._send_locked(protocol.make_error(req_id, e.code, e.message))
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            await self._send_locked(
                protocol.make_error(req_id, ERR_INTERNAL, f"{type(e).__name__}: {e}")
            )


# Local alias to avoid forward-ref pain in Client.run
ERR_INVALID_REQUEST_ = protocol.ERR_INVALID_REQUEST
