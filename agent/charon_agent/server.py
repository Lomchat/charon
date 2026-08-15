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
from .fsnav import (
    list_dir as fs_list_dir,
    fs_list as _fs_list,
    fs_read as _fs_read,
    fs_stat as _fs_stat,
    fs_write as _fs_write,
    fs_mkdir as _fs_mkdir,
    fs_rename as _fs_rename,
    fs_delete as _fs_delete,
    fs_search as _fs_search,
)
from .lsp import (
    lsp_status as _lsp_status,
    lsp_open as _lsp_open,
    lsp_close as _lsp_close,
    lsp_diagnostics as _lsp_diagnostics,
    lsp_request as _lsp_request,
    lsp_apply_edit as _lsp_apply_edit,
    lsp_stop as _lsp_stop,
    shutdown_all as _lsp_shutdown_all,
)
from .git import (
    git_commit as _git_commit,
    git_diff as _git_diff,
    git_discard as _git_discard,
    git_pull as _git_pull,
    git_push as _git_push,
    git_status as _git_status,
    git_workspace as _git_workspace,
    git_branches as _git_branches,
    git_log as _git_log,
    git_show as _git_show,
    git_checkout as _git_checkout,
    git_fetch as _git_fetch,
    git_delete_branch as _git_delete_branch,
)


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
from .event_log import EventLog, cleanup_orphans, find_missing_ranges
from .session import AgentSession, SDK_AVAILABLE, SDK_IMPORT_ERROR, SDK_VERSION
from .codex_session import (
    CodexSession,
    CODEX_AVAILABLE,
    CODEX_IMPORT_ERROR,
    CODEX_SDK_VERSION,
    CODEX_CLI_VERSION,
    fetch_codex_models,
    fetch_codex_usage,
)
from .shell import AgentShell
from .state import load_state, save_state
from .usage import fetch_usage


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
        # AgentSession (Claude) OR CodexSession — both expose the same contract.
        self.sessions: dict[str, Any] = {}
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
        # Idempotency keys for send_input (P1.1): per-session ring of the
        # last client_message_ids ACCEPTED. A hub retry after an ambiguous
        # RPC timeout re-sends the same id → answered {ok, duplicate} without
        # re-executing the prompt. Ids are recorded AFTER send_input succeeds
        # (a failed attempt must stay retryable with the same id).
        self.recent_input_ids: dict[str, deque[str]] = {}
        # IN-FLIGHT send_input futures (Codex 16.4): a duplicate arriving
        # while the first attempt is still awaiting must not be answered
        # "duplicate" optimistically — if the first attempt then FAILED, the
        # hub would believe a prompt landed that never did. Duplicates await
        # the SAME future and share the first attempt's actual outcome.
        self.inflight_inputs: dict[tuple[str, str], asyncio.Future] = {}
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

    def _make_session(
        self,
        *,
        kind: str,
        session_id: str,
        cwd: str,
        name: str | None,
        permission_mode: str,
        claude_session_id: str | None,
        model: str | None,
        fallback_model: str | None,
        effort: str | None,
    ) -> Any:
        """Factory keyed on the agent-type discriminator. Claude → AgentSession,
        Codex → CodexSession. Both share the exact constructor signature +
        public/private contract that this server drives."""
        cls = CodexSession if kind == "codex" else AgentSession
        return cls(
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

    async def _create_session(
        self,
        *,
        session_id: str,
        cwd: str,
        name: str | None,
        permission_mode: str,
        claude_session_id: str | None,
        kind: str = "claude",
        model: str | None = None,
        fallback_model: str | None = None,
        effort: str | None = None,
    ) -> Any:
        s = self._make_session(
            kind=kind,
            session_id=session_id,
            cwd=cwd,
            name=name,
            permission_mode=permission_mode,
            claude_session_id=claude_session_id,
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
                kind = row.get("kind") or "claude"
                print(f"[boot] restoring session {sid} (kind={kind}, cwd={cwd})", file=sys.stderr, flush=True)
                await self._create_session(
                    session_id=sid,
                    cwd=cwd,
                    name=row.get("name"),
                    permission_mode=row.get("permission_mode") or "normal",
                    claude_session_id=row.get("claude_session_id"),
                    kind=kind,
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
        s = self._make_session(
            kind=row.get("kind") or "claude",
            session_id=row["session_id"],
            cwd=row["cwd"],
            name=row.get("name"),
            permission_mode=row.get("permission_mode") or "normal",
            claude_session_id=row.get("claude_session_id"),
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
    _META_METHODS = frozenset({
        "hello", "ping", "list_sessions", "get_usage",
        "list_codex_models", "get_codex_usage",
        "codex_login_start", "codex_login_status", "codex_login_cancel",
        "list_dir",
        "git_status", "git_workspace", "git_diff", "git_commit", "git_push",
        "git_pull", "git_discard",
        "git_branches", "git_checkout", "git_fetch", "git_delete_branch",
        "git_log", "git_show",
        "lsp_status", "lsp_open", "lsp_close", "lsp_diagnostics", "lsp_request",
        "lsp_apply_edit", "lsp_stop",
        "fs_list", "fs_read", "fs_stat", "fs_write", "fs_mkdir", "fs_rename", "fs_delete",
        "fs_search",
    })
    _SESSION_METHODS = frozenset({
        "start_session", "subscribe", "unsubscribe", "send_input", "interrupt",
        "set_permission_mode", "set_model", "set_effort", "set_session_name",
        "fork_session", "get_context_usage", "mcp_status", "mcp_toggle",
        "mcp_reconnect", "list_subagents", "get_subagent_messages",
        "respond_permission",
        "respond_question", "respond_exit_plan", "resume_session",
        "sleep_session", "force_stop", "kill_session", "stop_bg_task",
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
                # Codex availability (agent >= 0.15.0). Absent on older agents;
                # the hub only writes these when present (§14.53 no-null-clobber).
                "codex_available": CODEX_AVAILABLE,
                "codex_error": CODEX_IMPORT_ERROR,
                "codex_sdk_version": CODEX_SDK_VERSION,
                "codex_cli_version": CODEX_CLI_VERSION,
                "pid": os.getpid(),
                "sessions": [s.to_info() for s in self.sessions.values()],
            }

        if method == "ping":
            return {"pong": True, "ts": time.time()}

        if method == "list_dir":
            # Path-autocomplete backend (hub NewSessionWizard). scandir runs
            # off the event loop; ~1ms over the persistent pipe vs ~0.5s for
            # a one-shot ssh exec (sshd session setup). Agent >= 0.17.0.
            return await asyncio.to_thread(fs_list_dir, str(params.get("path") or ""))

        if method == "fs_list":
            # Read-only tree expansion (agent >= 0.25.0). scandir + an optional
            # `git check-ignore` run off the event loop.
            return await asyncio.to_thread(
                _fs_list, str(params.get("root") or ""), str(params.get("path") or ""),
                bool(params.get("with_git")),
            )

        if method == "fs_read":
            return await asyncio.to_thread(
                _fs_read, str(params.get("root") or ""), str(params.get("path") or ""),
            )

        if method == "fs_stat":
            return await asyncio.to_thread(
                _fs_stat, str(params.get("root") or ""), str(params.get("path") or ""),
            )

        if method == "fs_write":
            exp = params.get("expected_sha256")
            return await asyncio.to_thread(
                _fs_write, str(params.get("root") or ""), str(params.get("path") or ""),
                str(params.get("content") or ""),
                None if exp is None else str(exp),
            )

        if method == "fs_mkdir":
            return await asyncio.to_thread(
                _fs_mkdir, str(params.get("root") or ""), str(params.get("path") or ""))

        if method == "fs_rename":
            return await asyncio.to_thread(
                _fs_rename, str(params.get("root") or ""), str(params.get("path") or ""),
                str(params.get("to") or ""))

        if method == "fs_delete":
            return await asyncio.to_thread(
                _fs_delete, str(params.get("root") or ""), str(params.get("path") or ""),
                bool(params.get("recursive")))

        if method == "fs_search":
            # Tree-wide search (agent >= 0.29.0). The heaviest read this daemon
            # serves — a whole-repo walk plus a regex over every text file — so
            # it goes off the event loop like the rest, and bounds itself well
            # under the hub's 60s RPC timeout rather than relying on it.
            try:
                cap = int(params.get("max_results") or 0)
            except (TypeError, ValueError):
                cap = 0
            return await asyncio.to_thread(
                _fs_search, str(params.get("root") or ""), str(params.get("query") or ""),
                str(params.get("mode") or "text"),
                bool(params.get("regex")), bool(params.get("case_sensitive")),
                bool(params.get("whole_word")),
                str(params.get("include") or ""), str(params.get("exclude") or ""),
                params.get("use_default_excludes") is not False,
                cap,
            )

        # Language servers (agent >= 0.33.0, lsp.py). OUTSIDE the git branch:
        # nesting them under `startswith("git_")` made every one of them
        # unreachable, and the METHODS-vs-dispatch test could not see it —
        # it scans for the literal `method == "..."`, not for where it sits.
        # Each blocks on a subprocess, so it runs off the event loop.
        if method == "lsp_status":
            return await asyncio.to_thread(_lsp_status, params)
        if method == "lsp_open":
            return await asyncio.to_thread(_lsp_open, params)
        if method == "lsp_close":
            return await asyncio.to_thread(_lsp_close, params)
        if method == "lsp_diagnostics":
            return await asyncio.to_thread(_lsp_diagnostics, params)
        if method == "lsp_request":
            return await asyncio.to_thread(_lsp_request, params)
        if method == "lsp_apply_edit":
            return await asyncio.to_thread(_lsp_apply_edit, params)
        if method == "lsp_stop":
            return await asyncio.to_thread(_lsp_stop, params)

        if method.startswith("git_"):
            # Source-control panel backend (agent >= 0.24.0, git.py). Every
            # entry point shells out to git, so it runs off the event loop —
            # a slow `git status` on a huge repo, a pre-commit hook or a push
            # over a bad network must never stall session I/O. The functions
            # never raise: failures come back as {ok: False, reason} for the
            # UI to turn into an actionable message.
            cwd = str(params.get("cwd") or "")
            if method == "git_status":
                return await asyncio.to_thread(
                    _git_status, cwd, bool(params.get("include_recent"))
                )
            if method == "git_workspace":
                return await asyncio.to_thread(
                    _git_workspace, cwd,
                    int(params.get("scan_depth") or 3),
                    bool(params.get("include_recent")),
                    bool(params.get("refresh")),
                )
            if method == "git_log":
                return await asyncio.to_thread(_git_log, cwd, params)
            if method == "git_show":
                return await asyncio.to_thread(_git_show, cwd, params)
            if method == "git_branches":
                return await asyncio.to_thread(
                    _git_branches, cwd, params.get("include_remote", True) is not False
                )
            if method == "git_checkout":
                return await asyncio.to_thread(_git_checkout, cwd, params)
            if method == "git_fetch":
                return await asyncio.to_thread(_git_fetch, cwd, bool(params.get("prune")))
            if method == "git_delete_branch":
                return await asyncio.to_thread(_git_delete_branch, cwd, params)
            if method == "git_diff":
                return await asyncio.to_thread(_git_diff, cwd, str(params.get("path") or ""))
            if method == "git_commit":
                return await asyncio.to_thread(_git_commit, cwd, params)
            if method == "git_push":
                return await asyncio.to_thread(_git_push, cwd)
            if method == "git_pull":
                return await asyncio.to_thread(_git_pull, cwd)
            if method == "git_discard":
                return await asyncio.to_thread(_git_discard, cwd, params)

        if method == "list_sessions":
            return [s.to_info() for s in self.sessions.values()]

        if method == "get_usage":
            # Account-scoped `/usage` data (five_hour / seven_day utilization,
            # limits[], extra_usage). Blocking urllib GET → run off the event
            # loop so a slow/hung endpoint never stalls session I/O. Never
            # raises; returns {ok:False,...} on any failure. §14.58.
            return await asyncio.to_thread(fetch_usage)

        if method == "list_codex_models":
            # Codex model catalog (account-driven, per-VPS). Spins up a
            # short-lived app-server client. Never raises. (agent >= 0.15.0)
            return await fetch_codex_models()

        if method == "get_codex_usage":
            # Codex account-usage snapshot (rate-limit utilization) — the Codex
            # analog of get_usage. Never raises. (agent >= 0.15.0)
            return await fetch_codex_usage()

        # Codex ChatGPT device-code login (agent >= 0.16.0) — headless-safe
        # `codex login` replacement; the hub polls status. codex_login.py.
        if method == "codex_login_start":
            from . import codex_login
            return await codex_login.start()
        if method == "codex_login_status":
            from . import codex_login
            return await codex_login.status(str(params.get("login_id") or ""))
        if method == "codex_login_cancel":
            from . import codex_login
            return await codex_login.cancel(str(params.get("login_id") or ""))

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
            kind = params.get("kind") or "claude"
            if kind not in ("claude", "codex"):
                raise RpcError(ERR_INVALID_PARAMS, f"unknown kind: {kind}")
            if kind == "codex":
                if not CODEX_AVAILABLE:
                    raise RpcError(ERR_SDK_UNAVAILABLE, f"Codex SDK unavailable: {CODEX_IMPORT_ERROR}")
            else:
                if not SDK_AVAILABLE:
                    raise RpcError(ERR_SDK_UNAVAILABLE, f"SDK unavailable: {SDK_IMPORT_ERROR}")
            await self._create_session(
                session_id=session_id,
                cwd=cwd,
                name=params.get("name"),
                permission_mode=params.get("permission_mode") or "normal",
                claude_session_id=params.get("claude_session_id"),
                kind=kind,
                model=params.get("model"),
                fallback_model=params.get("fallback_model"),
                effort=params.get("effort"),
            )
            return {"session_id": session_id, "kind": kind}

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
            # `earliest_seq` + `gap` (>= 0.18.0, P0.4): seqs are dense, so
            # earliest > after_seq + 1 proves events (after_seq, earliest)
            # were rotated away and can NEVER be replayed. The hub surfaces
            # that hole explicitly instead of accepting a silent jump.
            try:
                log = self._event_log(sid)
                current_seq = log.current_seq()
                earliest_seq = log.earliest_seq()
            except Exception:
                current_seq = 0
                earliest_seq = None
            gap = (
                after_seq is not None
                and isinstance(earliest_seq, int)
                and earliest_seq > after_seq + 1
            )
            # Non-rotation holes (corrupt/skipped lines, failed appends) —
            # leading, internal AND trailing relative to the requested range
            # (Codex 16.5). Rotation's share is excluded (reported via
            # gap/earliest_seq above). Sync with read_since: no await sits
            # between the read and current_seq(), so the range is consistent.
            internal_gaps: list[list[int]] = []
            if after_seq is not None:
                try:
                    internal_gaps = [
                        [a, b]
                        for a, b in find_missing_ranges(
                            items, after_seq, current_seq, earliest_seq
                        )
                    ]
                    if internal_gaps:
                        print(
                            f"[server] WARN: event-log holes for {sid}: "
                            f"{internal_gaps} (corrupt lines / failed appends)",
                            file=sys.stderr, flush=True,
                        )
                except Exception:
                    internal_gaps = []
            return {"ok": True, "replay_count": sent, "status": s.status,
                    "current_seq": current_seq, "earliest_seq": earliest_seq,
                    "gap": gap, "internal_gaps": internal_gaps}

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
            cmid = params.get("client_message_id")
            cmid = cmid if isinstance(cmid, str) and cmid else None
            if cmid is not None:
                seen = self.recent_input_ids.setdefault(sid, deque(maxlen=64))
                if cmid in seen:
                    # Already ACCEPTED — the hub's first attempt landed but its
                    # RPC response was lost (timeout). Do NOT re-send the prompt.
                    return {"ok": True, "duplicate": True}
                key = (sid, cmid)
                inflight = self.inflight_inputs.get(key)
                if inflight is not None:
                    # First attempt still running (Codex 16.4): share ITS
                    # outcome — success → duplicate:true; failure → this call
                    # fails too (no phantom "accepted"), and a later retry
                    # with the same id can genuinely execute.
                    await inflight
                    return {"ok": True, "duplicate": True}
                fut: asyncio.Future = asyncio.get_running_loop().create_future()
                self.inflight_inputs[key] = fut
                try:
                    await s.send_input(content)
                except Exception as e:
                    self.inflight_inputs.pop(key, None)
                    if not fut.done():
                        fut.set_exception(e)
                        fut.exception()  # mark retrieved (no un-awaited-warning)
                    raise
                # ACCEPTED: record the id, resolve waiters, release in-flight.
                seen.append(cmid)
                self.inflight_inputs.pop(key, None)
                if not fut.done():
                    fut.set_result(True)
                return {"ok": True}
            await s.send_input(content)
            return {"ok": True}

        if method == "interrupt":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            await s.interrupt()
            return {"ok": True}

        # NB: top-level branch on purpose - a dispatch nested under another
        # method's `if` is unreachable and the METHODS-vs-dispatch test cannot
        # see it (that shipped once, CLAUDE.md §14.89).
        if method == "stop_bg_task":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            task_id = params.get("task_id")
            if not isinstance(task_id, str) or not task_id:
                raise RpcError(ERR_INVALID_PARAMS, "task_id must be a non-empty string")
            fn = getattr(s, "stop_bg_task", None)
            if fn is None:  # Codex session: no per-task stop in that SDK
                raise RpcError(ERR_INVALID_PARAMS,
                               "stop_bg_task is not supported for this session kind")
            await fn(task_id)
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
            # Codex applies model per-turn (no sleep+resume) → not deferred.
            deferred = (getattr(s, "kind", "claude") != "codex") and s._client is not None
            return {
                "ok": True,
                "model": s.model,
                "fallback_model": s.fallback_model,
                "applied_at_next_start": deferred,
            }

        if method in ("get_context_usage", "mcp_status", "mcp_toggle",
                      "mcp_reconnect", "list_subagents", "get_subagent_messages"):
            sid = self._require_sid(params)
            s_ = self._require_session(sid)
            # All Claude-only: Codex has no equivalent surface (§14.59). Report
            # it rather than pretending the feature is merely empty.
            if getattr(s_, "kind", "claude") == "codex":
                return {"ok": False, "error": "not available on Codex sessions"}
            if method == "get_context_usage":
                return await s_.context_usage()
            if method == "mcp_status":
                return await s_.mcp_status()
            if method == "mcp_toggle":
                name = params.get("name")
                enabled = params.get("enabled")
                if not isinstance(name, str) or not isinstance(enabled, bool):
                    raise RpcError(ERR_INVALID_PARAMS, "name (str) and enabled (bool) required")
                return await s_.mcp_toggle(name, enabled)
            if method == "mcp_reconnect":
                name = params.get("name")
                if not isinstance(name, str) or not name:
                    raise RpcError(ERR_INVALID_PARAMS, "name must be a non-empty string")
                return await s_.mcp_reconnect(name)
            if method == "list_subagents":
                return s_.subagents()
            # Explicit rather than a fall-through: the protocol test scans for
            # the literal `method == "..."`, and §14.89 is the incident where a
            # branch it could not see shipped unreachable.
            if method == "get_subagent_messages":
                agent_id = params.get("agent_id")
                if not isinstance(agent_id, str) or not agent_id:
                    raise RpcError(ERR_INVALID_PARAMS, "agent_id must be a non-empty string")
                limit = params.get("limit")
                return s_.subagent_messages(agent_id, int(limit) if isinstance(limit, int) else 400)
            raise RpcError(ERR_INTERNAL, f"unhandled: {method}")

        if method == "fork_session":
            # Branch a session's transcript into a NEW one, optionally cutting
            # at a message. Pure file work (the SDK copies the transcript and
            # remaps every uuid) — it does NOT touch the live session, so the
            # original keeps running untouched, which is the whole point.
            sid = self._require_sid(params)
            s_ = self._require_session(sid)
            csid = getattr(s_, "claude_session_id", None)
            if not csid:
                raise RpcError(ERR_INVALID_PARAMS,
                               "session has no transcript yet — nothing to fork")
            up_to = params.get("up_to_message_id")
            if up_to is not None and not isinstance(up_to, str):
                raise RpcError(ERR_INVALID_PARAMS, "up_to_message_id must be a string")
            title = params.get("title")
            if title is not None and not isinstance(title, str):
                raise RpcError(ERR_INVALID_PARAMS, "title must be a string")
            try:
                from claude_agent_sdk import fork_session as _fork
            except Exception as e:
                raise RpcError(ERR_SDK_UNAVAILABLE,
                               f"this SDK cannot fork sessions: {e}")
            try:
                res = _fork(csid, directory=getattr(s_, "cwd", None),
                            up_to_message_id=up_to, title=title)
            except FileNotFoundError as e:
                raise RpcError(ERR_INVALID_PARAMS, f"transcript not found: {e}")
            except ValueError as e:
                # Bad uuid, or a message id that is not in this transcript.
                raise RpcError(ERR_INVALID_PARAMS, str(e))
            new_id = getattr(res, "session_id", None) or (
                res.get("session_id") if isinstance(res, dict) else None)
            if not isinstance(new_id, str) or not new_id:
                raise RpcError(ERR_INTERNAL, "fork returned no session id")
            return {"ok": True, "claude_session_id": new_id, "forked_from": csid}

        if method == "set_session_name":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            name = params.get("name")
            if not isinstance(name, str) or not name.strip():
                raise RpcError(ERR_INVALID_PARAMS, "name must be a non-empty string")
            s.name = name
            # Mirror it into the CLI's own transcript so `claude --resume <name>`
            # and the CLI's cross-session addressing agree with what Charon
            # displays. Never fatal: the hub keeps the name either way.
            written = False
            fn = getattr(s, "write_cli_title", None)   # Claude sessions only
            if callable(fn):
                try:
                    written = bool(fn(name))
                except Exception:
                    written = False
            return {"ok": True, "name": name, "cli_title": written}

        if method == "set_effort":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            effort = params.get("effort")
            if effort is not None and not isinstance(effort, str):
                raise RpcError(ERR_INVALID_PARAMS, "effort must be a string or null")
            await s.set_effort(effort)
            deferred = (getattr(s, "kind", "claude") != "codex") and s._client is not None
            return {
                "ok": True,
                "effort": s.effort,
                "applied_at_next_start": deferred,
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
            self.recent_input_ids.pop(sid, None)
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
            # A language server must not outlive the daemon that spawned it
            # (they are the heaviest thing here, §14.89).
            try:
                _lsp_shutdown_all()
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
            # The reader hit EOF: give the requests dispatched just before it
            # a bounded chance to answer, and let the writer flush them,
            # BEFORE anything is torn down (§14.75). Must run first — every
            # step below makes writes impossible. Nested try/finally because a
            # cancelled flush (daemon shutting down) must NOT skip the cleanup
            # below: that would leak this client in `subscribers` forever.
            try:
                await client.flush_before_close()
            finally:
                # Remove from all subscriptions
                for sid in list(client.subscribed):
                    self.subscribers.get(sid, set()).discard(client)
                client.subscribed.clear()
                # Drop any global shell-lifecycle watch held by this client.
                self.shell_watchers.discard(client)
                # Stop the bounded-queue writer (P0.5).
                client._closed = True
                try:
                    client._writer_task.cancel()
                except Exception:
                    pass
                try:
                    writer.close()
                    await writer.wait_closed()
                except Exception:
                    pass


# Bounded per-client send queue (P0.5). Before this, every send_json spawned
# its own asyncio task waiting on a shared lock: a wedged transport (hub that
# stopped reading, half-dead SSH) accumulated tasks + payloads without limit
# until the AGENT OOMed — taking every session on the VPS down with it.
# Caps sized for the worst legitimate burst (a full durable-log replay of a
# busy session ≈ thousands of events): overflow means the peer is truly stuck.
SEND_QUEUE_MAX_EVENTS = 10_000
SEND_QUEUE_MAX_BYTES = 32 * 1024 * 1024

# Grace budget for the post-EOF flush (§14.75). Generous enough for any normal
# RPC round-trip, short enough that a dead transport or a genuinely slow call
# can't wedge the per-connection cleanup.
EOF_FLUSH_GRACE_S = 5.0


class Client:
    """An open JSON-RPC connection (multiplexed read/write).

    Writes go through ONE bounded FIFO queue drained by a single writer
    coroutine — strict ordering for everything (replay events enqueue before
    the RPC response that follows them, so the hub's post-replay handling is
    deterministic). On overflow the client is DISCONNECTED instead of
    ballooning memory: the hub reconnects and resumes exactly from its
    durable-log cursor (`subscribe {after_seq}`), so nothing is lost.
    """

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
        self._closed = False
        self._send_q: asyncio.Queue[bytes] = asyncio.Queue()
        self._q_bytes = 0
        # In-flight _handle_one tasks. Tracked so the EOF path can wait for
        # their answers (§14.75) — and so a detached task can't be garbage
        # collected mid-call, which asyncio allows for an unreferenced task.
        self._inflight: set[asyncio.Task[None]] = set()
        self._writer_task = asyncio.create_task(self._writer_loop())

    def send_json(self, obj: dict[str, Any]) -> None:
        """Enqueue a send (non-blocking, fire-and-forget, bounded)."""
        if self._closed:
            return
        try:
            line = (json.dumps(obj, default=str) + "\n").encode()
        except Exception:
            traceback.print_exc(file=sys.stderr)
            return
        if (self._send_q.qsize() >= SEND_QUEUE_MAX_EVENTS
                or self._q_bytes + len(line) > SEND_QUEUE_MAX_BYTES):
            print(
                f"[server] send-queue overflow ({self._send_q.qsize()} events,"
                f" {self._q_bytes} bytes) — dropping slow client",
                file=sys.stderr, flush=True,
            )
            self.shutdown()
            return
        self._q_bytes += len(line)
        self._send_q.put_nowait(line)

    async def _send_locked(self, obj: dict[str, Any]) -> None:
        """Kept for call-site compatibility (RPC responses/errors): now just
        enqueues on the same FIFO as events — ordering is the queue's."""
        self.send_json(obj)

    async def _writer_loop(self) -> None:
        try:
            while True:
                line = await self._send_q.get()
                # task_done() must fire for EVERY get, including the dropped
                # ones — flush_before_close() waits on _send_q.join(), which
                # would otherwise hang until its timeout (§14.75).
                try:
                    self._q_bytes -= len(line)
                    if self._closed:
                        continue  # drain silently
                    try:
                        self.writer.write(line)
                        await self.writer.drain()
                    except (ConnectionResetError, BrokenPipeError):
                        self._closed = True
                    except Exception:
                        traceback.print_exc(file=sys.stderr)
                finally:
                    self._send_q.task_done()
        except asyncio.CancelledError:
            pass

    async def flush_before_close(self) -> None:
        """Bounded best-effort flush once the reader hit EOF.

        `run()` dispatches every request as a DETACHED task, so at EOF the
        answers routinely exist only as pending tasks, or as queue entries the
        writer coroutine hasn't picked up yet. Both have to land before
        `_closed` is set (which makes `_writer_loop` drop silently) and before
        `_writer_task` is cancelled.

        Skipping this made every one-shot `--connect` client read an EMPTY
        stdout from a perfectly healthy daemon: the pipe's EOF reaches the
        reader in the same event-loop wakeup as the data, so `run()` breaks out
        before the dispatched tasks have run at all (§14.75).
        """
        if self._closed:
            return
        loop = asyncio.get_running_loop()
        deadline = loop.time() + EOF_FLUSH_GRACE_S
        try:
            if self._inflight:
                await asyncio.wait(set(self._inflight),
                                   timeout=max(0.0, deadline - loop.time()))
            remaining = deadline - loop.time()
            if remaining > 0:
                await asyncio.wait_for(self._send_q.join(), timeout=remaining)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Timeout, dead transport, handler blowup — all best-effort here.
            pass

    def shutdown(self) -> None:
        """Mark closed + close the transport; the reader loop exits on EOF
        and _handle_client runs the full cleanup."""
        self._closed = True
        try:
            self.writer.close()
        except Exception:
            pass

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
            # Dispatch async — detached on purpose (a slow RPC must not block
            # the next one), but TRACKED so EOF can wait for it (§14.75).
            task = asyncio.create_task(self._handle_one(req_id, method, params))
            self._inflight.add(task)
            task.add_done_callback(self._inflight.discard)

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
