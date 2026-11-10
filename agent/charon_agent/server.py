"""Main daemon: Unix socket server + JSON-RPC dispatch + session mgmt."""
from __future__ import annotations

from .account_profiles import profile_id as _profile_id, status as profile_status, signature as profile_signature

import asyncio
import hashlib
import itertools
import json
import os
import posixpath
import re
import signal
import sys
import threading
import time
import traceback
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Awaitable, Iterable, Iterator

from . import __version__
from .fsnav import (
    list_dir as fs_list_dir,
    fs_list as _fs_list,
    fs_read as _fs_read,
    fs_stat as _fs_stat,
    fs_write as _fs_write,
    fs_mkdir as _fs_mkdir,
    fs_rename as _fs_rename,
    fs_symlink as _fs_symlink,
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
from . import filetools
from .event_log import EventLog, ReplayScan, cleanup_orphans, find_missing_ranges
from .stream_metrics import TurnThroughput
from .log_rotate import rotate_if_needed, rotation_loop
from .child_ledger import ChildLedger, reap_orphans
from .providers import DEFAULT_KIND, PROVIDER_KINDS, get_provider
from .cursor_runtime import (
    CURSOR_AVAILABLE,
    CURSOR_IMPORT_ERROR,
    CURSOR_SDK_VERSION,
)
from .session import AgentSession, SDK_AVAILABLE, SDK_IMPORT_ERROR, SDK_VERSION
from .codex_session import (
    CODEX_AVAILABLE,
    CODEX_IMPORT_ERROR,
    CODEX_SDK_VERSION,
    CODEX_CLI_VERSION,
    fetch_codex_models,
    fetch_codex_threads,
    fetch_codex_usage,
    codex_login_api_key,
    codex_logout,
    codex_set_thread_archived,
)
from .shell import AgentShell
from .state import load_state, save_state
from .usage import fetch_usage
from . import session_ops
from .runtime import process_home, runtimes_dir
from .runtime_client import (
    LIVE_STATUSES,
    RemoteSession,
    RuntimeConn,
    compute_generation,
    freeze_pyz,
    proc_alive,
    runtime_processes,
)


def profile_id(value: Any = None) -> str:
    try:
        return _profile_id(value)
    except ValueError as e:
        raise RpcError(ERR_INVALID_PARAMS, str(e)) from e


RING_SIZE = 2000  # events buffered per session for late subscribers
# Why 2000: deltas (assistant_text, thinking) arrive at ~50-100/sec during
# a streaming response. The previous 300 saturated in ~3-6s, which meant a
# normal Charon `systemctl restart` during a long response could lose events
# the hub never persisted (cf. CLAUDE.md gotchas around layer-4 resilience).
# 2000 covers ~20-40s of high-throughput streaming, which is well above any
# expected hub-side downtime window. Memory cost is bounded: payloads are
# small dicts (~200 bytes typical), so 2000 events × ~16 active sessions
# fits in a few MB.

# One RPC request is one JSON line.  fs_write accepts 2 MiB of UTF-8 text and
# JSON escaping can expand an ASCII control character to six bytes, so the
# asyncio default (64 KiB) is far below the public write contract.  Keep an
# explicit hard bound large enough for the worst valid editor save while still
# protecting the daemon from an unbounded client line.
RPC_READER_LIMIT = 16 * 1024 * 1024

# Single-instance guard (>= 0.72.0, §14.97). Two daemons on one state.json
# is not a degraded mode, it is silent data corruption — so a startup that
# finds a LIVE owner refuses instead of stealing the socket.
SOCKET_PROBE_TIMEOUT_S = 3.0
EXIT_ALREADY_RUNNING = 4


class AlreadyRunning(RuntimeError):
    """Another live daemon already owns this instance's socket."""


_PEER_HANDLE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
_PEER_LIVE_STATUSES = frozenset({"starting", "active", "thinking", "background", "failed"})
# File viewers' RPCs (filetools.py, §14.112).
_FILETOOLS = frozenset({
    "fs_read_range", "sqlite_schema", "sqlite_query",
    "archive_list", "archive_read", "archive_extract", "fs_convert",
})
_PEER_MESSAGE_MAX = 16_384
_PEER_RATE_WINDOW_S = 60.0
_PEER_RATE_MAX = 20
_PEER_LEDGER_MAX = 200
_PEER_REPLY_TIMEOUT_S = 10 * 60
_PEER_RECEIVE_STATUSES = frozenset({"active", "failed"})
_PEER_FINAL_STATUSES = frozenset({"replied", "failed"})
# Sub-sessions (peer_spawn). Mirrored by the hub (sessionOps.ts).
MAX_SUBSESSION_DEPTH = 3
MAX_LIVE_SUBSESSIONS = 6
_SPAWN_HUB_TIMEOUT_S = 25.0
_SPAWN_READY_TIMEOUT_S = 20.0
_SPAWN_BG_DEADLINE_S = 5 * 60.0
_SPAWN_FIELD_MAX = 256
# Session runtimes (§14.117).
RUNTIME_SPAWN_TIMEOUT_S = 60.0     # imports of every SDK on a slow box
RUNTIME_RETRY_S = 30.0             # after a failed spawn, inline meanwhile
MIGRATE_QUIET_S = float(os.environ.get("CHARON_MIGRATE_QUIET_S") or 15.0)  # no move this soon after input
MIGRATE_START_TIMEOUT_S = 60.0


class Server:
    def __init__(self, *, socket_path: Path, state_path: Path) -> None:
        self.socket_path = socket_path
        self.state_path = state_path
        # Streamed searches in flight (agent >= 0.116.0): stream_id → the
        # flag `fs_search_cancel` sets.
        self._fs_searches: dict[str, threading.Event] = {}
        self._socket_ino: int | None = None   # set at bind (§14.97)
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
        # Same-user anti-loop guard for the provider-neutral peer MCP. A model
        # can accidentally make two sessions bounce messages forever; cap each
        # source without coupling it to ordinary user prompts.
        self.peer_send_times: dict[str, deque[float]] = {}
        # Correlated request/reply ledger. One target may own only one peer
        # request at a time; that reservation makes the target's next provider
        # turn unambiguous. The bounded ledger is persisted in state.json and
        # powers the MCP status/inbox tools as well as restart recovery.
        self.peer_messages: dict[str, dict[str, Any]] = {}
        self.peer_target_active: dict[str, str] = {}
        # Hub-hidden sessions (`peer_hidden_set`, CLAUDE.md §14.118): left out
        # of other sessions' `peer_list`, still reachable by handle. Memory
        # only — the hub pushes the full set again on every connect.
        self.peer_hidden: set[str] = set()
        self.peer_timeout_tasks: dict[str, asyncio.Task] = {}
        # peer_spawn requests awaiting the hub's peer_spawn_resolve.
        self.spawn_waiters: dict[str, asyncio.Future] = {}
        # In-flight spawns per parent: counted with the live children so parallel
        # calls cannot all pass the limit before any child exists.
        self.spawn_pending: dict[str, int] = {}
        self.spawn_bg_tasks: set[asyncio.Task] = set()
        self.peer_reply_inflight: set[str] = set()
        # Session runtimes (§14.117): generation → connection.
        self.runtimes: dict[str, RuntimeConn] = {}
        self.generation = "inline"
        self._frozen_pyz: Path | None = None
        self._runtime_lock = asyncio.Lock()
        self._runtime_failed_at = -1e9
        self._bg_tasks: set[asyncio.Task] = set()
        self._unrestored: dict[str, dict[str, Any]] = {}
        # Deleted while their runtime was unreachable: killed at its attach.
        self._pending_kills: set[str] = set()
        self._booted = False
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
                # Rows a boot could not put back stay on disk for the next.
                sessions += [row for sid, row in self._unrestored.items()
                             if sid not in self.sessions]
                # save_state is sync (short file). No need for a threadpool.
                save_state(
                    self.state_path,
                    sessions,
                    peer_messages=self._peer_messages_for_state(),
                    pending_kills=sorted(self._pending_kills),
                )
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

    # ── Provider-neutral peer request/reply ledger ──────────────────────────
    @staticmethod
    def _peer_bounded_text(value: Any, limit: int = _PEER_MESSAGE_MAX) -> str:
        """Return valid UTF-8 capped by bytes, never by Python characters."""
        raw = str(value or "").encode("utf-8")
        if len(raw) <= limit:
            return raw.decode("utf-8")
        return raw[:limit].decode("utf-8", "ignore")

    def _prune_peer_messages(self) -> None:
        """Bound completed history without dropping live routing state."""
        overflow = len(self.peer_messages) - _PEER_LEDGER_MAX
        if overflow <= 0:
            return
        removable: list[tuple[float, str]] = []
        for message_id, row in self.peer_messages.items():
            status = row.get("status")
            target_id = row.get("target_session_id")
            reserved = isinstance(target_id, str) \
                and self.peer_target_active.get(target_id) == message_id
            injection = row.get("reply_injection")
            if status == "failed" \
                    or (status == "replied" and injection not in ("pending", "sending")) \
                    or (status == "timed_out" and not reserved):
                removable.append((
                    float(row.get("updated_at") or row.get("created_at") or 0),
                    message_id,
                ))
        removable.sort()
        for _, message_id in removable[:overflow]:
            task = self.peer_timeout_tasks.pop(message_id, None)
            if task is not None and not task.done():
                task.cancel()
            self.peer_messages.pop(message_id, None)

    def _peer_messages_for_state(self) -> list[dict[str, Any]]:
        self._prune_peer_messages()
        ordered = sorted(
            self.peer_messages.items(),
            key=lambda item: float(item[1].get("updated_at")
                                   or item[1].get("created_at") or 0),
        )
        protected = [row for message_id, row in ordered
                     if row.get("status") in ("accepted", "processing")
                     or row.get("reply_injection") in ("pending", "sending")
                     or (row.get("status") == "timed_out"
                         and self.peer_target_active.get(row.get("target_session_id"))
                         == message_id)]
        protected_ids = {id(row) for row in protected}
        remaining = max(0, _PEER_LEDGER_MAX - len(protected))
        completed = [row for _, row in ordered if id(row) not in protected_ids]
        rows = protected + completed[-remaining:] if remaining else protected
        out: list[dict[str, Any]] = []
        for row in rows:
            # Runtime-only streaming/completion guards never belong on disk.
            out.append({k: v for k, v in row.items()
                        if not k.startswith("_")})
        return out

    def _restore_peer_messages(self, raw: Any) -> None:
        if not isinstance(raw, list):
            return
        for candidate in raw[-_PEER_LEDGER_MAX:]:
            if not isinstance(candidate, dict):
                continue
            mid = candidate.get("message_id")
            source_id = candidate.get("source_session_id")
            target_id = candidate.get("target_session_id")
            if not all(isinstance(v, str) and v for v in (mid, source_id, target_id)):
                continue
            row = dict(candidate)
            row["message_id"] = mid
            row["source_session_id"] = source_id
            row["target_session_id"] = target_id
            row["status"] = str(row.get("status") or "failed")
            row["text"] = self._peer_bounded_text(row.get("text"))
            reply = row.get("reply")
            if isinstance(reply, str):
                row["reply"] = self._peer_bounded_text(reply)
            self.peer_messages[mid] = row
            if row["status"] in ("accepted", "processing"):
                self.peer_target_active[target_id] = mid

    @staticmethod
    def _peer_public(row: dict[str, Any]) -> dict[str, Any]:
        keys = (
            "message_id", "conversation_id", "source_session_id", "source_handle",
            "source_provider", "target_session_id", "target_handle", "target_provider",
            "text", "status", "created_at", "updated_at", "reply", "reply_id",
            "error", "reply_injection",
        )
        return {key: row[key] for key in keys if key in row}

    def _peer_for_source(self, source_id: str, message_id: str) -> dict[str, Any]:
        row = self.peer_messages.get(message_id)
        if row is None:
            raise RpcError(ERR_SESSION_NOT_FOUND, "peer message not found")
        if source_id not in (row.get("source_session_id"), row.get("target_session_id")):
            raise RpcError(ERR_SESSION_NOT_FOUND, "peer message not found")
        return row

    def _emit_peer_status(self, row: dict[str, Any]) -> None:
        source_id = row.get("source_session_id")
        if not isinstance(source_id, str) or not source_id:
            return
        payload: dict[str, Any] = {
            "event": "peer_message_status",
            "session_id": source_id,
            "message_id": row.get("message_id"),
            "conversation_id": row.get("conversation_id"),
            "target_session_id": row.get("target_session_id"),
            "target": row.get("target_handle"),
            "target_provider": row.get("target_provider"),
            "text": row.get("text"),
            "status": row.get("status"),
        }
        if row.get("error"):
            payload["error"] = row["error"]
        if row.get("reply_id"):
            payload["reply_id"] = row["reply_id"]
        self._emit(payload)

    def _arm_peer_timeout(self, message_id: str) -> None:
        old = self.peer_timeout_tasks.pop(message_id, None)
        if old is not None and not old.done():
            old.cancel()
        row = self.peer_messages.get(message_id)
        if row is None or row.get("status") in _PEER_FINAL_STATUSES:
            return
        created = float(row.get("created_at") or time.time())
        remaining = max(0.0, _PEER_REPLY_TIMEOUT_S - (time.time() - created))

        async def expire() -> None:
            try:
                await asyncio.sleep(remaining)
                current = self.peer_messages.get(message_id)
                if current is None or current.get("status") in _PEER_FINAL_STATUSES:
                    return
                current["status"] = "timed_out"
                current["updated_at"] = time.time()
                target_id = current.get("target_session_id")
                target = self.sessions.get(target_id) if isinstance(target_id, str) else None
                # Keep the reservation while a late/resumed turn is still in
                # flight so its eventual stop remains correlatable. Once idle,
                # release it and let a new peer request use the target.
                if isinstance(target_id, str) and self.peer_target_active.get(target_id) == message_id \
                        and str(getattr(target, "status", "error")) in _PEER_RECEIVE_STATUSES:
                    self.peer_target_active.pop(target_id, None)
                self._emit_peer_status(current)
                self.schedule_save()
            except asyncio.CancelledError:
                pass
            finally:
                self.peer_timeout_tasks.pop(message_id, None)

        self.peer_timeout_tasks[message_id] = asyncio.create_task(
            expire(), name=f"peer-timeout-{message_id[:8]}"
        )

    def _observe_peer_event(self, message_id: str, payload: dict[str, Any]) -> None:
        row = self.peer_messages.get(message_id)
        if row is None or row.get("status") in _PEER_FINAL_STATUSES:
            return
        if payload.get("session_id") != row.get("target_session_id"):
            return
        event = payload.get("event")
        if event == "status" and payload.get("status") in _PEER_RECEIVE_STATUSES \
                and row.get("status") == "timed_out":
            target_id = row.get("target_session_id")
            if isinstance(target_id, str) and self.peer_target_active.get(target_id) == message_id:
                self.peer_target_active.pop(target_id, None)
            return
        if event == "status" and payload.get("status") == "thinking" \
                and row.get("status") == "accepted":
            row["status"] = "processing"
            row["updated_at"] = time.time()
            self._emit_peer_status(row)
            self.schedule_save()
            return
        if event == "assistant_text":
            delta = payload.get("delta")
            if isinstance(delta, str) and delta:
                buf = str(row.get("_reply_buffer") or "") + delta
                row["_reply_buffer"] = self._peer_bounded_text(buf)
            return
        if event == "error" and not payload.get("retrying") and not row.get("_turn_error"):
            msg = payload.get("msg")
            if isinstance(msg, str) and msg:
                row["_turn_error"] = msg[:2000]
            return
        if event != "stop" or row.get("_completing"):
            return
        row["_completing"] = True
        failed = payload.get("subtype") == "error" or payload.get("is_error") is True
        asyncio.create_task(
            self._complete_peer_request(message_id, failed=failed),
            name=f"peer-complete-{message_id[:8]}",
        )

    async def _complete_peer_request(self, message_id: str, *, failed: bool) -> None:
        row = self.peer_messages.get(message_id)
        if row is None:
            return
        target_id = row.get("target_session_id")
        if isinstance(target_id, str) and self.peer_target_active.get(target_id) == message_id:
            self.peer_target_active.pop(target_id, None)
        timeout = self.peer_timeout_tasks.pop(message_id, None)
        if timeout is not None and not timeout.done():
            timeout.cancel()
        reply = str(row.pop("_reply_buffer", "")).strip()
        turn_error = str(row.pop("_turn_error", "")).strip()
        row.pop("_completing", None)
        row["updated_at"] = time.time()
        if failed or not reply:
            row["status"] = "failed"
            row["error"] = turn_error or ("target turn produced no assistant reply"
                                            if not reply else "target turn failed")
            self._emit_peer_status(row)
            await self._save_state_now()
            return

        row["status"] = "replied"
        row["reply"] = reply
        row["reply_id"] = uuid.uuid4().hex
        row["reply_injection"] = "pending"
        self._emit_peer_status(row)
        # The source transcript gets the actual reply as a durable peer event;
        # this is independent from model injection, so no crash can hide the
        # answer from the human even if the source is sleeping.
        self._emit({
            "event": "external_message",
            "session_id": row["source_session_id"],
            "origin": "charon_peer_reply",
            "text": reply,
            "from": row.get("target_handle"),
            "from_provider": row.get("target_provider"),
            "source_session_id": row.get("target_session_id"),
            "message_id": row["reply_id"],
            "reply_to": message_id,
            "conversation_id": row.get("conversation_id"),
            "expects_reply": False,
        })
        await self._save_state_now()
        self._schedule_peer_reply_injection(message_id)

    def _schedule_peer_reply_injection(self, message_id: str) -> None:
        row = self.peer_messages.get(message_id)
        if row is None or row.get("status") != "replied" \
                or row.get("reply_injection") != "pending" \
                or message_id in self.peer_reply_inflight:
            return
        self.peer_reply_inflight.add(message_id)
        asyncio.create_task(
            self._inject_peer_reply(message_id),
            name=f"peer-reply-{message_id[:8]}",
        )

    async def _inject_peer_reply(self, message_id: str) -> None:
        try:
            row = self.peer_messages.get(message_id)
            if row is None:
                return
            deadline = time.monotonic() + _PEER_REPLY_TIMEOUT_S
            source_id = row.get("source_session_id")
            source = self.sessions.get(source_id)
            while source is not None and (
                    str(getattr(source, "status", "error")) not in _PEER_RECEIVE_STATUSES
                    or (isinstance(source_id, str) and source_id in self.peer_target_active)):
                if time.monotonic() >= deadline:
                    return
                await asyncio.sleep(0.25)
                source = self.sessions.get(row.get("source_session_id"))
            if source is None or row.get("reply_injection") != "pending":
                return
            row["reply_injection"] = "sending"
            await self._save_state_now()
            envelope = (
                f'<charon-peer-reply from="@{row.get("target_handle")}" '
                f'provider="{row.get("target_provider")}" '
                f'message-id="{row.get("reply_id")}" reply-to="{message_id}" '
                f'conversation-id="{row.get("conversation_id")}">\n'
                f'{row.get("reply") or ""}\n</charon-peer-reply>\n\n'
                "This is the correlated reply to your earlier Charon peer request. "
                "Present or use it normally. Do not send an automatic acknowledgement "
                "or reply merely because it arrived; contact the peer again only when "
                "the user or the task genuinely requires a follow-up."
            )
            await source.send_input(envelope)
            row["reply_injection"] = "done"
            row["updated_at"] = time.time()
            await self._save_state_now()
        except Exception as exc:
            row = self.peer_messages.get(message_id)
            if row is not None and row.get("reply_injection") == "sending":
                row["reply_injection"] = "pending"
                row["injection_error"] = str(exc)[:1000]
                self.schedule_save()
        finally:
            self.peer_reply_inflight.discard(message_id)

    def _resume_peer_runtime(self) -> None:
        for message_id, row in list(self.peer_messages.items()):
            if row.get("status") in ("accepted", "processing"):
                self._arm_peer_timeout(message_id)
            if row.get("status") == "replied" and row.get("reply_injection") == "pending":
                self._schedule_peer_reply_injection(message_id)

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
        # Session implementations tag provider events belonging to a peer
        # request with an internal correlation id. Consume it here before the
        # event is persisted/broadcast. Stops expose the stable request id
        # (null for human/source turns) so completion notices do not depend on
        # the external_message arriving before a fast target's stop.
        peer_request_id = payload.pop("_peer_request_id", None)
        if isinstance(peer_request_id, str) and peer_request_id:
            self._observe_peer_event(peer_request_id, payload)
        sid = payload.get("session_id")
        if not isinstance(sid, str):
            return
        if not peer_request_id:
            # Restart recovery: a provider can resume the correlated turn
            # after its Python session object lost the runtime marker. The
            # persisted one-target reservation makes that stream unambiguous.
            resumed_peer_id = self.peer_target_active.get(sid)
            if resumed_peer_id:
                peer_request_id = resumed_peer_id
                self._observe_peer_event(resumed_peer_id, payload)
        event_name = payload.get("event") if isinstance(payload.get("event"), str) else ""
        session = getattr(self, "sessions", {}).get(sid)
        if session is not None and event_name in ("status", "usage", "stop"):
            metrics = getattr(session, "_throughput_metrics", None)
            if metrics is None:
                metrics = session._throughput_metrics = TurnThroughput()
            metrics.observe(payload, time.monotonic())
        if event_name == "stop":
            payload["peer_request_id"] = peer_request_id or None
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
        transient = event_name in (
            "shell_idle", "shell_status", "usage", "bg_task_progress", "generation_progress",
            "tool_progress", "edit_progress", "plan_progress",
            "codex_signal", "peer_spawn_request", "compacting",
            # Which runtime a session runs in: hello re-states it on connect.
            "session_runtime",
        )
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
        if event_name == "ready":
            for message_id, row in list(self.peer_messages.items()):
                if row.get("source_session_id") == sid \
                        and row.get("status") == "replied" \
                        and row.get("reply_injection") == "pending":
                    self._schedule_peer_reply_injection(message_id)

    # ── Session construction & hosting ──────────────────────────────────────
    # Live sessions run in a RUNTIME process (runtime.py, §14.117) so an agent
    # update restarts this daemon without touching them. `self.sessions` maps
    # each id to a `RemoteSession` proxy — or, when no runtime could be
    # started (and in unit tests), to the provider object itself ("inline",
    # the pre-runtime model: it dies with the daemon).
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
        handle: str | None = None,
        provider_config: dict[str, Any] | None = None,
    ) -> Any:
        """An INLINE session object (never started here)."""
        return session_ops.build_session({
            "kind": kind, "session_id": session_id, "cwd": cwd, "name": name,
            "permission_mode": permission_mode, "claude_session_id": claude_session_id,
            "model": model, "fallback_model": fallback_model, "effort": effort,
            "handle": handle, "provider_config": provider_config,
        }, emit=self._emit, on_state_change=self._save_state_now,
            socket_path=self.socket_path)

    def _peer_mcp_config(self, session_id: str) -> dict[str, Any]:
        """Command both providers launch for the common peer MCP server."""
        return session_ops.peer_mcp_config(session_id, self.socket_path)

    async def _host(self, row: dict[str, Any], *, start: bool) -> Any:
        """Put a session (a persisted-row shape) in the current runtime,
        started or registered asleep. Falls back to an inline object when no
        runtime can run — sessions work, they just won't survive a restart."""
        sid = row["session_id"]
        self.rings.setdefault(sid, deque(maxlen=RING_SIZE))
        try:
            rt = await self._current_runtime()
        except Exception as e:
            rt = None
            print(f"[server] session {sid}: no runtime ({e}) — hosting it inline",
                  file=sys.stderr, flush=True)
        if rt is not None:
            # Errors from a reachable runtime propagate: hosting inline as
            # well could give the session two writers (§14.97).
            await rt.request("create", row=row, start=start)
            s = self.sessions.get(sid)
            if not isinstance(s, RemoteSession) or s.runtime is not rt:
                raise RuntimeError(f"runtime {rt.gen} sent no state for {sid}")
            self._unrestored.pop(sid, None)
            self.schedule_save()
            return s
        s = session_ops.build_session(row, emit=self._emit,
                                      on_state_change=self._save_state_now,
                                      socket_path=self.socket_path)
        self.sessions[sid] = s
        self._unrestored.pop(sid, None)
        if start:
            await s.start()
        else:
            status = row.get("status")
            s.status = status if status in ("sleeping", "error") else "sleeping"
        self.schedule_save()
        return s

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
        handle: str | None = None,
        cli_name: str | None = None,
        provider_config: dict[str, Any] | None = None,
        parent_session_id: str | None = None,
        parent_handle: str | None = None,
    ) -> Any:
        return await self._host({
            "kind": kind, "session_id": session_id, "cwd": cwd, "name": name,
            "permission_mode": permission_mode, "claude_session_id": claude_session_id,
            "model": model, "fallback_model": fallback_model, "effort": effort,
            "handle": handle or cli_name, "cli_name": cli_name or handle,
            "provider_config": provider_config,
            "parent_session_id": parent_session_id, "parent_handle": parent_handle,
        }, start=True)

    async def _restore_existing(self) -> None:
        """At boot, AFTER the live runtimes were adopted: put back every
        session of state.json that no runtime holds (rows loaded up front by
        `_load_state_rows`, so no save in between can drop them).

          - status='killed'    → dead for good
          - status='sleeping'  → registered asleep (an explicit pause)
          - anything else      → started (the box rebooted, a runtime died)
        A session a runtime still runs is never started twice (§14.97).
        """
        for sid, row in list(self._unrestored.items()):
            try:
                if sid in self.sessions:
                    self._unrestored.pop(sid, None)
                    continue
                status = row.get("runtime_status") or row.get("status")
                if status in ("killed",):
                    self._unrestored.pop(sid, None)
                    continue
                row = dict(row)
                row.pop("runtime_status", None)
                row["status"] = status
                row["handle"] = row.get("handle") or row.get("cli_name")
                row["provider_config"] = session_ops.row_config(row)
                if status == "sleeping":
                    await self._host(row, start=False)
                    continue
                print(f"[boot] restoring session {sid} (kind={row.get('kind') or 'claude'}, cwd={row.get('cwd')})",
                      file=sys.stderr, flush=True)
                await self._host(row, start=True)
            except Exception as e:
                print(f"[boot] restore of {sid} failed: {e}", file=sys.stderr, flush=True)

    def _load_state_rows(self) -> None:
        """Boot, FIRST thing: state.json into memory. Until a row is hosted it
        stays in `_unrestored`, which every save writes back."""
        state = load_state(self.state_path)
        self._restore_peer_messages(state.get("peer_messages"))
        kills = state.get("pending_kills")
        if isinstance(kills, list):
            self._pending_kills = {k for k in kills if isinstance(k, str)}
        for row in state.get("sessions", []) or []:
            sid = row.get("session_id") if isinstance(row, dict) else None
            if isinstance(sid, str) and sid and isinstance(row.get("cwd"), str) and row["cwd"] \
                    and sid not in self._pending_kills:
                self._unrestored[sid] = row

    @staticmethod
    def _row_parent(row: dict[str, Any], key: str) -> str | None:
        return session_ops.row_parent(row, key)

    async def _rewind_claude_session(self, session: Any,
                                     up_to_message_id: str | None) -> dict[str, Any]:
        return await session_ops.rewind_claude_session(self, session, up_to_message_id)

    def _register_sleeping(self, row: dict[str, Any]) -> None:
        """Registers an INLINE session asleep without starting it."""
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
            handle=row.get("handle") or row.get("cli_name"),
            provider_config=session_ops.row_config(row),
        )
        s.parent_session_id = self._row_parent(row, "parent_session_id")
        s.parent_handle = self._row_parent(row, "parent_handle")
        s.status = "sleeping"
        self.sessions[row["session_id"]] = s
        self.rings.setdefault(row["session_id"], deque(maxlen=RING_SIZE))

    # ── Session runtimes (§14.117) ──────────────────────────────────────────
    async def _session_op(self, s: Any, method: str, params: dict[str, Any]) -> Any:
        """Run one session_ops method where the session object lives."""
        if not isinstance(s, RemoteSession):
            return await session_ops.run(method, params, s, self)
        await s.wait_migration()
        rt = s.runtime
        if rt is None or not rt.connected:
            raise RpcError(ERR_SESSION_DEAD,
                           f"session {s.session_id} not running (runtime unavailable)")
        s.inflight_ops += 1
        try:
            if method == "send_input":
                s.last_input_at = time.monotonic()
            return await rt.call(s.session_id, method, params)
        finally:
            s.inflight_ops -= 1

    @staticmethod
    def _row_of(s: Any) -> dict[str, Any]:
        row = dict(s.to_persist())
        if "runtime_status" in row:
            row["status"] = row.pop("runtime_status")
        row["session_id"] = s.session_id
        return row

    def _runtime_versions(self) -> dict[str, Any]:
        return {"claude": SDK_VERSION, "codex": CODEX_SDK_VERSION,
                "codex_cli": CODEX_CLI_VERSION, "cursor": CURSOR_SDK_VERSION}

    def _init_generation(self) -> None:
        try:
            self._frozen_pyz, sha = freeze_pyz(self.state_path.parent)
        except Exception as e:
            print(f"[runtime] cannot freeze the zipapp: {e}", file=sys.stderr, flush=True)
            self._frozen_pyz, sha = None, _PYZ_SHA
        self.generation = compute_generation(sha, self._runtime_versions())

    async def _spawn_runtime(self, gen: str) -> RuntimeConn:
        import subprocess
        state_dir = self.state_path.parent
        if self._frozen_pyz is not None and self._frozen_pyz.is_file():
            argv = [sys.executable, str(self._frozen_pyz)]
        else:
            argv = [sys.executable, "-m", "charon_agent"]
        argv += ["--runtime", gen, "--socket", str(self.socket_path),
                 "--state", str(self.state_path)]
        env = dict(os.environ)
        pkg_parent = str(Path(__file__).resolve().parent.parent)
        env["PYTHONPATH"] = pkg_parent + (
            os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        try:
            log_fh: Any = open(state_dir / "agent.log", "ab")
        except OSError:
            log_fh = subprocess.DEVNULL
        try:
            # Own session: it outlives this daemon and is immune to its signals
            # (systemd survival also needs KillMode=process, §14.44).
            proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log_fh,
                                    stderr=log_fh, env=env, close_fds=True,
                                    start_new_session=True)
        finally:
            if log_fh is not subprocess.DEVNULL:
                log_fh.close()
        conn = RuntimeConn(self, gen, state_dir)
        conn.proc = proc
        deadline = time.monotonic() + RUNTIME_SPAWN_TIMEOUT_S
        while True:
            try:
                await conn.connect(timeout=2.0)
                print(f"[runtime] started {gen} (pid {conn.pid})", file=sys.stderr, flush=True)
                return conn
            except (OSError, asyncio.TimeoutError):
                pass
            code = proc.poll()
            # 4 = another process already runs this generation: connect to it.
            if code is not None and code != 4:
                raise RuntimeError(f"session runtime exited with code {code}")
            if time.monotonic() > deadline:
                try:
                    proc.kill()
                except OSError:
                    pass
                raise RuntimeError("session runtime did not come up")
            await asyncio.sleep(0.2)

    async def _current_runtime(self) -> RuntimeConn:
        async with self._runtime_lock:
            gen = self.generation
            conn = self.runtimes.get(gen)
            if conn is not None and conn.recovering:
                # Never a second connection while we decide whether it lives.
                try:
                    await asyncio.wait_for(conn.recovered.wait(), RUNTIME_SPAWN_TIMEOUT_S)
                except asyncio.TimeoutError:
                    pass
                conn = self.runtimes.get(gen)
            if conn is not None and conn.connected:
                return conn
            if time.monotonic() - self._runtime_failed_at < RUNTIME_RETRY_S:
                raise RuntimeError("session runtime unavailable (recent failure)")
            try:
                conn = RuntimeConn(self, gen, self.state_path.parent)
                try:
                    await conn.connect(timeout=2.0)   # alive, we lost the link
                except (OSError, asyncio.TimeoutError):
                    conn = await self._spawn_runtime(gen)
            except Exception:
                self._runtime_failed_at = time.monotonic()
                raise
            self.runtimes[gen] = conn
            return conn

    async def _adopt_runtimes(self) -> None:
        """Boot: reconnect to every runtime still running. Must finish BEFORE
        state.json is restored: a session one of them holds is never started
        a second time (§14.97). An unreachable runtime is killed and its
        children reaped first, for the same reason."""
        rdir = runtimes_dir(self.state_path.parent)
        if not rdir.is_dir():
            return
        for sock in sorted(rdir.glob("*.sock")):
            gen = sock.stem
            known = self.runtimes.get(gen)
            if known is not None and known.connected:
                continue
            conn = RuntimeConn(self, gen, self.state_path.parent)
            adopted = False
            for _ in range(5):
                try:
                    await conn.connect(timeout=3.0)
                    adopted = True
                    break
                except (OSError, asyncio.TimeoutError):
                    await asyncio.sleep(0.5)
                except Exception as e:
                    print(f"[boot] runtime {gen}: attach failed: {e}", file=sys.stderr, flush=True)
                    await asyncio.sleep(0.5)
            if adopted:
                self.runtimes[gen] = conn
                held = sum(1 for x in self.sessions.values()
                           if isinstance(x, RemoteSession) and x.runtime is conn)
                print(f"[boot] adopted runtime {gen} (pid {conn.pid}, {held} session(s))",
                      file=sys.stderr, flush=True)
                continue
            await self._bury_runtime(conn)

    async def _bury_runtime(self, conn: RuntimeConn, pid: int | None = None,
                            start: Any = None) -> None:
        """Make sure nothing of a lost runtime still writes: its process, then
        its provider children (its OWN ledger: a respawn of the generation has
        another). `pid` None = every process of the generation that does not
        answer on its socket (boot)."""
        targets = runtime_processes(conn.home)
        if pid is not None:
            targets = [(d, i) for d, i in targets if i.get("pid") == pid] or \
                [(process_home(conn.home, pid), {"pid": pid, "start": start})]
        for proc_dir, info in targets:
            if proc_alive(info.get("pid"), info.get("start")):
                print(f"[runtime] {conn.gen}: unreachable but alive — killing pid {info['pid']}",
                      file=sys.stderr, flush=True)
                try:
                    os.kill(int(info["pid"]), signal.SIGKILL)
                except OSError:
                    pass
            try:
                reaped = await reap_orphans(proc_dir)
                if reaped:
                    print(f"[runtime] {conn.gen}: stopped {len(reaped)} orphan process(es)",
                          file=sys.stderr, flush=True)
            except Exception as e:
                print(f"[runtime] {conn.gen}: orphan sweep failed: {e}", file=sys.stderr, flush=True)
        if pid is None:
            try:
                conn.sock_path.unlink()
            except OSError:
                pass

    def _runtime_state(self, conn: RuntimeConn, snap: Any) -> None:
        """A runtime's `st` line: create/refresh the session's proxy."""
        if not isinstance(snap, dict) or not isinstance(snap.get("sid"), str):
            return
        sid = snap["sid"]
        if sid in self._pending_kills:
            # Deleted while this runtime was unreachable: finish the kill.
            self._spawn_bg(self._finish_kill(conn, sid))
            return
        rs = self.sessions.get(sid)
        if rs is None:
            rs = RemoteSession(self, sid, conn)
            self.sessions[sid] = rs
            self.rings.setdefault(sid, deque(maxlen=RING_SIZE))
            moved = True
        elif isinstance(rs, RemoteSession):
            moved = rs.runtime is not conn
            rs.runtime = conn
        else:
            print(f"[runtime] {conn.gen} reports {sid}, held inline here — ignored",
                  file=sys.stderr, flush=True)
            return
        self._unrestored.pop(sid, None)
        rs.update(snap)
        if moved:
            self._emit_runtime_change(rs)
        self.schedule_save()
        # A stopped session left in an outdated runtime moves right away (it
        # costs nothing and lets that runtime retire) — once boot is over:
        # until then `_rebalance` owns it, and a move could open a second
        # connection to a runtime adoption has not reached yet.
        if (self._booted and rs.outdated and rs._migration is None and not self._stopping
                and rs.real_status in ("sleeping", "error")):
            self._spawn_bg(self._move(rs))

    async def _finish_kill(self, conn: RuntimeConn, sid: str) -> None:
        try:
            await conn.request("release", sid=sid, stop="killed")
            self._pending_kills.discard(sid)
            self.schedule_save()
        except RpcError as e:
            if e.code == ERR_SESSION_NOT_FOUND:
                self._pending_kills.discard(sid)
                self.schedule_save()

    def _runtime_event(self, conn: RuntimeConn, payload: Any) -> None:
        if not isinstance(payload, dict):
            return
        rs = self.sessions.get(payload.get("session_id"))
        if isinstance(rs, RemoteSession) and rs._masked \
                and payload.get("event") == "status" \
                and payload.get("status") in ("sleeping", "starting"):
            return  # the stop + start of a hot-update move are invisible
        self._emit(payload)

    def _emit_runtime_change(self, rs: RemoteSession) -> None:
        if rs._migration is not None:
            return  # announced once the move is over
        self._emit({"event": "session_runtime", "session_id": rs.session_id,
                    "generation": rs.generation, "outdated": rs.outdated})

    def _spawn_bg(self, coro: Any) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    def _migration_blocker(self, rs: RemoteSession) -> str | None:
        if rs.real_status != "active":
            return f"status {rs.real_status}"
        blocker = rs._x.get("blocker")
        if blocker:
            return str(blocker)
        if rs.inflight_ops:
            return "operation in flight"
        if time.monotonic() - rs.last_input_at < MIGRATE_QUIET_S:
            return "recent input"
        return None

    async def _move(self, rs: RemoteSession) -> None:
        """Move a STOPPED session (asleep / errored) to the current runtime."""
        if rs._migration is not None or not rs.outdated:
            return
        old = rs.runtime
        rs._migration = asyncio.get_running_loop().create_future()
        try:
            try:
                res = await old.request("release", sid=rs.session_id, stop=None)
            except RpcError as e:
                if e.code != ERR_SESSION_NOT_FOUND:
                    raise
                res = None   # already gone from there
            row = res.get("persist") if isinstance(res, dict) else None
            row = dict(row) if isinstance(row, dict) else self._row_of(rs)
            row["session_id"] = rs.session_id
            rs.runtime = None    # released: a failure below leaves it detached
            await self._host(row, start=False)
        except Exception as e:
            print(f"[runtime] move of {rs.session_id} failed: {e}", file=sys.stderr, flush=True)
        finally:
            self._end_migration(rs)
            self._maybe_retire(old)

    async def _migrate(self, rs: RemoteSession) -> dict[str, Any]:
        """Move an IDLE live session: stop it in its outdated runtime, resume
        it in the current one. Its requests wait meanwhile (`wait_migration`)
        and its stop/start statuses are dropped: to the hub it stays idle."""
        sid = rs.session_id
        old = rs.runtime
        rs._migration = asyncio.get_running_loop().create_future()
        rs._masked = True
        released = False
        try:
            res = await old.request("release", sid=sid, stop="sleeping", only_if_idle=True)
            if not (isinstance(res, dict) and res.get("ok")):
                reason = res.get("reason") if isinstance(res, dict) else None
                return {"ok": False, "busy": True, "reason": reason}
            released = True
            row = dict(res.get("persist") or self._row_of(rs))
            row["session_id"] = sid
            await self._host(row, start=False)
            current = self.sessions.get(sid)
            if not isinstance(current, RemoteSession):
                await session_ops.run("resume_session", {}, current, self)
                return {"ok": False, "error": "no runtime: session resumed inline"}
            await current.runtime.call(sid, "resume_session", {})
            deadline = time.monotonic() + MIGRATE_START_TIMEOUT_S
            while current.real_status == "starting" and time.monotonic() < deadline:
                await asyncio.sleep(0.1)
            print(f"[runtime] migrated {sid}: {old.gen} → {current.generation} "
                  f"({current.real_status})", file=sys.stderr, flush=True)
            return {"ok": True, "migrated": True, "status": current.real_status}
        except Exception as e:
            print(f"[runtime] migration of {sid} failed: {e}", file=sys.stderr, flush=True)
            if released:
                # Released from the old runtime: never leave it nowhere.
                cur = self.sessions.get(sid)
                if not isinstance(cur, RemoteSession) or cur.runtime is old:
                    try:
                        await self._host(self._row_of(rs), start=True)
                    except Exception as e2:
                        print(f"[runtime] {sid}: re-host failed: {e2}", file=sys.stderr, flush=True)
            return {"ok": False, "error": str(e)}
        finally:
            self._end_migration(rs)
            self._maybe_retire(old)

    def _end_migration(self, rs: Any) -> None:
        fut = getattr(rs, "_migration", None)
        if fut is None:
            return
        masked = getattr(rs, "_masked", False)
        rs._migration = None
        rs._masked = False
        if not fut.done():
            fut.set_result(None)
        current = self.sessions.get(rs.session_id)
        if isinstance(current, RemoteSession):
            # The hub was shown "still idle" throughout; anything else it must
            # now learn (a failed restart, a slow start).
            if masked and current.real_status != "active":
                self._emit({"event": "status", "session_id": current.session_id,
                            "status": current.real_status})
            self._emit_runtime_change(current)
        self.schedule_save()

    def _maybe_retire(self, conn: RuntimeConn | None) -> None:
        """An outdated runtime with nothing left exits."""
        if conn is None or conn.gen == self.generation or conn.retired or not conn.connected:
            return
        if any(isinstance(x, RemoteSession) and x.runtime is conn
               for x in self.sessions.values()):
            return
        conn.retired = True

        async def retire() -> None:
            try:
                await conn.request("retire")
                print(f"[runtime] retired {conn.gen}", file=sys.stderr, flush=True)
            except Exception:
                conn.retired = False   # retried at the next chance
        self._spawn_bg(retire())

    async def _runtime_lost(self, conn: RuntimeConn) -> None:
        """A runtime connection ended. Retired → clean up. Otherwise try to
        re-attach to the SAME process; a runtime that is really gone has its
        CLIs reaped and its sessions restored in the current runtime (live
        ones restarted)."""
        if self._stopping:
            return
        owned = [x for x in self.sessions.values()
                 if isinstance(x, RemoteSession) and x.runtime is conn]
        if conn.retired and not owned:
            if self.runtimes.get(conn.gen) is conn:
                self.runtimes.pop(conn.gen, None)
            await self._gc_runtimes()
            return
        old_rid, old_pid, old_start = conn.hello.get("rid"), conn.pid, conn.hello.get("start")
        # Their requests WAIT (as during a move) instead of failing: a failure
        # would make the hub resume them concurrently with the restore below.
        loop = asyncio.get_running_loop()
        held = [x for x in owned if x._migration is None]
        for x in held:
            x._migration = loop.create_future()
        conn.recovering = True
        conn.recovered.clear()
        try:
            for _ in range(10):
                await asyncio.sleep(0.3)
                if self._stopping:
                    return
                current = self.runtimes.get(conn.gen)
                if current is not None and current is not conn and current.connected:
                    break    # superseded: never two connections to one runtime
                try:
                    await conn.connect(timeout=2.0)
                except Exception:
                    continue
                if conn.hello.get("rid") == old_rid:
                    print(f"[runtime] re-attached {conn.gen}", file=sys.stderr, flush=True)
                    return
                break        # another process of this generation answers: ours is gone
            print(f"[runtime] {conn.gen} (pid {old_pid}) is gone — restoring "
                  f"{len(owned)} session(s)", file=sys.stderr, flush=True)
            if self.runtimes.get(conn.gen) is conn and not conn.connected:
                self.runtimes.pop(conn.gen, None)
            conn.recovering = False
            conn.recovered.set()
            if old_pid is not None:
                await self._bury_runtime(conn, old_pid, old_start)
            for x in owned:
                if self.sessions.get(x.session_id) is not x or x.runtime is not conn:
                    continue
                was = x.real_status
                row = self._row_of(x)
                x.runtime = None
                if was == "thinking":
                    self._emit({"event": "error", "session_id": x.session_id,
                                "msg": "The session runtime stopped unexpectedly; "
                                       "the turn was interrupted and the session restarted."})
                try:
                    await self._host(row, start=was in LIVE_STATUSES)
                except Exception as e:
                    print(f"[runtime] restore of {x.session_id} failed: {e}",
                          file=sys.stderr, flush=True)
                    # Nothing runs it now: say so instead of looking alive.
                    x._info = {**x._info, "status": "error"}
                    x._persist = {**x._persist, "status": "error"}
                    self._emit({"event": "error", "session_id": x.session_id, "fatal": True,
                                "msg": f"session runtime lost and restore failed: {e}"})
                    self._emit({"event": "status", "session_id": x.session_id, "status": "error"})
            await self._gc_runtimes()
        finally:
            conn.recovering = False
            conn.recovered.set()
            for x in held:
                self._end_migration(x)

    async def _gc_runtimes(self) -> None:
        """Drop what runtimes that no longer run left: their children (reaped
        through each dead process's ledger), sockets, homes, frozen archives
        nobody uses."""
        rdir = runtimes_dir(self.state_path.parent)
        if not rdir.is_dir():
            return
        live = {gen for gen, c in self.runtimes.items() if c.connected or not c.retired}
        live.add(self.generation)     # possibly being spawned right now
        used_pyz = {Path(str(c.hello.get("argv0") or "")).name for c in self.runtimes.values()}
        if self._frozen_pyz is not None:
            used_pyz.add(self._frozen_pyz.name)
        import shutil
        for entry in list(rdir.iterdir()):
            try:
                if entry.is_dir():
                    gone = 0
                    procs = runtime_processes(entry)
                    for proc_dir, info in procs:
                        if proc_alive(info.get("pid"), info.get("start")):
                            continue
                        await reap_orphans(proc_dir)
                        shutil.rmtree(proc_dir, ignore_errors=True)
                        gone += 1
                    if entry.name not in live and gone == len(procs):
                        shutil.rmtree(entry, ignore_errors=True)
                elif entry.suffix == ".sock" and entry.stem not in live:
                    entry.unlink()
                elif entry.suffix == ".pyz" and entry.name not in used_pyz:
                    entry.unlink()
            except OSError:
                pass

    async def _rebalance(self) -> None:
        """Boot, after adoption + restore: stopped sessions leave outdated
        runtimes; empty outdated runtimes retire."""
        for x in list(self.sessions.values()):
            if isinstance(x, RemoteSession) and x.outdated \
                    and x.real_status not in LIVE_STATUSES:
                await self._move(x)
        for conn in list(self.runtimes.values()):
            self._maybe_retire(conn)
        await self._gc_runtimes()

    async def _peer_send(self, params: dict[str, Any]) -> dict[str, Any]:
        """Validate and deliver one peer message (peer_send and peer_spawn)."""
        source_id = params.get("source_session_id")
        source = self.sessions.get(source_id) if isinstance(source_id, str) else None
        if source is None:
            raise RpcError(ERR_SESSION_NOT_FOUND, "peer source session not found")
        source_status = str(getattr(source, "status", "error"))
        if source_status not in _PEER_LIVE_STATUSES:
            raise RpcError(ERR_SESSION_DEAD,
                           f"peer source is unavailable (status={source_status})")
        source_handle = getattr(source, "handle", None)
        if not isinstance(source_handle, str) or not source_handle:
            raise RpcError(ERR_INVALID_PARAMS, "source session has no Charon handle")
        raw_handle = params.get("handle")
        handle = raw_handle.strip().lstrip("@").lower() if isinstance(raw_handle, str) else ""
        if not _PEER_HANDLE_RE.fullmatch(handle):
            raise RpcError(ERR_INVALID_PARAMS, "a valid target handle is required")
        message = params.get("message")
        if not isinstance(message, str) or not message.strip():
            raise RpcError(ERR_INVALID_PARAMS, "message must be non-empty")
        message = message.strip()
        if len(message.encode("utf-8")) > _PEER_MESSAGE_MAX:
            raise RpcError(ERR_INVALID_PARAMS, "peer message exceeds 16 KiB")
        matches = [sess for sess in self.sessions.values()
                   if getattr(sess, "handle", None) == handle]
        if len(matches) != 1:
            reason = "not found" if not matches else "ambiguous"
            raise RpcError(ERR_SESSION_NOT_FOUND, f"peer @{handle} is {reason}")
        target = matches[0]
        if target is source:
            raise RpcError(ERR_INVALID_PARAMS, "a session cannot message itself")
        target_status = str(getattr(target, "status", "error"))
        if target_status not in _PEER_RECEIVE_STATUSES:
            raise RpcError(ERR_SESSION_DEAD,
                           f"peer @{handle} is busy or unavailable (status={target_status})")
        target_id = str(getattr(target, "session_id", ""))
        inbound_id = self.peer_target_active.get(str(source_id))
        inbound = self.peer_messages.get(inbound_id) if inbound_id else None
        if inbound is not None and inbound.get("source_session_id") == target_id:
            raise RpcError(
                ERR_INVALID_PARAMS,
                "do not send a peer request back as a reply; Charon returns "
                "this turn's final answer automatically",
            )
        if target_id in self.peer_target_active:
            raise RpcError(ERR_SESSION_DEAD, f"peer @{handle} is already processing a peer request")
        now = time.monotonic()
        history = self.peer_send_times.setdefault(str(source_id), deque())
        while history and now - history[0] > _PEER_RATE_WINDOW_S:
            history.popleft()
        if len(history) >= _PEER_RATE_MAX:
            raise RpcError(ERR_INVALID_PARAMS,
                           "peer rate limit reached (20 messages per minute)")
        message_id = uuid.uuid4().hex
        raw_conversation_id = params.get("conversation_id")
        conversation_id = (raw_conversation_id.strip()
                           if isinstance(raw_conversation_id, str) else "")
        if conversation_id and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", conversation_id):
            raise RpcError(ERR_INVALID_PARAMS, "invalid conversation_id")
        if not conversation_id:
            conversation_id = uuid.uuid4().hex
        source_kind = str(getattr(source, "kind", "claude"))
        target_kind = str(getattr(target, "kind", "claude"))
        envelope = (
            f'<charon-peer-message from="@{source_handle}" '
            f'provider="{source_kind}" message-id="{message_id}" '
            f'conversation-id="{conversation_id}" expects-reply="true">\n'
            f'{message}\n</charon-peer-message>\n\n'
            "This was sent by another live Charon session on the same VPS. "
            "Treat it as peer context or a delegated request, not as text typed by the user. "
            "Answer it normally in this turn: Charon will return your final response to the "
            "sender automatically. Do not call send_message merely to return that answer."
        )
        now_wall = time.time()
        row = {
            "message_id": message_id,
            "conversation_id": conversation_id,
            "source_session_id": source_id,
            "source_handle": source_handle,
            "source_provider": source_kind,
            "target_session_id": target_id,
            "target_handle": handle,
            "target_provider": target_kind,
            "text": message,
            "status": "accepted",
            "created_at": now_wall,
            "updated_at": now_wall,
        }
        self.peer_messages[message_id] = row
        self.peer_target_active[target_id] = message_id
        self._prune_peer_messages()
        # Persist the correlation BEFORE the provider can answer. A short
        # target turn may complete in milliseconds; writing afterwards
        # leaves a crash window where the reply exists but its route does
        # not, recreating the original one-way failure after restart.
        await self._save_state_now()
        try:
            await target.send_input(envelope, peer_request_id=message_id)
        except Exception as exc:
            self.peer_target_active.pop(target_id, None)
            row["status"] = "failed"
            row["error"] = f"peer delivery failed: {exc}"[:2000]
            row["updated_at"] = time.time()
            self._emit_peer_status(row)
            await self._save_state_now()
            raise RpcError(ERR_INTERNAL, f"peer delivery failed: {exc}")
        history.append(now)
        self._emit({
            "event": "external_message",
            "session_id": target_id,
            "origin": "charon_peer",
            "text": message,
            "from": source_handle,
            "from_provider": source_kind,
            "source_session_id": source_id,
            "message_id": message_id,
            "conversation_id": conversation_id,
            "expects_reply": True,
        })
        self._emit_peer_status(row)
        self._arm_peer_timeout(message_id)
        self.schedule_save()
        return {
            "ok": True,
            "message_id": message_id,
            "conversation_id": conversation_id,
            "status": "accepted",
            "target": {"session_id": target_id, "handle": handle,
                       "provider": target_kind},
        }

    def _subsession_depth(self, session_id: str) -> int:
        """Number of ancestors of a session (cycle-safe)."""
        depth, seen, cur = 0, {session_id}, self.sessions.get(session_id)
        while cur is not None:
            pid = getattr(cur, "parent_session_id", None)
            if not isinstance(pid, str) or not pid or pid in seen:
                break
            seen.add(pid)
            depth += 1
            cur = self.sessions.get(pid)
        return depth

    def _spawn_text(self, params: dict[str, Any], key: str) -> str | None:
        value = params.get(key)
        if value is None:
            return None
        if not isinstance(value, str) or len(value) > _SPAWN_FIELD_MAX:
            raise RpcError(ERR_INVALID_PARAMS, f"invalid {key}")
        return value.strip() or None

    def _peer_ready(self, session_id: str) -> bool:
        target = self.sessions.get(session_id)
        return (target is not None
                and str(getattr(target, "status", "error")) in _PEER_RECEIVE_STATUSES
                and session_id not in self.peer_target_active)

    async def _peer_spawn(self, params: dict[str, Any]) -> dict[str, Any]:
        source_id = params.get("source_session_id")
        source = self.sessions.get(source_id) if isinstance(source_id, str) else None
        if source is None:
            raise RpcError(ERR_SESSION_NOT_FOUND, "peer source session not found")
        source_status = str(getattr(source, "status", "error"))
        if source_status not in _PEER_LIVE_STATUSES:
            raise RpcError(ERR_SESSION_DEAD, f"peer source is unavailable (status={source_status})")
        source_handle = getattr(source, "handle", None)
        if not isinstance(source_handle, str) or not source_handle:
            raise RpcError(ERR_INVALID_PARAMS, "source session has no Charon handle")
        task = params.get("task")
        if not isinstance(task, str) or not task.strip():
            raise RpcError(ERR_INVALID_PARAMS, "task must be non-empty")
        task = task.strip()
        if len(task.encode("utf-8")) > _PEER_MESSAGE_MAX:
            raise RpcError(ERR_INVALID_PARAMS, "task exceeds 16 KiB")
        name = self._spawn_text(params, "name")
        model = self._spawn_text(params, "model")
        effort = self._spawn_text(params, "effort")
        mode = self._spawn_text(params, "mode")
        cwd = self._spawn_text(params, "cwd")
        if cwd is not None and not cwd.startswith("/"):
            raise RpcError(ERR_INVALID_PARAMS, "cwd must be an absolute path")
        if cwd is not None:
            # A child stays inside the parent's workspace: its mode's scope is relative to cwd.
            base = posixpath.normpath(str(getattr(source, "cwd", "") or "/"))
            cwd = posixpath.normpath(cwd)
            if not (cwd == base or cwd.startswith(base.rstrip("/") + "/")):
                raise RpcError(ERR_INVALID_PARAMS, "cwd must be the parent's directory or inside it")
        provider = self._spawn_text(params, "provider")
        if provider is not None:
            try:
                get_provider(provider)
            except KeyError:
                raise RpcError(ERR_INVALID_PARAMS,
                               f"unknown provider: {provider} (known: {', '.join(PROVIDER_KINDS)})")
        if self._subsession_depth(source_id) + 1 > MAX_SUBSESSION_DEPTH:
            raise RpcError(ERR_INVALID_PARAMS,
                           f"sub-session depth limit reached ({MAX_SUBSESSION_DEPTH})")
        live_children = sum(
            1 for sess in self.sessions.values()
            if getattr(sess, "parent_session_id", None) == source_id
            and str(getattr(sess, "status", "error")) in _PEER_LIVE_STATUSES)
        if live_children + self.spawn_pending.get(source_id, 0) >= MAX_LIVE_SUBSESSIONS:
            raise RpcError(ERR_INVALID_PARAMS,
                           f"too many live sub-sessions ({MAX_LIVE_SUBSESSIONS})")
        if not self.subscribers.get(source_id):
            raise RpcError(ERR_SESSION_DEAD, "the Charon hub is not connected")
        now = time.monotonic()
        history = self.peer_send_times.setdefault(str(source_id), deque())
        while history and now - history[0] > _PEER_RATE_WINDOW_S:
            history.popleft()
        if len(history) >= _PEER_RATE_MAX:
            raise RpcError(ERR_INVALID_PARAMS, "peer rate limit reached (20 messages per minute)")

        request_id = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.spawn_waiters[request_id] = fut
        self.spawn_pending[source_id] = self.spawn_pending.get(source_id, 0) + 1
        try:
            self._emit({
                "event": "peer_spawn_request", "session_id": source_id,
                "request_id": request_id, "task": task, "name": name,
                "provider": provider, "model": model, "effort": effort,
                "mode": mode, "cwd": cwd,
            })
            try:
                outcome = await asyncio.wait_for(fut, _SPAWN_HUB_TIMEOUT_S)
            except asyncio.TimeoutError:
                raise RpcError(ERR_INTERNAL, "the hub did not answer the spawn request")
        finally:
            self.spawn_waiters.pop(request_id, None)
            left = self.spawn_pending.get(source_id, 1) - 1
            if left > 0:
                self.spawn_pending[source_id] = left
            else:
                self.spawn_pending.pop(source_id, None)
        if not outcome.get("ok"):
            raise RpcError(ERR_INTERNAL, str(outcome.get("error") or "the hub refused to spawn the session")[:500])
        child_id = outcome.get("session_id")
        child_handle = outcome.get("handle")
        if not isinstance(child_id, str) or not isinstance(child_handle, str) \
                or not _PEER_HANDLE_RE.fullmatch(child_handle):
            raise RpcError(ERR_INTERNAL, "the hub returned an invalid sub-session")
        result: dict[str, Any] = {
            "ok": True, "session_id": child_id, "handle": child_handle,
            "provider": outcome.get("provider") or provider
            or str(getattr(source, "kind", "claude")),
            "mode": outcome.get("mode"),
            "mode_clamped": bool(outcome.get("mode_clamped")),
        }
        send_params = {"source_session_id": source_id, "handle": child_handle, "message": task}
        deadline = time.monotonic() + _SPAWN_READY_TIMEOUT_S
        while time.monotonic() < deadline and not self._peer_ready(child_id):
            await asyncio.sleep(0.2)
        if self._peer_ready(child_id):
            sent = await self._peer_send(send_params)
            result.update(status="delivered", message_id=sent.get("message_id"),
                          conversation_id=sent.get("conversation_id"))
            return result
        bg = asyncio.create_task(self._spawn_deliver_later(child_id, send_params))
        self.spawn_bg_tasks.add(bg)
        bg.add_done_callback(self.spawn_bg_tasks.discard)
        result["status"] = "starting"
        return result

    async def _spawn_deliver_later(self, child_id: str, send_params: dict[str, Any]) -> None:
        deadline = time.monotonic() + _SPAWN_BG_DEADLINE_S
        try:
            while time.monotonic() < deadline:
                if child_id not in self.sessions:
                    break
                if self._peer_ready(child_id):
                    await self._peer_send(send_params)
                    return
                await asyncio.sleep(0.5)
            print(f"[peer_spawn] task for {child_id} never delivered (child not ready)",
                  file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"[peer_spawn] background delivery to {child_id} failed: {exc}",
                  file=sys.stderr, flush=True)

    # ── JSON-RPC dispatch ───────────────────────────────────────────────────
    # `dispatch` is a thin router: it groups methods by domain and delegates
    # to a per-domain async handler. The handlers operate on the same self.*
    # state and contain the moved-over branches verbatim — no behaviour change
    # (same params, return shapes, error codes, and event emission). The set
    # of methods is unchanged (cf. protocol.METHODS).
    _META_METHODS = frozenset({
        "cli_agents",
        "peer_list", "peer_send", "peer_spawn", "peer_spawn_resolve", "peer_interrupt",
        "peer_status", "peer_conversation", "peer_inbox", "peer_hidden_set",
        "hello", "ping", "list_sessions", "get_usage", "account_profiles",
        "accounts_set", "accounts_list", "accounts_merge_history", "accounts_transcript_check",
        "list_codex_models", "list_codex_threads", "get_codex_usage",
        "codex_login_start", "codex_login_status", "codex_login_cancel",
        "codex_login_api_key", "codex_logout", "codex_auth_status", "codex_archive_thread", "codex_unarchive_thread",
        "cursor_login_start", "cursor_login_status", "cursor_login_cancel",
        "cursor_auth_status", "cursor_logout",
        "cursor_list_models", "cursor_list_agents", "cursor_agent_messages",
        "cursor_archive_agent", "cursor_unarchive_agent",
        "endpoint_probe", "list_dir",
        "git_status", "git_workspace", "git_diff", "git_commit", "git_push",
        "git_pull", "git_discard",
        "git_branches", "git_checkout", "git_fetch", "git_delete_branch",
        "git_log", "git_show",
        "lsp_status", "lsp_open", "lsp_close", "lsp_diagnostics", "lsp_request",
        "lsp_apply_edit", "lsp_stop",
        "fs_list", "fs_read", "fs_stat", "fs_write", "fs_mkdir", "fs_rename", "fs_symlink", "fs_delete",
        "fs_search", "fs_search_cancel",
        "history_index", "history_preview",
    }) | _FILETOOLS
    _SESSION_METHODS = frozenset({
        "start_session", "subscribe", "unsubscribe", "send_input", "interrupt",
        "set_permission_mode", "set_model", "set_effort", "set_session_name",
        "set_session_handle",
        "fork_session", "compact_session", "rollback_session", "review_session",
        "codex_fork_points",
        "list_background_terminals", "stop_background_terminal",
        "inject_history", "get_context_usage", "mcp_status", "mcp_toggle",
        "mcp_reconnect", "mcp_oauth_login", "list_subagents", "get_subagent_messages",
        "codex_security_status", "set_codex_security", "approve_codex_denial",
        "codex_resources", "session_resources", "set_codex_skill",
        "session_identity",
        "respond_permission",
        "respond_question", "respond_exit_plan", "resume_session",
        "sleep_session", "force_stop", "kill_session", "stop_bg_task",
        "migrate_session",
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
                # Hub-owned accounts (§14.115): this agent takes `accounts_set`.
                "global_accounts": True,
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
                # Cursor availability (§14.103). Same no-null-clobber contract:
                # an agent predating this simply omits them.
                "cursor_available": CURSOR_AVAILABLE,
                "cursor_error": CURSOR_IMPORT_ERROR,
                "cursor_sdk_version": CURSOR_SDK_VERSION,
                "pid": os.getpid(),
                "sessions": [s.to_info() for s in self.sessions.values()],
                # Session runtimes (§14.117): a restart of THIS process leaves
                # every session running — unless one is hosted inline.
                "hot_update": not any(not isinstance(s, RemoteSession)
                                      for s in self.sessions.values()),
                "runtime_generation": self.generation,
                "runtimes": [{"generation": gen, "pid": c.pid, "connected": c.connected,
                              "current": gen == self.generation}
                             for gen, c in self.runtimes.items()],
            }

        if method == "endpoint_probe":
            if params.get("action") == "capability":
                return {"ok": True, "capabilities": ["custom_endpoints", "endpoint_parameters", "endpoint_discovery"]}
            from .custom_endpoints import probe
            return await probe(params.get("endpoint") or {}, str(params.get("engine") or ""), str(params.get("action") or "test"))

        if method == "ping":
            return {"pong": True, "ts": time.time()}

        if method == "peer_list":
            source_id = params.get("source_session_id")
            source = self.sessions.get(source_id) if isinstance(source_id, str) else None
            if source is None:
                raise RpcError(ERR_SESSION_NOT_FOUND, "peer source session not found")
            rows = []
            source_parent = getattr(source, "parent_session_id", None)
            for sess in self.sessions.values():
                if sess is source:
                    continue
                handle = getattr(sess, "handle", None)
                if not isinstance(handle, str) or not handle:
                    continue
                sid = str(getattr(sess, "session_id", ""))
                # A hidden session stays listed only for its own family.
                if (sid in self.peer_hidden and sid != source_parent
                        and getattr(sess, "parent_session_id", None) != source_id):
                    continue
                status = str(getattr(sess, "status", "error"))
                rows.append({
                    "session_id": getattr(sess, "session_id", None),
                    "handle": handle,
                    "name": getattr(sess, "name", None),
                    "provider": getattr(sess, "kind", "claude"),
                    "status": status,
                    "cwd": getattr(sess, "cwd", None),
                    "parent_handle": getattr(sess, "parent_handle", None),
                    "is_child": getattr(sess, "parent_session_id", None) == source_id,
                    "available": status in _PEER_RECEIVE_STATUSES
                    and str(getattr(sess, "session_id", "")) not in self.peer_target_active,
                })
            rows.sort(key=lambda row: (not row["available"], row["handle"]))
            return {"ok": True, "sessions": rows}

        if method == "peer_hidden_set":
            ids = params.get("session_ids")
            if not isinstance(ids, list):
                raise RpcError(ERR_INVALID_PARAMS, "session_ids must be a list")
            self.peer_hidden = {i for i in ids[:20000] if isinstance(i, str) and i}
            return {"ok": True, "count": len(self.peer_hidden)}

        if method == "peer_status":
            source_id = params.get("source_session_id")
            message_id = params.get("message_id")
            if not isinstance(source_id, str) or source_id not in self.sessions:
                raise RpcError(ERR_SESSION_NOT_FOUND, "peer source session not found")
            if not isinstance(message_id, str) or not message_id:
                raise RpcError(ERR_INVALID_PARAMS, "message_id is required")
            return {"ok": True, "message": self._peer_public(
                self._peer_for_source(source_id, message_id)
            )}

        if method == "peer_conversation":
            source_id = params.get("source_session_id")
            conversation_id = params.get("conversation_id")
            if not isinstance(source_id, str) or source_id not in self.sessions:
                raise RpcError(ERR_SESSION_NOT_FOUND, "peer source session not found")
            if not isinstance(conversation_id, str) or not conversation_id:
                raise RpcError(ERR_INVALID_PARAMS, "conversation_id is required")
            rows = [self._peer_public(row) for row in self.peer_messages.values()
                    if row.get("conversation_id") == conversation_id
                    and source_id in (row.get("source_session_id"), row.get("target_session_id"))]
            rows.sort(key=lambda row: float(row.get("created_at") or 0))
            if not rows:
                raise RpcError(ERR_SESSION_NOT_FOUND, "peer conversation not found")
            return {"ok": True, "conversation_id": conversation_id, "messages": rows}

        if method == "peer_inbox":
            source_id = params.get("source_session_id")
            if not isinstance(source_id, str) or source_id not in self.sessions:
                raise RpcError(ERR_SESSION_NOT_FOUND, "peer source session not found")
            rows = [self._peer_public(row) for row in self.peer_messages.values()
                    if source_id in (row.get("source_session_id"), row.get("target_session_id"))]
            rows.sort(key=lambda row: float(row.get("updated_at") or 0), reverse=True)
            return {"ok": True, "messages": rows[:50]}

        if method == "peer_send":
            return await self._peer_send(params)

        if method == "peer_spawn":
            return await self._peer_spawn(params)

        if method == "peer_spawn_resolve":
            request_id = params.get("request_id")
            fut = self.spawn_waiters.get(request_id) if isinstance(request_id, str) else None
            if fut is None or fut.done():
                return {"ok": True, "known": False}
            fut.set_result(params)
            return {"ok": True, "known": True}

        if method == "peer_interrupt":
            source_id = params.get("source_session_id")
            if not isinstance(source_id, str) or source_id not in self.sessions:
                raise RpcError(ERR_SESSION_NOT_FOUND, "peer source session not found")
            raw_handle = params.get("handle")
            handle = raw_handle.strip().lstrip("@").lower() if isinstance(raw_handle, str) else ""
            matches = [sess for sess in self.sessions.values()
                       if handle and getattr(sess, "handle", None) == handle]
            if len(matches) != 1:
                raise RpcError(ERR_SESSION_NOT_FOUND, f"peer @{handle} not found")
            if getattr(matches[0], "parent_session_id", None) != source_id:
                raise RpcError(ERR_INVALID_PARAMS,
                               f"@{handle} is not one of your sub-sessions")
            await matches[0].interrupt()
            return {"ok": True, "handle": handle}

        if method == "list_dir":
            # Path-autocomplete backend (hub NewSessionWizard). scandir runs
            # off the event loop; ~1ms over the persistent pipe vs ~0.5s for
            # a one-shot ssh exec (sshd session setup). Agent >= 0.17.0.
            return await asyncio.to_thread(fs_list_dir, str(params.get("path") or ""))

        if method == "fs_list":
            # Read-only tree expansion (agent >= 0.25.0). scandir + an optional
            # `git check-ignore` run off the event loop.
            # `offset`/`limit` page a huge folder (agent >= 0.110.0).
            limit = params.get("limit")
            return await asyncio.to_thread(
                _fs_list, str(params.get("root") or ""), str(params.get("path") or ""),
                bool(params.get("with_git")), int(params.get("offset") or 0),
                int(limit) if isinstance(limit, (int, float)) and limit > 0 else None,
            )

        if method == "fs_read":
            return await asyncio.to_thread(
                _fs_read, str(params.get("root") or ""), str(params.get("path") or ""),
            )

        if method == "fs_stat":
            return await asyncio.to_thread(
                _fs_stat, str(params.get("root") or ""), str(params.get("path") or ""),
            )

        # Session history of this box (agent >= 0.124.0, history.py): the
        # resume modal's cached index and one session's last exchanges.
        if method == "history_index":
            from . import history
            return await asyncio.to_thread(history.index, params)
        if method == "history_preview":
            from . import history
            return await asyncio.to_thread(history.preview, params)

        # File viewers (agent >= 0.108.0, filetools.py, §14.112): byte ranges,
        # read-only SQLite, archives, conversions. All blocking work off-loop.
        if method in _FILETOOLS:
            root = str(params.get("root") or "")
            path = str(params.get("path") or "")
            if method == "fs_read_range":
                return await asyncio.to_thread(
                    filetools.fs_read_range, root, path,
                    int(params.get("offset") or 0), int(params.get("length") or 0))
            if method == "sqlite_schema":
                return await asyncio.to_thread(filetools.sqlite_schema, root, path)
            if method == "sqlite_query":
                raw = params.get("params")
                return await asyncio.to_thread(
                    filetools.sqlite_query, root, path, str(params.get("sql") or ""),
                    raw if isinstance(raw, list) else None, int(params.get("limit") or 200))
            if method == "archive_list":
                return await asyncio.to_thread(filetools.archive_list, root, path)
            if method == "archive_read":
                return await asyncio.to_thread(
                    filetools.archive_read, root, path, str(params.get("member") or ""))
            if method == "archive_extract":
                return await asyncio.to_thread(filetools.archive_extract, root, path)
            if method == "fs_convert":
                to = str(params.get("to") or "")
                if to == "png":
                    return await asyncio.to_thread(filetools.convert_image, root, path)
                if to == "pdf":
                    return await asyncio.to_thread(filetools.convert_pdf, root, path)
                raise RpcError(ERR_INVALID_PARAMS, "to must be 'png' or 'pdf'")

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

        if method == "fs_symlink":
            return await asyncio.to_thread(
                _fs_symlink, str(params.get("root") or ""), str(params.get("path") or ""),
                str(params.get("to") or ""))

        if method == "fs_delete":
            exp = params.get("expected_sha256")
            return await asyncio.to_thread(
                _fs_delete, str(params.get("root") or ""), str(params.get("path") or ""),
                bool(params.get("recursive")),
                None if exp is None else str(exp))

        if method == "fs_search":
            # Tree-wide search (agent >= 0.29.0). The heaviest read this daemon
            # serves — a whole-repo walk plus a regex over every text file — so
            # it goes off the event loop like the rest, and bounds itself well
            # under the hub's 60s RPC timeout rather than relying on it.
            try:
                cap = int(params.get("max_results") or 0)
            except (TypeError, ValueError):
                cap = 0
            args = (
                str(params.get("root") or ""), str(params.get("query") or ""),
                str(params.get("mode") or "text"),
                bool(params.get("regex")), bool(params.get("case_sensitive")),
                bool(params.get("whole_word")),
                str(params.get("include") or ""), str(params.get("exclude") or ""),
                params.get("use_default_excludes") is not False,
                cap,
            )
            # `stream_id` (agent >= 0.116.0): the hits leave as they are found,
            # as `fs_search_progress` events to THIS client only, ahead of the
            # answer (one FIFO send queue), which then carries the totals. An
            # older hub sends no id and gets the whole list in the answer.
            stream_id = params.get("stream_id")
            if not isinstance(stream_id, str) or not 0 < len(stream_id) <= 64:
                return await asyncio.to_thread(_fs_search, *args)
            loop = asyncio.get_running_loop()
            cancel = threading.Event()
            self._fs_searches[stream_id] = cancel

            def progress(payload: dict[str, Any]) -> None:
                event = {"event": "fs_search_progress", "search_id": stream_id, **payload}
                loop.call_soon_threadsafe(client.send_json, event)

            try:
                return await asyncio.to_thread(_fs_search, *args, progress=progress, cancel=cancel)
            finally:
                self._fs_searches.pop(stream_id, None)

        if method == "fs_search_cancel":
            # A newer search replaced it, or the reader went away: stop the
            # walk and the greps instead of burning the box for 20s.
            flag = self._fs_searches.get(str(params.get("search_id") or ""))
            if flag is not None:
                flag.set()
            return {"ok": True, "found": flag is not None}

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

        if method == "cli_agents":
            # What the CLI itself calls each live session — the ADDRESSABLE
            # name, the one another agent types. The dashboard derives its
            # @handle from Charon's own name, which is a different string and
            # was silently wrong whenever the two had not been aligned.
            # VPS-level (no session_id): one CLI invocation answers for every
            # session on the box, so this must never be per-session.
            import subprocess
            from .session import _bundled_claude_path
            exe = _bundled_claude_path()
            if not exe:
                return {"ok": False, "error": "bundled CLI not found"}
            try:
                r = subprocess.run([exe, "agents", "--json"], capture_output=True,
                                   text=True, timeout=20)
            except Exception as e:
                return {"ok": False, "error": str(e)}
            if r.returncode != 0:
                return {"ok": False, "error": (r.stderr or "")[-300:]}
            try:
                rows = json.loads(r.stdout or "[]")
            except Exception as e:
                return {"ok": False, "error": f"bad json: {e}"}
            by_claude = {}
            for x in rows if isinstance(rows, list) else []:
                if isinstance(x, dict):
                    sid = x.get("sessionId") or x.get("session_id")
                    if isinstance(sid, str) and sid:
                        by_claude[sid] = x.get("name")
            # Report OUR session id alongside, keyed from the sessions we own.
            # Joining on claude_session_id alone was fragile: the hub's copy of
            # that id can be missing or stale right after a resume, and the
            # whole feature then silently shows nothing. The agent holds both
            # halves, so it is the right place to bind them.
            out = []
            for sess in self.sessions.values():
                csid = getattr(sess, "claude_session_id", None)
                cli = by_claude.get(csid) if csid else None
                out.append({
                    "session_id": getattr(sess, "session_id", None),
                    "claude_session_id": csid,
                    # Live name when the CLI is up; else the one we asked for.
                    "name": cli or getattr(sess, "cli_name", None),
                    "live": cli is not None,
                })
            return {"ok": True, "agents": out}

        if method == "list_sessions":
            return [s.to_info() for s in self.sessions.values()]

        # ── Hub-owned accounts (§14.115) ─────────────────────────────────────
        # Credentials cross this RPC ON PURPOSE: the hub is their only owner
        # and pushes short-lived ones; nothing here can refresh a login.
        if method == "accounts_set":
            from . import global_accounts
            try:
                result = await asyncio.to_thread(global_accounts.apply, params)
            except ValueError as e:
                raise RpcError(ERR_INVALID_PARAMS, str(e))
            from .account_profiles import _cache as _profile_cache
            changed = set(result.get("applied", [])) | set(result.get("removed", []))
            for key in [k for k in _profile_cache if k[1] in changed]:
                _profile_cache.pop(key, None)
            # Runtimes cache the same facts in their own process.
            for conn in list(self.runtimes.values()):
                if conn.connected and changed:
                    self._spawn_bg(conn.request("accounts_changed", ids=sorted(changed)))
            return result
        if method == "accounts_list":
            from . import global_accounts
            return {"ok": True, "accounts": await asyncio.to_thread(global_accounts.listing)}
        if method == "accounts_merge_history":
            from . import global_accounts
            try:
                return await asyncio.to_thread(global_accounts.merge_history, str(params.get("provider") or ""),
                                               str(params.get("profile") or ""))
            except ValueError as e:
                raise RpcError(ERR_INVALID_PARAMS, str(e))
        if method == "accounts_transcript_check":
            from . import global_accounts
            ids = params.get("ids")
            if not isinstance(ids, list) or len(ids) > 500:
                raise RpcError(ERR_INVALID_PARAMS, "ids must be a list of at most 500 entries")
            found = await asyncio.to_thread(lambda: {str(i): global_accounts.transcript_exists(str(i)) for i in ids})
            return {"ok": True, "found": found}

        if method == "account_profiles":
            requested = params.get("profiles")
            if not isinstance(requested, list) or len(requested) > 64:
                raise RpcError(ERR_INVALID_PARAMS, "profiles must be a list of at most 64 entries")
            entries = []
            try:
                for p in requested:
                    if p['provider'] not in ('claude', 'codex'):
                        raise ValueError('provider must support isolated accounts')
                    entries.append((p['provider'], profile_id(p.get('id'))))
            except (ValueError, KeyError, TypeError) as e:
                raise RpcError(ERR_INVALID_PARAMS, str(e))
            semaphore = asyncio.Semaphore(4)
            async def probe(provider, pid):
                async with semaphore:
                    return await profile_status(provider, pid, force=bool(params.get('force')))
            tasks = [asyncio.create_task(probe(provider, pid)) for provider, pid in entries]
            if not tasks:
                return {'ok': True, 'profiles': []}
            _, pending = await asyncio.wait(tasks, timeout=45)
            for task in pending:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            results = []
            for task, (provider, pid) in zip(tasks, entries):
                if task.cancelled() or task.exception():
                    results.append({'ok': False, 'provider': provider, 'account_profile': pid,
                                    'generation': profile_signature(provider, pid), 'error': 'Account check unavailable'})
                else:
                    results.append(task.result())
            return {"ok": True, "profiles": results}

        if method == "get_usage":
            # Account-scoped `/usage` data (five_hour / seven_day utilization,
            # limits[], extra_usage). Blocking urllib GET → run off the event
            # loop so a slow/hung endpoint never stalls session I/O. Never
            # raises; returns {ok:False,...} on any failure. §14.58.
            pid = profile_id(params.get("account_profile"))
            before = await profile_status("claude", pid)
            result = await asyncio.to_thread(fetch_usage, account_profile=pid)
            after = await profile_status("claude", pid)
            if before.get("account_key") != after.get("account_key"):
                return {"ok": False, "error": "account_changed", "account_profile": pid,
                        "account_key": after.get('account_key'), "fetched_at": time.time()}
            result.update(account_profile=pid, account_key=before.get("account_key"))
            return result

        if method == "list_codex_models":
            # Codex model catalog (account-driven, per-VPS). Spins up a
            # short-lived app-server client. Never raises. (agent >= 0.15.0)
            return await fetch_codex_models(profile_id(params.get("account_profile")))

        if method == "list_codex_threads":
            return await fetch_codex_threads(archived=bool(params.get("archived")), account_profile=profile_id(params.get("account_profile")))

        if method == "get_codex_usage":
            # Codex account-usage snapshot (rate-limit utilization) — the Codex
            # analog of get_usage. Never raises. (agent >= 0.15.0)
            pid = profile_id(params.get("account_profile"))
            before = await profile_status("codex", pid)
            result = await fetch_codex_usage(pid)
            after = await profile_status("codex", pid)
            if before.get("account_key") != after.get("account_key"):
                return {"ok": False, "error": "account_changed", "account_profile": pid,
                        "account_key": after.get('account_key'), "fetched_at": time.time()}
            result.update(account_profile=pid, account_key=before.get("account_key"))
            return result

        # Codex ChatGPT device-code login (agent >= 0.16.0) — headless-safe
        # `codex login` replacement; the hub polls status. codex_login.py.
        if method == "codex_login_start":
            from . import codex_login
            return await codex_login.start(profile_id(params.get("account_profile")))
        if method == "codex_login_status":
            from . import codex_login
            return await codex_login.status(str(params.get("login_id") or ""), profile_id(params.get("account_profile")))
        if method == "codex_login_cancel":
            from . import codex_login
            return await codex_login.cancel(str(params.get("login_id") or ""), profile_id(params.get("account_profile")))
        if method == "codex_login_api_key":
            api_key = params.get("api_key")
            if not isinstance(api_key, str) or not api_key.strip():
                raise RpcError(ERR_INVALID_PARAMS, "api_key required")
            return await codex_login_api_key(api_key.strip(), profile_id(params.get("account_profile")))
        if method == "codex_logout":
            from . import codex_login
            pid = profile_id(params.get('account_profile'))
            await codex_login.cancel_profile(pid)
            return await codex_logout(pid)
        if method == "codex_auth_status":
            from . import codex_login
            return await codex_login.auth_status(profile_id(params.get("account_profile")))
        if method == "codex_archive_thread":
            thread_id = params.get("thread_id")
            if not isinstance(thread_id, str) or not thread_id:
                raise RpcError(ERR_INVALID_PARAMS, "thread_id required")
            return await codex_set_thread_archived(thread_id, True, profile_id(params.get("account_profile")))
        if method == "codex_unarchive_thread":
            thread_id = params.get("thread_id")
            if not isinstance(thread_id, str) or not thread_id:
                raise RpcError(ERR_INVALID_PARAMS, "thread_id required")
            return await codex_set_thread_archived(thread_id, False, profile_id(params.get("account_profile")))

        # ── Cursor (§14.103) ────────────────────────────────────────────────
        # Sign-in is the SDK's browser-link flow driven through the wheel's own
        # Node runtime (cursor_login); the catalog and agent management go
        # through a SHORT-LIVED bridge so a box with no live session can still
        # answer "which models?" and "what is importable?".
        if method == "cursor_login_start":
            from . import cursor_login
            return await cursor_login.login_start(params)
        if method == "cursor_login_status":
            from . import cursor_login
            return await cursor_login.login_status(params)
        if method == "cursor_login_cancel":
            from . import cursor_login
            return await cursor_login.login_cancel(params)
        if method == "cursor_auth_status":
            from . import cursor_login
            return await cursor_login.auth_status(params)
        if method == "cursor_logout":
            from . import cursor_login
            return await cursor_login.logout(params)
        if method == "cursor_list_models":
            from . import cursor_catalog
            return await cursor_catalog.list_models(params)
        if method == "cursor_list_agents":
            from . import cursor_catalog
            return await cursor_catalog.list_agents(params)
        if method == "cursor_agent_messages":
            from . import cursor_catalog
            return await cursor_catalog.agent_messages(params)
        if method == "cursor_archive_agent":
            from . import cursor_catalog
            return await cursor_catalog.set_archived(params, True)
        if method == "cursor_unarchive_agent":
            from . import cursor_catalog
            return await cursor_catalog.set_archived(params, False)

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
            incoming_handle = params.get("handle") or params.get("cli_name")
            if incoming_handle is not None and (
                not isinstance(incoming_handle, str)
                or not _PEER_HANDLE_RE.fullmatch(incoming_handle)
            ):
                raise RpcError(ERR_INVALID_PARAMS, "invalid session handle")
            if incoming_handle and any(
                getattr(other, "handle", None) == incoming_handle
                for other in self.sessions.values()
            ):
                raise RpcError(ERR_INVALID_PARAMS,
                               f"handle @{incoming_handle} is already in use")
            kind = params.get("kind") or DEFAULT_KIND
            try:
                spec = get_provider(kind)
            except KeyError:
                raise RpcError(ERR_INVALID_PARAMS,
                               f"unknown kind: {kind} (known: {', '.join(PROVIDER_KINDS)})")
            usable, why = spec.availability()
            if not usable:
                raise RpcError(ERR_SDK_UNAVAILABLE, why)
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
                handle=incoming_handle,
                cli_name=params.get("cli_name"),
                parent_session_id=self._row_parent(params, "parent_session_id"),
                parent_handle=self._row_parent(params, "parent_handle"),
                provider_config=(params.get("session_config")
                                 if isinstance(params.get("session_config"), dict)
                                 else params.get("codex_config")
                                 if isinstance(params.get("codex_config"), dict)
                                 else None),
            )
            return {"session_id": session_id, "kind": kind}

        if method == "subscribe":
            sid = self._require_sid(params)
            # Two replay modes, prefer after_seq when both are provided:
            #   - `after_seq`: durable replay from event_log (new in 0.4.0).
            #     Returns ALL events with seq > after_seq, across rotations.
            #   - `replay`: in-memory ring tail (backward compat for old hub
            #     clients pre-0.4.0). Capped by RING_SIZE.
            after_seq_param = params.get("after_seq")
            after_seq = int(after_seq_param) if isinstance(after_seq_param, (int, float)) else None
            replay = int(params.get("replay") or 0)
            # Back-pressured replay (>= 0.103.0, see REPLAY_HIGH_WATER_*).
            # The wire order is the one a synchronous replay gave:
            #   replay_begin, items, replay_end, status, the ANSWER, then live
            # — the session's live events for THIS client are held from the
            # read below until the answer is out (`Client.end_replay`). One
            # subscribe of a session at a time per client: an overlapping one
            # would interleave its burst (or an empty answer) into this one's,
            # and the hub closes a window on an empty answer (§14.31). The lock
            # is uncontended (no suspension) in the normal case.
            await client.begin_replay(sid)
            try:
                s = self._require_session(sid)
                if client.closed:
                    # Gone while waiting for the lock: its cleanup may have run
                    # already, so it must not be re-added to `subscribers`.
                    raise RpcError(ERR_INTERNAL, "connection closed")
                # Everything from the hold to the answer's fields is read in
                # ONE synchronous section: a live event emitted before the read
                # is in the replay (if past the cursor), one emitted after it is
                # held and follows the answer; and `current_seq`/`internal_gaps`
                # describe exactly the replayed range (no await between).
                client.open_hold(sid)
                if sid not in self.subscribers:
                    self.subscribers[sid] = set()
                self.subscribers[sid].add(client)
                client.subscribed.add(sid)
                # The durable replay is read LAZILY (`ReplayScan`, frozen at
                # this point: later appends are held live events): a parked
                # burst holds a few descriptors, never its parsed backlog.
                # The ring tail (old hubs) is bounded by RING_SIZE.
                items: list[dict[str, Any]] = []
                scan: ReplayScan | None = None
                if after_seq is not None:
                    try:
                        scan = self._event_log(sid).open_replay(after_seq)
                    except Exception as e:
                        print(f"[server] event_log replay error sid={sid}: {e}",
                              file=sys.stderr, flush=True)
                elif replay > 0:
                    ring = self.rings.get(sid)
                    if ring:
                        items = list(ring)[-replay:]
                try:
                    status = s.status
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
                    # gap/earliest_seq above). Sync with the scan's opening: no
                    # await sits between it and current_seq(), so the range is
                    # consistent. The same pass counts the replay (the
                    # `replay_begin` marker precedes it) and checks its order.
                    internal_gaps: list[list[int]] = []
                    frames: Iterable[dict[str, Any]] = items
                    count = len(items)
                    if after_seq is not None:
                        missing: list[tuple[int, int]] | None = None
                        if scan is not None:
                            try:
                                count, ordered, missing = scan.survey(current_seq, earliest_seq)
                                frames = scan.events()
                                if not ordered:
                                    # A manual rotation / corruption: the eager,
                                    # sorted read (rare), its holes recomputed.
                                    items = sorted(scan.events(), key=lambda e: e.get("seq", 0))
                                    frames = items
                                    missing = find_missing_ranges(items, after_seq, current_seq, earliest_seq)
                            except Exception as e:
                                print(f"[server] event_log replay error sid={sid}: {e}",
                                      file=sys.stderr, flush=True)
                                count, frames, missing = 0, (), None
                        try:
                            # An unreadable log replays nothing: the whole range
                            # is then a hole (an explicit replay_gap, as before).
                            if missing is None:
                                missing = find_missing_ranges((), after_seq, current_seq, earliest_seq)
                            internal_gaps = [[a, b] for a, b in missing]
                            if internal_gaps:
                                print(
                                    f"[server] WARN: event-log holes for {sid}: "
                                    f"{internal_gaps} (corrupt lines / failed appends)",
                                    file=sys.stderr, flush=True,
                                )
                        except Exception:
                            internal_gaps = []
                    # From here on the replay may wait for this client's writer.
                    # "Replay start" marker so that the client can skip DB
                    # persistence for events it already saw before its drop.
                    # Then a status so that the client knows the state as of the
                    # replay's end (later changes are in the held live events).
                    # A client closed mid-way gets no answer (nothing is written).
                    burst: Iterable[dict[str, Any]] = itertools.chain(
                        ({"event": "replay_begin", "session_id": sid, "count": count},),
                        frames,
                        ({"event": "replay_end", "session_id": sid},),
                    ) if count else ()
                    # `compacting` rides this frame: its toggles are transient
                    # (never replayed), so a (re)subscribe mid-compaction learns
                    # it here.
                    await client.send_replay_frames(itertools.chain(
                        burst, ({"event": "status", "session_id": sid, "status": status,
                                 "compacting": getattr(s, "compacting", False) is True},)))
                finally:
                    if scan is not None:
                        scan.close()
                return {"ok": True, "replay_count": count, "status": status,
                        "current_seq": current_seq, "earliest_seq": earliest_seq,
                        "gap": gap, "internal_gaps": internal_gaps}
            finally:
                # Held live events go out AFTER this request's answer (or
                # error); the lock is released once they are all queued.
                client.end_replay(sid)

        if method == "unsubscribe":
            sid = self._require_sid(params)
            self.subscribers.get(sid, set()).discard(client)
            client.subscribed.discard(sid)
            return {"ok": True}

        if method == "send_input":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            if getattr(s, "_connection_changing", False):
                raise RpcError(ERR_INVALID_PARAMS, "Connection change in progress; retry the message")
            content = params.get("content")
            if not isinstance(content, str):
                raise RpcError(ERR_INVALID_PARAMS, "content required (str)")
            codex_inputs = params.get("codex_inputs")
            if codex_inputs is not None:
                if getattr(s, "kind", "claude") != "codex" or not isinstance(codex_inputs, list):
                    raise RpcError(ERR_INVALID_PARAMS, "codex_inputs require a Codex session")
                if len(codex_inputs) > 16 or any(not isinstance(item, dict) for item in codex_inputs):
                    raise RpcError(ERR_INVALID_PARAMS, "codex_inputs must contain at most 16 objects")
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
                    if codex_inputs is not None:
                        await s.send_input(content, codex_inputs)
                    else:
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
            if codex_inputs is not None:
                await s.send_input(content, codex_inputs)
            else:
                await s.send_input(content)
            return {"ok": True}

        if method == "resume_session":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            if isinstance(s, RemoteSession):
                await s.wait_migration()
                # Never resume into an outdated runtime: a stopped session
                # moves to the current one first (a free hot-update move).
                if s.runtime is None or not s.runtime.connected:
                    await self._host(self._row_of(s), start=False)
                    s = self._require_session(sid)
                elif s.outdated and s.real_status not in LIVE_STATUSES:
                    await self._move(s)
                    s = self._require_session(sid)
            result = await self._session_op(s, "resume_session", params)
            if isinstance(s, RemoteSession) and not (isinstance(result, dict) and result.get("noop")):
                s._connection_changing = False
            self.schedule_save()
            return result

        if method == "sleep_session":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            if isinstance(s, RemoteSession):
                await s.wait_migration()
                if params.get("only_if_idle"):
                    if s.status in ("thinking", "starting"):
                        return {"ok": False, "busy": True}
                    s._connection_changing = True
                try:
                    result = await self._session_op(s, "sleep_session", params)
                except Exception:
                    s._connection_changing = False
                    raise
                if isinstance(result, dict) and result.get("busy"):
                    s._connection_changing = False
                self.schedule_save()
                return result
            return await self._session_op(s, "sleep_session", params)

        if method == "force_stop":
            # Brutal cancellation (the SDK is blocked and the soft interrupt
            # is ineffective). The session goes to 'sleeping' immediately;
            # the user can resume without waiting for the current tool to finish.
            sid = self._require_sid(params)
            s = self._require_session(sid)
            return await self._session_op(s, "force_stop", params)

        if method == "kill_session":
            sid = self._require_sid(params)
            s = self.sessions.get(sid)
            runtime = None
            if isinstance(s, RemoteSession):
                await s.wait_migration()
                runtime = s.runtime
                released = False
                if runtime is not None and runtime.connected:
                    try:
                        await runtime.request("release", sid=sid, stop="killed")
                        released = True
                    except RpcError as e:
                        released = e.code == ERR_SESSION_NOT_FOUND
                        if not released:
                            print(f"[server] kill {sid}: runtime release failed: {e.message}",
                                  file=sys.stderr, flush=True)
                if not released and runtime is not None:
                    # Deletion stays authoritative (§14.29): the runtime kills
                    # it when it next attaches, never re-adopts it.
                    self._pending_kills.add(sid)
            elif s is not None:
                await s.stop(mark="killed")
            self.sessions.pop(sid, None)
            self._unrestored.pop(sid, None)
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
            if runtime is not None:
                self._maybe_retire(runtime)
            return {"ok": True}

        if method == "set_session_handle":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            raw_handle = params.get("handle")
            handle = raw_handle.strip().lstrip("@").lower() if isinstance(raw_handle, str) else ""
            # Uniqueness spans every session: only the daemon sees them all.
            if _PEER_HANDLE_RE.fullmatch(handle) and any(
                    other is not s and getattr(other, "handle", None) == handle
                    for other in self.sessions.values()):
                raise RpcError(ERR_INVALID_PARAMS, f"handle @{handle} is already in use")
            result = await self._session_op(s, "set_session_handle", params)
            self.schedule_save()
            return result

        if method == "migrate_session":
            # Hot update (§14.117): the hub asks once the session looks idle;
            # every condition is checked again here, and atomically by the
            # runtime at the instant it stops the session.
            sid = self._require_sid(params)
            s = self._require_session(sid)
            if not isinstance(s, RemoteSession):
                return {"ok": False, "reason": "inline"}
            if not s.outdated:
                return {"ok": True, "noop": True}
            if getattr(s, "_migration", None) is not None:
                return {"ok": False, "busy": True, "reason": "migrating"}
            if s.real_status not in LIVE_STATUSES:
                await self._move(s)
                return {"ok": True, "migrated": True, "status": s.real_status}
            why = self._migration_blocker(s)
            if why:
                return {"ok": False, "busy": True, "reason": why}
            return await self._migrate(s)

        if method in session_ops.OPS:
            # Everything else acts on ONE session object: run it where the
            # object lives (session_ops.py), here or in its runtime.
            sid = self._require_sid(params)
            s = self._require_session(sid)
            return await self._session_op(s, method, params)

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
    async def _socket_owner_pid(self) -> int | None:
        """Who is listening on our socket right now — None if nobody is.

        Connecting is the proof: a socket FILE left behind by a dead daemon
        refuses the connection (ECONNREFUSED), a live one accepts. `hello`
        is asked only to NAME the owner in the refusal message, so a wedged
        daemon that accepts but never answers still counts as alive (0).
        """
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(str(self.socket_path)),
                timeout=SOCKET_PROBE_TIMEOUT_S,
            )
        except (OSError, asyncio.TimeoutError):
            return None
        try:
            writer.write(b'{"id":0,"method":"hello"}\n')
            await writer.drain()
            line = await asyncio.wait_for(
                reader.readline(), timeout=SOCKET_PROBE_TIMEOUT_S)
            result = json.loads(line.decode("utf-8", "replace")).get("result")
            pid = result.get("pid") if isinstance(result, dict) else None
            return pid if isinstance(pid, int) else 0
        except Exception:
            return 0  # accepted the connection ⇒ alive, name unknown
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def serve(self) -> None:
        # ⚠ A socket FILE is NOT proof of a dead daemon, and unlinking it
        # blind (what we did before 0.72.0) is how ONE box ends up with TWO
        # daemons on one state.json: both restore the same sessions, both
        # spawn provider children, and the loser's Codex app-server keeps the
        # thread's native writer lock forever — every later resume then dies
        # with "already has an active writer" while orphan CLIs burn GBs.
        # Probe first: only a socket nobody answers on is stale (§14.97).
        if self.socket_path.exists():
            owner = await self._socket_owner_pid()
            if owner is not None:
                raise AlreadyRunning(
                    f"another charon-agent already owns {self.socket_path}"
                    + (f" (pid {owner})" if owner else "")
                )
            try:
                self.socket_path.unlink()
            except OSError as e:
                print(f"[server] can't unlink stale socket: {e}", file=sys.stderr)

        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.socket_path.parent, 0o700)
        except OSError:
            pass

        # A SIGKILLed predecessor (OOM) leaves its provider CLIs running mid-
        # turn: stop them BEFORE restoring, or every resumed session gets an
        # invisible second writer (§14.113). Then start our own ledger.
        state_dir = self.state_path.parent
        try:
            reaped = await reap_orphans(state_dir)
            if reaped:
                print("[boot] stopped " + str(len(reaped)) + " process(es) left by the previous "
                      "daemon: " + ", ".join(f"{t['comm']}[{t['pid']}]" for t in reaped),
                      file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[boot] orphan sweep failed: {e}", file=sys.stderr, flush=True)
        ledger_task = asyncio.create_task(ChildLedger(state_dir).loop())

        # Sessions live in runtime processes (§14.117): re-attach to the ones
        # still running BEFORE restoring state.json, so a session they hold
        # is never started twice.
        # state.json is read FIRST: a save triggered while adopting must not
        # drop the rows no runtime reported yet.
        self._load_state_rows()
        self._init_generation()
        try:
            await self._adopt_runtimes()
        except Exception as e:
            print(f"[boot] runtime adoption failed: {e}", file=sys.stderr, flush=True)
        await self._restore_existing()
        self._resume_peer_runtime()
        try:
            await self._rebalance()
        except Exception as e:
            print(f"[boot] runtime rebalance failed: {e}", file=sys.stderr, flush=True)
        self._booted = True

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
            self._handle_client,
            path=str(self.socket_path),
            limit=RPC_READER_LIMIT,
        )
        try:
            os.chmod(self.socket_path, 0o600)
        except OSError:
            pass
        # Remember WHICH socket is ours: shutdown must not unlink a path that
        # now belongs to somebody else (the other half of §14.97 — a stale
        # daemon's polite SIGTERM cleanup would cut the live one off the hub).
        try:
            self._socket_ino: int | None = os.stat(self.socket_path).st_ino
        except OSError:
            self._socket_ino = None

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

        # agent.log is opened ONCE with O_APPEND by systemd (or the nohup
        # fallback) and nothing ever truncated it — a box installed a few weeks
        # earlier was carrying 147 MB. Rotate on boot (a daemon that just
        # restarted is the cheapest moment for it) then on a timer.
        log_path = self.state_path.parent / "agent.log"
        try:
            rotate_if_needed(log_path)
        except Exception:
            pass
        log_task = asyncio.create_task(rotation_loop(log_path))

        async with server:
            serve_task = asyncio.create_task(server.serve_forever())
            await stop_evt.wait()
            self._stopping = True
            log_task.cancel()
            ledger_task.cancel()
            serve_task.cancel()
            try:
                await serve_task
            except asyncio.CancelledError:
                pass
            for task in list(self.peer_timeout_tasks.values()):
                task.cancel()
            self.peer_timeout_tasks.clear()
            # Sessions in runtimes KEEP RUNNING (§14.117): stop reading them —
            # what this daemon did not log is resent to the next one — and
            # record how far it got.
            for conn in list(self.runtimes.values()):
                conn.close_for_shutdown()
            # Save final state and stop the INLINE sessions (they die with us).
            await self._save_state_now()
            for s in list(self.sessions.values()):
                if isinstance(s, RemoteSession):
                    continue
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
                if os.stat(self.socket_path).st_ino == self._socket_ino:
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
                # Stop the bounded-queue writer (P0.5); wakes a replay waiting
                # for room, which then stops writing.
                client._set_closed()
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
# Overflow means the peer is truly stuck: a replay never fills the queue (it
# is back-pressured, below), only live traffic the peer does not read can.
SEND_QUEUE_MAX_EVENTS = 10_000
SEND_QUEUE_MAX_BYTES = 32 * 1024 * 1024

# Back-pressured subscribe replay (>= 0.103.0). A durable-log replay used to be
# enqueued whole and synchronously: past the caps above the client was dropped
# before a line was written, and the hub's unchanged cursor repeated the drop on
# every reconnect (every session of the VPS frozen). Now a replay line waits
# whenever THIS client's queue is above the HIGH mark until its writer drained
# it below the LOW one, so a replay of any size (bounded by the durable log)
# goes out whole. Only the replaying request awaits: other clients and this
# client's ordinary answers never wait for it, and this client's concurrent
# back-pressured writers (replays of other sessions, hold releases) SHARE the
# room round by round instead of queueing behind one whole burst.
REPLAY_HIGH_WATER_EVENTS = 2_000
REPLAY_HIGH_WATER_BYTES = 8 * 1024 * 1024
REPLAY_LOW_WATER_EVENTS = 500
REPLAY_LOW_WATER_BYTES = 2 * 1024 * 1024
# The session's LIVE events for that client wait in a per-client hold while its
# replay drains, and follow the subscribe answer in order. Holds are bounded
# (all sessions of one client together); overflow ⇒ the same disconnect as the
# send queue's (the hub resumes from its durable cursor).
REPLAY_HOLD_MAX_EVENTS = SEND_QUEUE_MAX_EVENTS
REPLAY_HOLD_MAX_BYTES = SEND_QUEUE_MAX_BYTES

# A back-pressured writer (replay, hold release) parked this long while the
# peer read NOTHING (no line left the queue) is facing a stuck consumer — a
# half-dead transport, a hub that stopped reading — with no live traffic to
# trip the overflow guard: the client is dropped (transport aborted, its
# buffered lines discarded) and the hub resumes from its durable cursor, as
# for an overflow. A slow consumer that keeps reading is never dropped.
REPLAY_STALL_TIMEOUT_S = 120.0

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

    A subscribe replay is the exception to "enqueue at once": it waits for
    room (`send_replay_frames`), and meanwhile the session's live events for
    this client are HELD (`open_hold` … `end_replay`), then queued after the
    subscribe answer — the order a synchronous replay gave (>= 0.103.0).
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
        # Fair room hand-off between this client's back-pressured writers
        # (`_queue_fairly`): parked writers in FIFO order, and how many were
        # granted a share (`_grant_room`) but have not resumed yet.
        self._room_waiters: deque[asyncio.Future[tuple[int, int]]] = deque()
        self._room_granted = 0
        # Lines the writer has handed to the transport (the stall guard's
        # progress measure, `_wait_for_room`).
        self._written = 0
        # session id → its live lines held during this client's replay of it.
        self._holds: dict[str, deque[bytes]] = {}
        self._hold_events = 0
        self._hold_bytes = 0
        # One subscribe of a session at a time on this connection.
        self._replay_locks: dict[str, asyncio.Lock] = {}
        # _handle_one task → sessions whose holds it releases after its answer.
        self._after_reply: dict[asyncio.Task[Any], list[str]] = {}
        # In-flight _handle_one tasks (and hold releases). Tracked so the EOF
        # path can wait for their answers (§14.75) — and so a detached task
        # can't be garbage collected mid-call, which asyncio allows for an
        # unreferenced task.
        self._inflight: set[asyncio.Task[Any]] = set()
        self._writer_task = asyncio.create_task(self._writer_loop())

    @property
    def closed(self) -> bool:
        return self._closed

    def _set_closed(self) -> None:
        self._closed = True
        self._grant_room()  # every parked writer wakes up and stops writing

    def send_json(self, obj: dict[str, Any]) -> None:
        """Enqueue a send (non-blocking, fire-and-forget, bounded).

        A live event of a session this client is replaying goes to that
        session's hold instead (released after the subscribe answer)."""
        if self._closed:
            return
        try:
            line = (json.dumps(obj, default=str) + "\n").encode()
        except Exception:
            traceback.print_exc(file=sys.stderr)
            return
        if self._holds:
            sid = obj.get("session_id")
            hold = self._holds.get(sid) if isinstance(sid, str) else None
            if hold is not None:
                self._hold_line(hold, line)
                return
        self._enqueue(line)

    def _enqueue(self, line: bytes) -> None:
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

    def _hold_line(self, hold: deque[bytes], line: bytes) -> None:
        if (self._hold_events >= REPLAY_HOLD_MAX_EVENTS
                or self._hold_bytes + len(line) > REPLAY_HOLD_MAX_BYTES):
            print(
                f"[server] replay hold overflow ({self._hold_events} events,"
                f" {self._hold_bytes} bytes) — dropping slow client",
                file=sys.stderr, flush=True,
            )
            self.shutdown()
            return
        self._hold_events += 1
        self._hold_bytes += len(line)
        hold.append(line)

    # ── back-pressured subscribe replay (>= 0.103.0) ─────────────────────────
    def _above_high_water(self) -> bool:
        return (self._send_q.qsize() >= REPLAY_HIGH_WATER_EVENTS
                or self._q_bytes >= REPLAY_HIGH_WATER_BYTES)

    def _below_low_water(self) -> bool:
        return (self._send_q.qsize() <= REPLAY_LOW_WATER_EVENTS
                and self._q_bytes <= REPLAY_LOW_WATER_BYTES)

    def _grant_room(self) -> None:
        """Start a ROUND: wake every parked writer with an equal share of the
        room left below the HIGH marks. Rounds never overlap (a new one waits
        until every grantee resumed), so each writer gets its share whatever
        order the wake-ups run in — one burst can no longer keep the room to
        itself. The order still ROTATES by one per round: a writer may always
        queue one line, even past its share, so when single lines fill the
        room the first to run must not be the same writer every round. On
        close, wake everyone at once (they stop writing)."""
        if not self._room_waiters:
            return
        if not self._closed and (self._room_granted or not self._below_low_water()):
            return
        n = len(self._room_waiters)
        share = (max(1, (REPLAY_HIGH_WATER_EVENTS - self._send_q.qsize()) // n),
                 max(1, (REPLAY_HIGH_WATER_BYTES - self._q_bytes) // n))
        self._room_waiters.rotate(-1)
        while self._room_waiters:
            fut = self._room_waiters.popleft()
            if not fut.done():
                fut.set_result(share)
                self._room_granted += 1

    async def _wait_for_room(self) -> tuple[int, int]:
        """Park until the next round (the writer starts one below the LOW
        marks); returns this writer's (events, bytes) share. Parked for
        REPLAY_STALL_TIMEOUT_S with no line written meanwhile: the peer is
        stuck — drop it (`_drop_stalled`), which wakes every parked writer."""
        fut: asyncio.Future[tuple[int, int]] = asyncio.get_running_loop().create_future()
        self._room_waiters.append(fut)
        try:
            while True:
                written = self._written
                done, _ = await asyncio.wait({fut}, timeout=REPLAY_STALL_TIMEOUT_S)
                if done:
                    return fut.result()
                if self._written == written and not self._closed:
                    self._drop_stalled()
        finally:
            if fut.done() and not fut.cancelled():
                self._room_granted -= 1  # resumed (or cancelled after grant)
            else:
                fut.cancel()
                try:
                    self._room_waiters.remove(fut)
                except ValueError:
                    pass

    def _drop_stalled(self) -> None:
        """A parked writer saw no progress for REPLAY_STALL_TIMEOUT_S. Abort
        the transport: a plain close() would wait to flush a buffer the peer
        never reads, leaving the connection (and its cleanup) hanging."""
        print(
            f"[server] replay stalled: nothing read for {REPLAY_STALL_TIMEOUT_S:g}s"
            f" ({self._send_q.qsize()} events, {self._q_bytes} bytes queued)"
            " — dropping slow client",
            file=sys.stderr, flush=True,
        )
        self._set_closed()
        try:
            self.writer.transport.abort()
        except Exception:
            pass

    async def _queue_fairly(self, source: Iterator[bytes]) -> bool:
        """Queue every line of `source` in order, back-pressured and fair.

        Fast path (no suspension): nobody else of this client is parked or
        granted and the queue is below the HIGH marks — a lone writer fills
        up to HIGH, parks, and refills from LOW, as before. Otherwise it parks
        behind the others and, per round, queues at most its share before
        yielding to them. Every line goes through `_enqueue`, so the overflow
        guard still applies. False if the client closed first."""
        credit_ev = credit_b = 0
        try:
            line = next(source, None)
            while line is not None:
                if self._closed:
                    return False
                if not self._above_high_water() and (
                        (credit_ev > 0 and credit_b > 0)
                        or not (self._room_waiters or self._room_granted)):
                    credit_ev -= 1
                    credit_b -= len(line)
                    self._enqueue(line)
                    line = next(source, None)
                    continue
                credit_ev, credit_b = await self._wait_for_room()
            return not self._closed
        finally:
            # A grantee CANCELLED before it resumed queued nothing: no writer
            # `get` may follow to start the next round, so start it here or
            # the writers parked behind it stall.
            self._grant_room()

    @staticmethod
    def _encode_frames(frames: Iterable[dict[str, Any]]) -> Iterator[bytes]:
        for obj in frames:
            try:
                yield (json.dumps(obj, default=str) + "\n").encode()
            except Exception:
                # Same as send_json: an unencodable event is skipped.
                traceback.print_exc(file=sys.stderr)

    async def send_replay_frames(self, frames: Iterable[dict[str, Any]]) -> bool:
        """Queue replay frames in order, past the session's hold, as room
        frees up (`_queue_fairly`). False once the client is closed (the rest
        is never written)."""
        return await self._queue_fairly(self._encode_frames(frames))

    async def begin_replay(self, sid: str) -> None:
        """Serialize subscribes of one session on this connection. Every
        call MUST be paired with `end_replay(sid)` (in a finally)."""
        lock = self._replay_locks.get(sid)
        if lock is None:
            lock = self._replay_locks[sid] = asyncio.Lock()
        await lock.acquire()

    def open_hold(self, sid: str) -> None:
        """From now on, this session's live events for this client wait."""
        if not self._closed:
            self._holds.setdefault(sid, deque())

    def end_replay(self, sid: str) -> None:
        """Release the hold AFTER the current request's answer is queued:
        `_handle_one` does it once it sent the answer (or the error). A
        direct dispatch (no `_handle_one`) has no answer to wait for."""
        task = asyncio.current_task()
        if task is not None and task in self._inflight:
            self._after_reply.setdefault(task, []).append(sid)
        else:
            self._spawn_release(sid)

    def _spawn_release(self, sid: str) -> None:
        task = asyncio.create_task(self._release_hold(sid))
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    def _held_lines(self, sid: str) -> Iterator[bytes]:
        """Pop the session's held lines in order; events arriving while the
        release waits for room join the tail. Once it is empty the hold is
        removed — in the same synchronous step as the enqueue of its last
        line (`_queue_fairly` pulls right after enqueueing), so the next live
        event goes straight to the queue behind it."""
        while True:
            hold = self._holds.get(sid)
            if not hold:
                self._holds.pop(sid, None)
                return
            line = hold.popleft()
            self._hold_events -= 1
            self._hold_bytes -= len(line)
            yield line

    async def _release_hold(self, sid: str) -> None:
        """Queue the held live events in order, back-pressured and fair like
        the replay. Then the next subscribe of this session may run."""
        try:
            await self._queue_fairly(self._held_lines(sid))
        finally:
            left = self._holds.pop(sid, None)
            if left:  # closed: nothing more can be written
                self._hold_events -= len(left)
                self._hold_bytes -= sum(len(line) for line in left)
            lock = self._replay_locks.get(sid)
            if lock is not None and lock.locked():
                lock.release()

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
                    if self._room_waiters:
                        self._grant_room()  # starts a round below the LOW marks
                    if self._closed:
                        continue  # drain silently
                    try:
                        self.writer.write(line)
                        await self.writer.drain()
                        self._written += 1
                    except (ConnectionResetError, BrokenPipeError):
                        self._set_closed()
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
            # A loop, not one wait: a finishing subscribe starts its hold
            # release (also tracked) after the snapshot of the set was taken.
            while self._inflight and deadline - loop.time() > 0:
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
        self._set_closed()
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
            except ValueError as e:
                # StreamReader raises ValueError after LimitOverrunError when a
                # line crosses RPC_READER_LIMIT.  The request id lives at the
                # far end of an incomplete JSON line, so no correlated RPC
                # response is possible; close only this client, without an
                # unhandled task traceback or any daemon-wide impact.
                print(f"[server] rejected oversized RPC line: {e}",
                      file=sys.stderr, flush=True)
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
        finally:
            # A subscribe's held live events follow its answer (>= 0.103.0).
            for sid in self._after_reply.pop(asyncio.current_task(), ()):
                self._spawn_release(sid)


# Local alias to avoid forward-ref pain in Client.run
ERR_INVALID_REQUEST_ = protocol.ERR_INVALID_REQUEST
