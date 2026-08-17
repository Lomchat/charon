"""Wrapper around the OpenAI Codex SDK (openai_codex) — one instance per session.

This is the Codex sibling of ``session.py``'s :class:`AgentSession`. It exposes
the SAME public + private contract that ``server.py`` drives (start / stop /
force_stop / send_input / interrupt / set_permission_mode / set_model /
set_effort / respond_* / to_info / to_persist, plus the ``_stopped`` /
``_ready_evt`` / ``_session_id_emitted`` / ``_main_task`` / ``_client`` attrs
that ``resume_session`` and ``set_model``/``set_effort`` poke directly), and
translates the Codex **app-server** notification stream into the exact SAME
Charon event vocabulary the hub already understands (status, assistant_text,
thinking, tool_use, tool_result, edit_snapshot, usage, stop,
error, interrupted, session_id, ready, mode_changed, model_changed,
effort_changed, effective_model, bg_task).

Transport model (differs from Claude, cf. CLAUDE.md §14.59):
  * The Python SDK (``openai_codex``) drives a local ``codex app-server`` over
    JSON-RPC. We use the ASYNC client (:class:`openai_codex.AsyncCodex`).
  * Codex is TURN-based: ``thread.turn(input)`` starts a turn and returns a
    handle; ``handle.stream()`` yields notifications until the turn completes
    (it breaks itself on ``TurnCompletedNotification``). We consume ONLY
    ``stream()`` — never ``.run()`` (which would open a second stream and
    deadlock). ``handle.interrupt()`` / ``handle.steer(input)`` control the
    live turn.
  * ``model`` / ``effort`` / ``sandbox`` / ``approval`` are per-turn overrides,
    so a mid-session change applies on the NEXT turn WITHOUT a sleep+resume
    (unlike Claude, whose model is bound at client construction — §14.35).

Permissions: the high-level SDK enum only exposes auto-review/deny-all, but the
SDK's typed client deliberately accepts an ``approval_handler`` and the modern
thread/turn params accept ``approvalsReviewer=user``.  We use those SDK
surfaces (not a second transport) and bridge the synchronous reader callback to
the agent's asyncio loop, so Codex shares Charon's durable permission/question
cards and session-scoped grants.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

try:
    from openai_codex import (
        AsyncCodex,
        CodexConfig,
        Sandbox,
        ApprovalMode,
    )
    from openai_codex.api import AsyncTurnHandle
    from openai_codex.generated.v2_all import ReasoningEffort as _CodexEffort
    try:
        from openai_codex.errors import TransportClosedError, is_retryable_error
    except Exception:  # old SDK: keep Codex available, just disable typed retry
        TransportClosedError = ()  # type: ignore
        is_retryable_error = lambda _exc: False  # type: ignore
    CODEX_AVAILABLE = True
    CODEX_IMPORT_ERROR: str | None = None
    try:
        import openai_codex as _codex_mod
        CODEX_SDK_VERSION: str | None = getattr(_codex_mod, "__version__", None)
        if not CODEX_SDK_VERSION:
            from importlib.metadata import version as _pkg_version
            CODEX_SDK_VERSION = _pkg_version("openai-codex")
    except Exception:  # pragma: no cover
        CODEX_SDK_VERSION = None
except Exception as e:  # pragma: no cover - depends on the remote venv
    AsyncCodex = None  # type: ignore
    CodexConfig = None  # type: ignore
    Sandbox = None  # type: ignore
    ApprovalMode = None  # type: ignore
    AsyncTurnHandle = None  # type: ignore
    _CodexEffort = None  # type: ignore
    TransportClosedError = ()  # type: ignore
    is_retryable_error = lambda _exc: False  # type: ignore
    CODEX_AVAILABLE = False
    CODEX_IMPORT_ERROR = f"{type(e).__name__}: {e}"
    CODEX_SDK_VERSION = None


EmitCallback = Callable[[dict[str, Any]], None]
StateSaveCallback = Callable[[], Awaitable[None] | None]


# ── Charon per-session "mode" → Codex sandbox + approval ─────────────────────
# A Charon "permission mode" for a Codex session picks a SANDBOX level. Human
# review is enabled independently through approvalsReviewer=user below.
#   read-only     → the agent can read/analyze but not modify or run mutating
#                   commands (sandbox read-only + deny escalations).
#   workspace-write→ (DEFAULT) read + write the workspace + run commands,
#                   escalations auto-reviewed.
#   full-access   → no sandbox restrictions (danger), escalations auto-reviewed.
CODEX_MODES = ("read-only", "workspace-write", "full-access")
DEFAULT_CODEX_MODE = "workspace-write"


def _mode_to_sandbox_approval(mode: str):
    """Return (Sandbox, ApprovalMode) for a Charon Codex mode string."""
    if mode == "read-only":
        return Sandbox.read_only, ApprovalMode.deny_all
    if mode == "full-access":
        return Sandbox.full_access, ApprovalMode.auto_review
    # workspace-write (default) + anything unknown
    return Sandbox.workspace_write, ApprovalMode.auto_review


def _sandbox_mode_wire(mode: str) -> str:
    if mode == "read-only":
        return "read-only"
    if mode == "full-access":
        return "danger-full-access"
    return "workspace-write"


def _sandbox_policy_wire(mode: str) -> dict[str, Any]:
    if mode == "read-only":
        return {"type": "readOnly"}
    if mode == "full-access":
        return {"type": "dangerFullAccess"}
    return {"type": "workspaceWrite"}


# These streams are unrelated to Charon's text chat and can be very large.
# Suppress them at initialize rather than receiving and discarding them.
CODEX_OPT_OUT_NOTIFICATIONS = (
    "externalAgentConfig/import/progress",
    "fuzzyFileSearch/sessionUpdated",
    "process/outputDelta",
    "remoteControl/status/changed",
    "thread/realtime/itemAdded",
    "thread/realtime/outputAudio/delta",
    "thread/realtime/sdp",
    "thread/realtime/transcript/delta",
)


def _coerce_effort(effort: str | None):
    """Return a ReasoningEffort enum for `effort`, or None if unset/unknown.

    The catalog exposes efforts per-model (none/minimal/low/medium/high/xhigh/
    max/ultra). We attempt to build the enum; unknown values fall through to
    None (SDK picks the model default) rather than raising.
    """
    if not effort or _CodexEffort is None:
        return None
    try:
        return _CodexEffort(effort)
    except Exception:
        # The enum in this SDK build may not carry every value the catalog
        # advertises (e.g. max/ultra on newer models). Pass the raw string —
        # the SDK's pydantic params coerce it; if that also fails the turn
        # wrapper drops it.
        return effort


def _external_codex_bin() -> str | None:
    """Return the fleet-managed CLI when it exists beside the shared venv.

    The Python SDK currently trails the standalone CLI. Charon keeps the SDK
    as process/router owner while pointing ``CodexConfig.codex_bin`` at the
    newer app-server installed under that same shared venv.
    """
    override = os.environ.get("CHARON_CODEX_BIN", "").strip()
    candidates = [override] if override else []
    cli_root = Path(sys.prefix) / "codex-cli"
    # The native binary needs no Node runtime and is therefore the fleet
    # default. Keep the npm wrapper as a compatibility fallback for boxes
    # updated by agent 0.55.0.
    candidates.extend([
        str(cli_root / "bin" / "codex"),
        str(cli_root / "node_modules" / ".bin" / "codex"),
    ])
    for candidate in candidates:
        if not candidate or not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
            continue
        try:
            # npm can install a platform package successfully even when its
            # Node/runtime requirements make the launcher unusable. Never
            # replace the SDK-bundled fallback until the binary itself starts.
            probe = subprocess.run(
                [candidate, "--version"], capture_output=True, text=True,
                timeout=5.0, check=False,
            )
            if probe.returncode == 0:
                return candidate
        except Exception:
            continue
    return None


CODEX_CLI_BIN = _external_codex_bin() if CODEX_AVAILABLE else None


def _codex_cli_version() -> str | None:
    """Best-effort version of the CLI that sessions actually execute."""
    if CODEX_CLI_BIN:
        try:
            proc = subprocess.run(
                [CODEX_CLI_BIN, "--version"], capture_output=True, text=True,
                timeout=5.0, check=False,
            )
            match = re.search(r"(?:codex-cli\s+)?([0-9]+(?:\.[0-9A-Za-z-]+)+)", proc.stdout)
            if match:
                return match.group(1)
        except Exception:
            pass
    try:
        from importlib.metadata import version as _pkg_version
        return _pkg_version("openai-codex-cli-bin")
    except Exception:
        return None


CODEX_CLI_VERSION = _codex_cli_version() if CODEX_AVAILABLE else None


def make_codex_config(**kwargs: Any):
    """Build a config that prefers the independently managed CLI."""
    if CODEX_CLI_BIN and not kwargs.get("codex_bin"):
        kwargs["codex_bin"] = CODEX_CLI_BIN
    return CodexConfig(**kwargs)


def _enum_val(v: Any) -> Any:
    return getattr(v, "value", v)


def _json_value(v: Any) -> Any:
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    dump = getattr(v, "model_dump", None)
    if callable(dump):
        try:
            return dump(mode="json", by_alias=True)
        except Exception:
            pass
    root = getattr(v, "root", None)
    if root is not None:
        return _json_value(root)
    return _enum_val(v)


def _path_string(v: Any) -> str | None:
    raw = getattr(v, "root", v)
    return str(raw) if raw is not None else None


def _thread_inject_response_model():
    """Resolve lazily so an older SDK can still run ordinary Codex sessions;
    only the cross-provider fork reports that its newer primitive is missing."""
    try:
        from openai_codex.generated.v2_all import ThreadInjectItemsResponse
        return ThreadInjectItemsResponse
    except Exception as e:
        raise RuntimeError(
            "the installed openai-codex SDK does not support thread/inject_items"
        ) from e


async def fetch_codex_models() -> dict[str, Any]:
    """List the Codex model catalog (account-driven, per-VPS). Spins up a
    short-lived app-server client. Never raises."""
    if not CODEX_AVAILABLE:
        return {"ok": False, "error": CODEX_IMPORT_ERROR or "codex unavailable"}
    client = None
    try:
        client = AsyncCodex(make_codex_config())
        resp = await client.models(include_hidden=False)
        raw = getattr(resp, "data", None)
        if raw is None:
            raw = getattr(resp, "models", None) or []
        models: list[dict[str, Any]] = []
        for m in raw:
            efforts = []
            for e in (getattr(m, "supported_reasoning_efforts", None) or []):
                efforts.append(_enum_val(getattr(e, "reasoning_effort", e)))
            models.append({
                "id": getattr(m, "id", None) or getattr(m, "model", None),
                "display_name": getattr(m, "display_name", None),
                "description": getattr(m, "description", None),
                "is_default": bool(getattr(m, "is_default", False)),
                "hidden": bool(getattr(m, "hidden", False)),
                "default_effort": _enum_val(getattr(m, "default_reasoning_effort", None)),
                "efforts": [e for e in efforts if e],
                "supports_personality": bool(getattr(m, "supports_personality", False)),
            })
        return {"ok": True, "models": models,
                "sdk_version": CODEX_SDK_VERSION, "cli_version": CODEX_CLI_VERSION}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        if client is not None:
            try:
                res = client.close()
                if asyncio.iscoroutine(res):
                    await asyncio.wait_for(res, timeout=5.0)
            except Exception:
                pass


async def fetch_codex_threads(*, archived: bool = False) -> dict[str, Any]:
    """List resumable top-level Codex threads through the supported SDK.

    The disk scanner remains a hub fallback for old/offline agents, but the
    SDK is authoritative for persistent names, source kind and runtime status.
    """
    if not CODEX_AVAILABLE:
        return {"ok": False, "error": CODEX_IMPORT_ERROR or "codex unavailable"}
    client = None
    try:
        from openai_codex.generated.v2_all import (
            SortDirection, ThreadSortKey, ThreadSourceKind,
        )
        client = AsyncCodex(make_codex_config())
        cursor = None
        rows: list[dict[str, Any]] = []
        source_kinds = [
            ThreadSourceKind.cli, ThreadSourceKind.vscode,
            ThreadSourceKind.exec, ThreadSourceKind.app_server,
            ThreadSourceKind.unknown,
        ]
        while len(rows) < 400:
            page = await client.thread_list(
                archived=archived, cursor=cursor, limit=min(100, 400 - len(rows)),
                source_kinds=source_kinds,
                sort_key=ThreadSortKey.updated_at,
                sort_direction=SortDirection.desc,
            )
            for thread in getattr(page, "data", None) or []:
                # Defensive against a future source taxonomy change: parent id
                # is a second, structural sub-agent marker.
                if getattr(thread, "parent_thread_id", None):
                    continue
                cwd = _path_string(getattr(thread, "cwd", None)) or ""
                preview = str(getattr(thread, "preview", None) or "")[:400]
                git = getattr(thread, "git_info", None)
                status = getattr(thread, "status", None)
                rows.append({
                    "sessionId": str(getattr(thread, "id", "")),
                    "cwd": cwd,
                    "aiTitle": str(getattr(thread, "name", None) or ""),
                    "firstUserText": preview[:300],
                    "lastPrompt": preview,
                    "messageCount": 0,
                    "model": "",
                    "effort": "",
                    "gitBranch": str(getattr(git, "branch", None) or ""),
                    "mtime": int(getattr(thread, "updated_at", None) or 0),
                    "size": 0,
                    "status": _json_value(status),
                    "source": _json_value(getattr(thread, "source", None)),
                    "archived": archived,
                })
            cursor = getattr(page, "next_cursor", None)
            if not cursor:
                break
        return {"ok": True, "sessions": rows}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        if client is not None:
            try:
                await asyncio.wait_for(client.close(), timeout=5.0)
            except Exception:
                pass


async def codex_login_api_key(api_key: str) -> dict[str, Any]:
    if not CODEX_AVAILABLE:
        return {"ok": False, "error": CODEX_IMPORT_ERROR or "codex unavailable"}
    client = None
    try:
        client = AsyncCodex(make_codex_config())
        await client.login_api_key(api_key)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        if client is not None:
            try:
                await asyncio.wait_for(client.close(), timeout=5.0)
            except Exception:
                pass


async def codex_logout() -> dict[str, Any]:
    if not CODEX_AVAILABLE:
        return {"ok": False, "error": CODEX_IMPORT_ERROR or "codex unavailable"}
    client = None
    try:
        client = AsyncCodex(make_codex_config())
        await client.logout()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        if client is not None:
            try:
                await asyncio.wait_for(client.close(), timeout=5.0)
            except Exception:
                pass


async def codex_set_thread_archived(thread_id: str, archived: bool) -> dict[str, Any]:
    """Archive/unarchive one persisted thread through the supported SDK."""
    if not CODEX_AVAILABLE:
        return {"ok": False, "error": CODEX_IMPORT_ERROR or "codex unavailable"}
    client = None
    try:
        client = AsyncCodex(make_codex_config())
        if archived:
            await client.thread_archive(thread_id)
        else:
            await client.thread_unarchive(thread_id)
        return {"ok": True, "archived": archived, "thread_id": thread_id}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        if client is not None:
            try:
                await asyncio.wait_for(client.close(), timeout=5.0)
            except Exception:
                pass


def _rate_window(rl: Any) -> dict[str, Any] | None:
    """Normalize one Codex rate-limit window → the shape the hub UsageMeter
    understands (utilization %, resets_at seconds)."""
    if rl is None:
        return None
    used = getattr(rl, "used_percent", None)
    resets = getattr(rl, "resets_at", None)
    mins = getattr(rl, "window_duration_mins", None)
    if used is None and resets is None:
        return None
    return {
        "used_percent": float(used) if isinstance(used, (int, float)) else None,
        "resets_at": int(resets) if isinstance(resets, (int, float)) else None,
        "window_minutes": int(mins) if isinstance(mins, (int, float)) else None,
    }


async def fetch_codex_usage() -> dict[str, Any]:
    """Best-effort Codex account usage snapshot (rate-limit utilization). Maps
    onto the same account_usage surface the Claude /usage gauges use. Never
    raises."""
    if not CODEX_AVAILABLE:
        return {"ok": False, "error": CODEX_IMPORT_ERROR or "codex unavailable"}
    from openai_codex.generated.v2_all import GetAccountRateLimitsResponse
    client = None
    try:
        # Use the SDK's public typed low-level client directly. This replaces
        # the old AsyncCodex._client reach-through that silently broke when the
        # wrapper layout changed.
        from openai_codex.async_client import AsyncCodexClient
        from openai_codex.generated.v2_all import GetAccountParams
        client = AsyncCodexClient(make_codex_config())
        await client.start()
        await client.initialize()
        acct = await client.account_read(GetAccountParams(refresh_token=False))
        plan = None
        a = getattr(acct, "account", None)
        root = getattr(a, "root", a)
        if root is not None:
            plan = getattr(root, "plan_type", None) or getattr(root, "planType", None)
        resp = await client.request(
            "account/rateLimits/read", {},
            response_model=GetAccountRateLimitsResponse,
        )
        snap = getattr(resp, "rate_limits", None)
        if plan is None and snap is not None:
            plan = getattr(snap, "plan_type", None)
        windows = []
        for attr in ("primary", "secondary"):
            w = _rate_window(getattr(snap, attr, None)) if snap is not None else None
            if w is not None:
                windows.append(w)
        # Classify windows by duration → the same 5h / weekly slots the Claude
        # /usage gauges use (Codex plans may expose only one window).
        five_hour = seven_day = None
        for w in windows:
            mins = w.get("window_minutes") or 0
            if mins and mins <= 360:
                five_hour = w
            else:
                seven_day = w
        return {
            "ok": True,
            "provider": "codex",
            "plan_type": _enum_val(plan) if plan is not None else None,
            "five_hour": five_hour,
            "seven_day": seven_day,
            "windows": windows,
            "fetched_at": time.time(),
        }
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        if client is not None:
            try:
                await asyncio.wait_for(client.close(), timeout=5.0)
            except Exception:
                pass


class CodexSession:
    """An OpenAI Codex session isolated within the agent.

    Mirrors :class:`session.AgentSession`'s contract so ``server.py`` can drive
    both interchangeably via the ``kind`` discriminator.
    """

    kind = "codex"

    # Effort levels Codex understands (catalog-driven per model; this is the
    # superset used for validation — the UI gates per model like it does for
    # Claude). "ultra" is Codex's Workflow-delegation tier (the analog of
    # Charon's "ultracode" pseudo-effort for Claude).
    VALID_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")

    def __init__(
        self,
        session_id: str,
        *,
        cwd: str,
        name: str | None,
        permission_mode: str,
        claude_session_id: str | None,
        emit: EmitCallback,
        on_state_change: StateSaveCallback,
        model: str | None = None,
        fallback_model: str | None = None,
        effort: str | None = None,
        codex_config: dict[str, Any] | None = None,
        handle: str | None = None,
        peer_mcp: dict[str, Any] | None = None,
    ) -> None:
        self.session_id = session_id
        self.cwd = cwd
        self.name = name
        self.handle = handle or None
        self.peer_mcp = dict(peer_mcp) if isinstance(peer_mcp, dict) else None
        # For a Codex session, permission_mode holds a Codex mode string
        # (read-only / workspace-write / full-access). Accept the legacy
        # Claude modes too and coerce them to a sane Codex default so a mode
        # value written before this session was tagged doesn't break start.
        self.permission_mode = permission_mode if permission_mode in CODEX_MODES else DEFAULT_CODEX_MODE
        # claude_session_id doubles as the Codex THREAD id (the resume handle).
        self.claude_session_id = claude_session_id
        self.model = model or None
        # Codex has no fallback-model concept; keep the attr for contract parity
        # (always None) so server.py's set_model path is uniform.
        self.fallback_model = None
        self.effort = effort if effort in self.VALID_EFFORTS else None
        cfg = codex_config if isinstance(codex_config, dict) else {}
        self.codex_config: dict[str, Any] = {
            "config_overrides": [str(v)[:2048] for v in (cfg.get("configOverrides") or [])[:64]
                                 if isinstance(v, str) and v.strip()],
            "output_schema": cfg.get("outputSchema") if isinstance(cfg.get("outputSchema"), dict) else None,
            "base_instructions": cfg.get("baseInstructions") if isinstance(cfg.get("baseInstructions"), str) else None,
            "developer_instructions": cfg.get("developerInstructions") if isinstance(cfg.get("developerInstructions"), str) else None,
            "summary": cfg.get("summary") if cfg.get("summary") in ("auto", "concise", "detailed", "none") else None,
            "personality": cfg.get("personality") if cfg.get("personality") in ("friendly", "pragmatic", "none") else None,
            "service_tier": cfg.get("serviceTier") if cfg.get("serviceTier") in ("fast", "flex") else None,
            "ephemeral": bool(cfg.get("ephemeral")),
            "model_provider": cfg.get("modelProvider") if isinstance(cfg.get("modelProvider"), str) else None,
            "env": {str(k): str(v)[:8192] for k, v in (cfg.get("env") or {}).items()}
                   if isinstance(cfg.get("env"), dict) else {},
            "codex_bin": cfg.get("codexBin") if isinstance(cfg.get("codexBin"), str) else None,
            "approvals_reviewer": cfg.get("approvalsReviewer")
            if cfg.get("approvalsReviewer") in ("user", "auto_review") else "user",
            "permission_profile": cfg.get("permissionProfile")
            if isinstance(cfg.get("permissionProfile"), str) and cfg.get("permissionProfile").strip() else None,
        }
        self._emit_to_server = emit
        self._on_state_change = on_state_change

        self.status: str = "starting"
        self._client: Any = None            # AsyncCodex (non-None while running)
        self._thread: Any = None            # AsyncThread
        self._active_turn: Any = None       # AsyncTurnHandle (live turn)
        self._main_task: asyncio.Task | None = None
        self._global_task: asyncio.Task | None = None
        self._external_turn_task: asyncio.Task | None = None
        self._external_probe_task: asyncio.Task | None = None
        self._external_probe_lock: asyncio.Lock | None = None
        self._starting_turn = False
        self._stdin_queue: asyncio.Queue = asyncio.Queue()
        # Server-initiated SDK requests run on the SDK reader thread. Futures
        # below live on the agent loop; the callback blocks only that reader
        # until the dashboard responds, exactly as app-server expects.
        self._loop: asyncio.AbstractEventLoop | None = None
        self._pending_perms: dict[str, asyncio.Future] = {}
        self._pending_request_meta: dict[str, dict[str, Any]] = {}
        self._session_id_emitted = False
        self._stopped = asyncio.Event()
        self._ready_evt = asyncio.Event()
        self._error_msg: str | None = None

        # Translation state
        self._effective_model: str | None = None
        self._streamed_items: set[str] = set()   # item ids that got text deltas
        self._last_usage: dict[str, int] | None = None
        self._last_thread_usage: dict[str, Any] | None = None
        self._thread_status: dict[str, Any] | None = None
        self._mcp_startup: dict[str, dict[str, Any]] = {}
        self._codex_stderr_lines: list[str] = []
        self._plan_deltas: dict[str, str] = {}
        self._fs_watch_id: str | None = None
        # Codex's background-terminal registry is native app-server state. Map
        # it onto the same durable bg_task lifecycle Claude uses so the hub's
        # status, notifications and fleet-update quiet gate all agree.
        self._background_terminals: dict[str, dict[str, Any]] = {}
        self._background_monitor_task: asyncio.Task | None = None
        self._background_sync_lock = asyncio.Lock()
        # Exact Guardian denial payloads are required by
        # thread/approveGuardianDeniedAction. Keep only the ten entries Codex
        # itself exposes in its /approve picker; they are runtime state, not
        # durable authorization grants.
        self._guardian_denials: list[dict[str, Any]] = []

    # ── Public API (mirrors AgentSession) ────────────────────────────────────
    async def start(self) -> None:
        if self._main_task is not None:
            return
        if not CODEX_AVAILABLE:
            self.status = "error"
            self._error_msg = f"openai_codex not importable: {CODEX_IMPORT_ERROR}"
            self._emit("error", msg=self._error_msg, fatal=True)
            self._emit("status", status="error")
            await self._save_state()
            return
        self._main_task = asyncio.create_task(self._run(), name=f"codex-{self.session_id}")

    async def stop(self, *, mark: str = "sleeping") -> None:
        self.status = mark
        self._emit("status", status=mark)
        self._cancel_pending_requests()
        # Interrupt a live turn so the stream unblocks quickly.
        turn = self._active_turn
        if turn is not None:
            try:
                res = turn.interrupt()
                if asyncio.iscoroutine(res):
                    await res
            except Exception:
                pass
        await self._stdin_queue.put(None)  # EOF
        external = getattr(self, "_external_turn_task", None)
        if external is not None and not external.done():
            external.cancel()
        if self._main_task is not None:
            try:
                await asyncio.wait_for(self._main_task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._main_task.cancel()
        self._main_task = None
        self._stopped.set()
        await self._save_state()

    async def force_stop(self) -> None:
        self.status = "sleeping"
        self._emit("status", status="sleeping")
        self._emit("interrupted", forced=True)
        self._cancel_pending_requests()
        old_task = self._main_task
        client = self._client
        external = getattr(self, "_external_turn_task", None)
        if external is not None and not external.done():
            external.cancel()
        probe = getattr(self, "_external_probe_task", None)
        if probe is not None and not probe.done():
            probe.cancel()
        if old_task is not None and not old_task.done():
            # Do not clear ``_client`` before _run's finally: that is the
            # owner which closes the app-server child.  Clearing first leaked
            # a live Codex process that kept executing an autonomous goal and
            # editing the workspace after Charon displayed "stopped".
            old_task.cancel()
            try:
                await asyncio.wait_for(
                    asyncio.gather(old_task, return_exceptions=True), timeout=7.0,
                )
            except asyncio.TimeoutError:
                # A transport close can itself wedge.  Retain the captured
                # client and make one bounded direct close attempt instead of
                # orphaning the process silently.
                if client is not None:
                    try:
                        res = client.close()
                        if asyncio.iscoroutine(res):
                            await asyncio.wait_for(res, timeout=5.0)
                    except Exception:
                        pass
        elif client is not None:
            try:
                res = client.close()
                if asyncio.iscoroutine(res):
                    await asyncio.wait_for(res, timeout=5.0)
            except Exception:
                pass
        self._external_turn_task = None
        self._external_probe_task = None
        self._main_task = None
        self._client = None
        self._thread = None
        self._active_turn = None
        self._stopped.set()
        await self._save_state()

    async def send_input(self, content: str, codex_inputs: list[dict[str, Any]] | None = None) -> None:
        if self.status not in ("active", "thinking", "starting"):
            raise RuntimeError(f"session {self.session_id} not running (status={self.status})")
        # Mid-turn: steer the live turn (parity with Claude's mid-turn query).
        turn = self._active_turn
        if turn is not None and self.status == "thinking":
            try:
                res = turn.steer(codex_inputs or content)
                if asyncio.iscoroutine(res):
                    await res
                return
            except Exception as e:
                self._emit("error", msg=f"steer: {e}")
                # fall through to queue for the next turn
        await self._stdin_queue.put({"type": "user_message", "content": content,
                                     "codex_inputs": codex_inputs})

    async def interrupt(self) -> None:
        turn = self._active_turn
        if turn is None:
            return
        try:
            res = turn.interrupt()
            if asyncio.iscoroutine(res):
                await res
            self._emit("interrupted")
        except Exception as e:
            self._emit("error", msg=f"interrupt: {e}")

    async def set_permission_mode(self, mode: str) -> None:
        # For Codex, "mode" is the sandbox level; applies on the NEXT turn.
        if mode not in CODEX_MODES:
            mode = DEFAULT_CODEX_MODE
        self.permission_mode = mode
        self._emit("mode_changed", mode=mode)
        await self._save_state()

    async def security_status(self, force_reload: bool = False) -> dict[str, Any]:
        """Return reviewer, active profile and server-advertised profiles."""
        if self._client is None:
            return {"ok": False, "error": "Codex thread is not running"}
        try:
            from openai_codex.generated.v2_all import PermissionProfileListResponse
            rows: list[dict[str, Any]] = []
            cursor = None
            while True:
                response = await self._client._client.request(
                    "permissionProfile/list",
                    {"cwd": self.cwd, "limit": 100,
                     **({"cursor": cursor} if cursor else {})},
                    response_model=PermissionProfileListResponse,
                )
                rows.extend(self._json_safe(row) for row in (response.data or []))
                cursor = response.next_cursor
                if not cursor:
                    break
            return {
                "ok": True,
                "reviewer": self.codex_config.get("approvals_reviewer", "user"),
                "permission_profile": self.codex_config.get("permission_profile"),
                "profiles": rows,
                "denials": [dict(row) for row in self._guardian_denials],
                "force_reloaded": bool(force_reload),
            }
        except Exception as e:
            # ApprovalsReviewer is independent from the beta profile catalog.
            # A server without permissionProfile/list must still expose and
            # allow changing ask-me vs auto-review.
            if getattr(e, "code", None) == -32601:
                return {
                    "ok": True,
                    "reviewer": self.codex_config.get("approvals_reviewer", "user"),
                    "permission_profile": self.codex_config.get("permission_profile"),
                    "profiles": [],
                    "denials": [dict(row) for row in self._guardian_denials],
                    "profile_reason": "unsupported",
                }
            return {"ok": False, "error": f"permissionProfile/list: {e}"}

    async def set_security(self, reviewer: str, permission_profile: str | None) -> dict[str, Any]:
        if reviewer not in ("user", "auto_review"):
            raise ValueError("reviewer must be user or auto_review")
        if permission_profile is not None:
            permission_profile = permission_profile.strip()
            if not permission_profile or len(permission_profile) > 256:
                raise ValueError("permission_profile must be a non-empty profile id")
        self.codex_config["approvals_reviewer"] = reviewer
        self.codex_config["permission_profile"] = permission_profile
        # Rejoin the loaded thread with the modern profile. permissions and
        # legacy sandbox are deliberately mutually exclusive. Reviewer is also
        # sent on every turn, so changing it never requires a restart.
        if self._client is not None and self.claude_session_id:
            params: dict[str, Any] = {"approvalsReviewer": reviewer, "cwd": self.cwd}
            if permission_profile:
                params["permissions"] = permission_profile
            else:
                params["sandbox"] = _sandbox_mode_wire(self.permission_mode)
            await self._client._client.thread_resume(self.claude_session_id, params)
        await self._save_state()
        return await self.security_status()

    async def approve_guardian_denial(self, review_id: str) -> dict[str, Any]:
        if self._client is None or not self.claude_session_id:
            raise RuntimeError("Codex thread is not ready")
        denial = next((row for row in reversed(self._guardian_denials)
                       if row.get("review_id") == review_id), None)
        if denial is None:
            raise ValueError("Guardian denial is no longer available")
        from openai_codex.generated.v2_all import ThreadApproveGuardianDeniedActionResponse
        await self._client._client.request(
            "thread/approveGuardianDeniedAction",
            {"threadId": self.claude_session_id, "event": denial["event"]},
            response_model=ThreadApproveGuardianDeniedActionResponse,
        )
        self._guardian_denials = [row for row in self._guardian_denials
                                  if row.get("review_id") != review_id]
        return {"ok": True, "review_id": review_id}

    async def resources(self, force_reload: bool = False) -> dict[str, Any]:
        """List model-invokable local skills and hosted Apps/connectors."""
        if self._client is None or not self.claude_session_id:
            return {"ok": False, "error": "Codex thread is not running"}
        from openai_codex.generated.v2_all import SkillsListResponse, AppsListResponse
        skills_response = await self._client._client.request(
            "skills/list", {"cwds": [self.cwd], "forceReload": force_reload},
            response_model=SkillsListResponse,
        )
        skills: list[dict[str, Any]] = []
        errors: list[Any] = []
        for entry in (getattr(skills_response, "data", None) or []):
            skills.extend(self._json_safe(skill) for skill in (getattr(entry, "skills", None) or []))
            errors.extend(self._json_safe(error) for error in (getattr(entry, "errors", None) or []))

        apps: list[dict[str, Any]] = []
        apps_error = None
        cursor = None
        try:
            while True:
                response = await self._client._client.request(
                    "app/list", {"threadId": self.claude_session_id, "limit": 100,
                                 "forceRefetch": force_reload,
                                 **({"cursor": cursor} if cursor else {})},
                    response_model=AppsListResponse,
                )
                apps.extend(self._json_safe(app) for app in (getattr(response, "data", None) or []))
                cursor = getattr(response, "next_cursor", None)
                if not cursor:
                    break
        except Exception as e:
            # Apps are account/feature gated independently from local skills.
            # One unavailable catalog must not hide the other.
            apps_error = str(e)
        return {"ok": True, "skills": skills, "skill_errors": errors,
                "apps": apps, "apps_error": apps_error}

    async def set_skill_enabled(self, path: str, enabled: bool) -> dict[str, Any]:
        if self._client is None:
            raise RuntimeError("Codex thread is not running")
        from openai_codex.generated.v2_all import SkillsConfigWriteResponse
        response = await self._client._client.request(
            "skills/config/write", {"path": path, "enabled": enabled},
            response_model=SkillsConfigWriteResponse,
        )
        return {"ok": True, "effective_enabled": bool(response.effective_enabled)}

    async def _codex_descendants(self) -> list[tuple[Any, int]]:
        """List this thread's descendants without assuming parent filters.

        0.147 exposes parentThreadId on Thread but not in ThreadListParams, so
        fetch the bounded spawned-agent catalog and build the tree locally.
        Guardian approval reviewers, compaction workers and memory maintenance
        also have parentThreadId, but they are implementation details rather
        than collaborators and must not leak their full review prompts here.
        """
        if self._client is None or not self.claude_session_id:
            return []
        from openai_codex.generated.v2_all import ThreadListResponse
        rows: list[Any] = []
        cursor = None
        while len(rows) < 500:
            response = await self._client._client.request(
                "thread/list", {
                    "cwd": self.cwd, "sourceKinds": ["subAgentThreadSpawn"],
                    "limit": 100, "sortKey": "created_at", "sortDirection": "asc",
                    **({"cursor": cursor} if cursor else {}),
                }, response_model=ThreadListResponse,
            )
            rows.extend(response.data or [])
            cursor = response.next_cursor
            if not cursor:
                break
        children: dict[str, list[Any]] = {}
        for row in rows:
            parent = getattr(row, "parent_thread_id", None)
            if isinstance(parent, str):
                children.setdefault(parent, []).append(row)
        out: list[tuple[Any, int]] = []
        queue = [(child, 1) for child in children.get(self.claude_session_id, [])]
        seen: set[str] = set()
        while queue and len(out) < 200:
            row, depth = queue.pop(0)
            tid = getattr(row, "id", None)
            if not isinstance(tid, str) or tid in seen:
                continue
            seen.add(tid)
            out.append((row, depth))
            queue[0:0] = [(child, depth + 1) for child in children.get(tid, [])]
        return out

    async def subagents(self) -> dict[str, Any]:
        descendants = await self._codex_descendants()
        agents = []
        for thread, depth in descendants:
            status = self._json_safe(getattr(thread, "status", None))
            root = status.get("root", status) if isinstance(status, dict) else status
            agents.append({
                "id": getattr(thread, "id", None),
                "parent_id": getattr(thread, "parent_thread_id", None),
                "depth": depth,
                "name": getattr(thread, "agent_nickname", None) or getattr(thread, "name", None),
                "role": getattr(thread, "agent_role", None),
                "preview": str(getattr(thread, "preview", "") or "")[:500],
                "status": root.get("type") if isinstance(root, dict) else str(root or ""),
                "created_at": getattr(thread, "created_at", None),
            })
        return {"ok": True, "agents": agents}

    async def subagent_messages(self, agent_id: str, limit: int = 400) -> dict[str, Any]:
        descendants = await self._codex_descendants()
        allowed = {str(getattr(thread, "id", "")) for thread, _depth in descendants}
        if agent_id not in allowed:
            return {"ok": False, "error": "thread is not a descendant of this session"}
        response = await self._client._client.thread_read(agent_id, include_turns=True)
        thread = getattr(response, "thread", None)
        messages: list[dict[str, Any]] = []
        for turn in (getattr(thread, "turns", None) or []):
            for wrapped in (getattr(turn, "items", None) or []):
                item = getattr(wrapped, "root", wrapped)
                kind = type(item).__name__
                role, content = None, ""
                if kind == "UserMessageThreadItem":
                    role = "user"
                    parts = []
                    for value in (getattr(item, "content", None) or []):
                        value = getattr(value, "root", value)
                        text = getattr(value, "text", None)
                        if isinstance(text, str): parts.append(text)
                    content = "\n".join(parts)
                elif kind == "AgentMessageThreadItem":
                    role, content = "assistant", str(getattr(item, "text", "") or "")
                elif "Reasoning" in kind:
                    role = "thinking"
                    content = self._stringify(self._json_safe(item))
                if role and content:
                    messages.append({"role": role, "content": content[:8000],
                                     "turn_id": getattr(turn, "id", None)})
                    if len(messages) >= max(1, min(limit, 400)):
                        return {"ok": True, "messages": messages}
        return {"ok": True, "messages": messages}

    async def set_model(self, model: str | None, fallback_model: str | None = None) -> None:
        # Codex applies model per-turn → the change takes effect on the NEXT
        # turn with NO sleep+resume needed. applied_at_next_start=False tells
        # the UI not to show the deferred-restart badge.
        self.model = model or None
        self._emit(
            "model_changed",
            model=self.model,
            fallback_model=None,
            applied_at_next_start=False,
        )
        await self._save_state()

    async def set_effort(self, effort: str | None) -> None:
        if effort is not None and effort not in self.VALID_EFFORTS:
            self._emit("error", msg=f"invalid effort {effort!r} (valid: {self.VALID_EFFORTS})")
            return
        self.effort = effort or None
        self._emit(
            "effort_changed",
            effort=self.effort,
            applied_at_next_start=False,
        )
        await self._save_state()

    async def inject_history(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        """Append prebuilt Responses items to this thread's durable history.

        ``thread/inject_items`` is the app-server's native handoff primitive:
        it persists the supplied items in the rollout and includes them in
        subsequent model requests without starting a turn.  A brand-new Codex
        session starts asynchronously, so callers may arrive before
        ``thread_start`` has returned; wait for that boundary instead of racing
        a request against a thread that does not exist yet.

        The Charon socket accepts one line below 64 KiB.  The hub therefore
        sends several bounded batches; validate each one again here because a
        protocol endpoint must not trust its caller.
        """
        if not isinstance(items, list) or not items:
            raise ValueError("items must be a non-empty list")
        if len(items) > 64:
            raise ValueError("too many history items in one batch")
        encoded = json.dumps(items, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > 56 * 1024:
            raise ValueError("history batch exceeds 56 KiB")
        for item in items:
            if not isinstance(item, dict) or item.get("type") != "message":
                raise ValueError("history items must be message objects")
            role = item.get("role")
            if role not in ("user", "assistant"):
                raise ValueError("history message role must be user or assistant")
            content = item.get("content")
            expected = "input_text" if role == "user" else "output_text"
            if (not isinstance(content, list) or len(content) != 1
                    or not isinstance(content[0], dict)
                    or content[0].get("type") != expected
                    or not isinstance(content[0].get("text"), str)):
                raise ValueError(f"{role} history content must contain one {expected}")

        try:
            await asyncio.wait_for(self._ready_evt.wait(), timeout=45.0)
        except asyncio.TimeoutError as e:
            raise RuntimeError("Codex thread did not become ready for history import") from e
        if self.status != "active" or self._client is None or self._thread is None:
            raise RuntimeError(
                f"Codex thread is not available for history import (status={self.status})"
            )
        if self._active_turn is not None:
            raise RuntimeError("cannot import history while a Codex turn is running")
        thread_id = self.claude_session_id or getattr(self._thread, "id", None)
        if not isinstance(thread_id, str) or not thread_id:
            raise RuntimeError("Codex thread has no id")

        response_model = _thread_inject_response_model()
        raw = getattr(self._client, "_client", None)
        request = getattr(raw, "request", None)
        if not callable(request):
            raise RuntimeError("the installed openai-codex SDK has no raw app-server client")
        await request(
            "thread/inject_items",
            {"threadId": thread_id, "items": items},
            response_model=response_model,
        )
        return {"ok": True, "count": len(items), "thread_id": thread_id}

    def _session_sdk_config(self) -> Any:
        """Build the SDK config shared by the resident and transient clients."""
        overrides = list(self.codex_config.get("config_overrides") or ())
        peer_mcp = getattr(self, "peer_mcp", None)
        if peer_mcp:
            # `config_overrides` is the supported SDK escape hatch for
            # config.toml. JSON strings/arrays are valid TOML literals. Keep
            # the reserved server last so a user override cannot redirect the
            # internal peer transport to another executable.
            command = str(peer_mcp.get("command") or "")
            args = [str(v) for v in (peer_mcp.get("args") or [])]
            overrides.extend((
                f"mcp_servers.charon_peer.command={json.dumps(command)}",
                f"mcp_servers.charon_peer.args={json.dumps(args)}",
                "mcp_servers.charon_peer.enabled=true",
                "mcp_servers.charon_peer.startup_timeout_sec=10",
                "mcp_servers.charon_peer.tool_timeout_sec=30",
            ))
        return make_codex_config(
            cwd=self.cwd,
            config_overrides=tuple(overrides),
            env=self.codex_config.get("env") or None,
            codex_bin=self.codex_config.get("codex_bin") or None,
        )

    async def _fork_with_transient_client(
        self,
        *,
        title: str | None,
        last_turn_id: str | None,
    ) -> str:
        """Fork through a short-lived app-server and release its writer lock.

        ``thread/fork`` loads and subscribes the child on the connection which
        performs the request.  Every Charon Codex session owns a separate
        app-server process, so forking on the source session's resident client
        left the child writer-locked there.  The newly-created Charon session
        then failed ``thread/resume`` with "already has an active writer".

        A dedicated SDK client can fork a stored thread without resuming it.
        Closing that client before returning releases the child's native writer
        lock, while the source process and any in-flight source turn remain
        untouched.
        """
        client = AsyncCodex(self._session_sdk_config())
        try:
            if hasattr(client, "_client"):
                # Keep initialization identical to resident clients.  Install
                # the callback first in case MCP startup needs an elicitation.
                client._client._sync._approval_handler = self._sdk_approval_handler
                await self._initialize_sdk(client)
                params = {k: v for k, v in {
                    "cwd": self.cwd,
                    "model": self.model,
                    "lastTurnId": last_turn_id,
                    "baseInstructions": self.codex_config.get("base_instructions"),
                    "developerInstructions": self.codex_config.get("developer_instructions"),
                    "modelProvider": self.codex_config.get("model_provider"),
                    "serviceTier": self.codex_config.get("service_tier"),
                    "approvalsReviewer": self.codex_config.get("approvals_reviewer", "user"),
                }.items() if v is not None}
                result = await client._client.thread_fork(self.claude_session_id, params)
                from openai_codex.api import AsyncThread
                thread = AsyncThread(client, result.thread.id)
            else:
                # Compatibility path for old SDKs and lightweight test doubles.
                if last_turn_id:
                    raise RuntimeError("this Codex SDK cannot fork at a specific turn")
                thread = await client.thread_fork(
                    self.claude_session_id,
                    cwd=self.cwd,
                    model=self.model,
                    **{k: v for k, v in {
                        "base_instructions": self.codex_config.get("base_instructions"),
                        "developer_instructions": self.codex_config.get("developer_instructions"),
                        "model_provider": self.codex_config.get("model_provider"),
                        "service_tier": self.codex_config.get("service_tier"),
                    }.items() if v is not None},
                )
            if title:
                await thread.set_name(title)
            thread_id = getattr(thread, "id", None)
            if not isinstance(thread_id, str) or not thread_id:
                raise RuntimeError("Codex fork returned no thread id")
            return thread_id
        finally:
            try:
                result = client.close()
                if asyncio.iscoroutine(result):
                    await asyncio.wait_for(result, timeout=5.0)
            except Exception:
                pass

    async def fork(self, title: str | None = None, last_turn_id: str | None = None,
                   ephemeral: bool = False) -> dict[str, Any]:
        await asyncio.wait_for(self._ready_evt.wait(), timeout=45.0)
        if self._client is None or not self.claude_session_id:
            raise RuntimeError("Codex thread is not ready")
        if ephemeral:
            # A transient client would destroy an in-memory fork when it
            # closes, while a resident client would recreate the active-writer
            # bug when Charon materializes a second session for it.
            raise RuntimeError("ephemeral Codex forks cannot become Charon sessions")
        thread_id = await self._fork_with_transient_client(
            title=title,
            last_turn_id=last_turn_id,
        )
        return {"ok": True, "claude_session_id": thread_id,
                "forked_from": self.claude_session_id}

    async def fork_points(self) -> dict[str, Any]:
        """Return completed native turns with bounded human-readable prompts."""
        if self._thread is None:
            return {"ok": False, "error": "Codex thread is not running"}
        read = await self._thread.read(include_turns=True)
        thread = getattr(read, "thread", None)
        points: list[dict[str, Any]] = []
        for turn in (getattr(thread, "turns", None) or []):
            status = str(_enum_val(getattr(turn, "status", "")))
            if status == "inProgress":
                continue
            prompt = ""
            for wrapped in (getattr(turn, "items", None) or []):
                item = getattr(wrapped, "root", wrapped)
                if type(item).__name__ != "UserMessageThreadItem":
                    continue
                parts = []
                for value in (getattr(item, "content", None) or []):
                    value = getattr(value, "root", value)
                    text = getattr(value, "text", None)
                    if isinstance(text, str):
                        parts.append(text)
                prompt = "\n".join(parts).strip()
                break
            points.append({
                "turn_id": getattr(turn, "id", None),
                "prompt": prompt[:16_384],
                "started_at": getattr(turn, "started_at", None),
                "completed_at": getattr(turn, "completed_at", None),
                "status": status,
            })
        return {"ok": True, "points": points[-100:]}

    async def set_session_name(self, name: str) -> bool:
        if self._thread is None:
            return False
        await self._thread.set_name(name)
        self.name = name
        return True

    async def compact(self) -> dict[str, Any]:
        if self._thread is None:
            raise RuntimeError("Codex thread is not ready")
        result = await self._thread.compact()
        return {"ok": True, "result": self._json_safe(result)}

    async def context_usage(self) -> dict[str, Any]:
        if self._thread is None:
            return {"ok": False, "error": "Codex thread is not running"}
        try:
            read = await self._thread.read(include_turns=False)
            thread = getattr(read, "thread", None)
            status = self._json_safe(getattr(thread, "status", None))
            root = status.get("root", status) if isinstance(status, dict) else status
            self._thread_status = root if isinstance(root, dict) else {"type": str(root)}
        except Exception as e:
            return {"ok": False, "error": f"thread/read: {e}"}
        usage = self._last_thread_usage or {}
        # `total` is lifetime COMPUTE across every model request in the thread.
        # It can exceed the context window by orders of magnitude and is not a
        # measure of what the next request must fit. `last` is the latest model
        # request's prompt/output footprint, which is the context gauge users
        # expect (the durable recorded-usage row already exposes aggregation).
        current = usage.get("last") if isinstance(usage, dict) else None
        total_tokens = (
            current.get("totalTokens", current.get("total_tokens"))
            if isinstance(current, dict) else None
        )
        max_tokens = usage.get("modelContextWindow", usage.get("model_context_window")) if isinstance(usage, dict) else None
        percentage = (
            float(total_tokens) * 100.0 / float(max_tokens)
            if isinstance(total_tokens, (int, float)) and isinstance(max_tokens, (int, float)) and max_tokens
            else None
        )
        categories: list[dict[str, Any]] = []
        if isinstance(current, dict):
            for snake, camel, label in (
                ("input_tokens", "inputTokens", "input"),
                ("cached_input_tokens", "cachedInputTokens", "cached input"),
                ("output_tokens", "outputTokens", "output"),
                ("reasoning_output_tokens", "reasoningOutputTokens", "reasoning"),
            ):
                value = current.get(snake, current.get(camel))
                if isinstance(value, (int, float)):
                    categories.append({"name": label, "tokens": int(value)})
        return {
            "ok": True,
            "provider": "codex",
            "status": self._thread_status,
            "total_tokens": total_tokens,
            "max_tokens": max_tokens,
            "percentage": percentage,
            "usage": usage or None,
            "categories": categories,
            "model": self._effective_model or self.model,
        }

    def identity(self) -> dict[str, Any]:
        return {
            "ok": True,
            "name": self.name,
            "cli_title": self.name,
            "handle": getattr(self, "handle", None),
            "thread_id": self.claude_session_id,
            "addressable": bool(getattr(self, "handle", None) and
                                getattr(self, "peer_mcp", None)),
        }

    async def mcp_status(self) -> dict[str, Any]:
        if self._client is None:
            return {"ok": False, "error": "Codex thread is not running"}
        try:
            from openai_codex.generated.v2_all import ListMcpServerStatusResponse
            cursor = None
            servers: list[dict[str, Any]] = []
            while True:
                response = await self._client._client.request(
                    "mcpServerStatus/list",
                    {
                        "threadId": self.claude_session_id,
                        "detail": "toolsAndAuthOnly",
                        "limit": 100,
                        **({"cursor": cursor} if cursor else {}),
                    },
                    response_model=ListMcpServerStatusResponse,
                )
                for server in getattr(response, "data", None) or []:
                    auth = _enum_val(getattr(server, "auth_status", None))
                    tools = getattr(server, "tools", None) or {}
                    startup = getattr(self, "_mcp_startup", {}).get(str(getattr(server, "name", "")), {})
                    servers.append({
                        "name": getattr(server, "name", None),
                        "status": startup.get("status") or ("auth required" if auth == "notLoggedIn" else "ready"),
                        "auth_status": auth,
                        "tool_count": len(tools),
                        "tools": list(tools.keys())[:100],
                        "server_info": self._json_safe(getattr(server, "server_info", None)),
                        "error": startup.get("error"),
                    })
                cursor = getattr(response, "next_cursor", None)
                if not cursor:
                    break
            return {"ok": True, "servers": servers}
        except Exception as e:
            return {"ok": False, "error": f"mcpServerStatus/list: {e}",
                    **({"reason": "unsupported"} if getattr(e, "code", None) == -32601 else {})}

    async def mcp_reconnect(self, _name: str) -> dict[str, Any]:
        if self._client is None:
            return {"ok": False, "error": "Codex thread is not running"}
        try:
            from pydantic import BaseModel

            class _ReloadResponse(BaseModel):
                pass
            result = await self._client._client.request(
                "config/mcpServer/reload", {}, response_model=_ReloadResponse,
            )
            return {"ok": True, "result": self._json_safe(result)}
        except Exception as e:
            return {"ok": False, "error": f"config/mcpServer/reload: {e}",
                    **({"reason": "unsupported"} if getattr(e, "code", None) == -32601 else {})}

    async def mcp_oauth_login(self, name: str) -> dict[str, Any]:
        if self._client is None or not self.claude_session_id:
            return {"ok": False, "error": "Codex thread is not running"}
        try:
            try:
                from openai_codex.generated.v2_all import McpServerOauthLoginResponse
                response_model = McpServerOauthLoginResponse
            except (ImportError, AttributeError):
                from pydantic import BaseModel, Field

                class _OauthResponse(BaseModel):
                    authorization_url: str = Field(alias="authorizationUrl")

                response_model = _OauthResponse
            response = await self._client._client.request(
                "mcpServer/oauth/login",
                {
                    "name": name, "threadId": self.claude_session_id,
                    "timeoutSecs": 300,
                },
                response_model=response_model,
            )
            url = getattr(response, "authorization_url", None)
            if not isinstance(url, str) or not url.startswith(("https://", "http://")):
                raise RuntimeError("Codex returned no valid MCP authorization URL")
            return {"ok": True, "authorization_url": url}
        except Exception as e:
            return {"ok": False, "error": f"mcpServer/oauth/login: {e}",
                    **({"reason": "unsupported"} if getattr(e, "code", None) == -32601 else {})}

    async def rollback(self, num_turns: int) -> dict[str, Any]:
        try:
            await asyncio.wait_for(self._ready_evt.wait(), timeout=45.0)
        except asyncio.TimeoutError as e:
            raise RuntimeError("Codex thread did not become ready for rewind") from e
        if self._client is None or not self.claude_session_id:
            raise RuntimeError("Codex thread is not ready")
        if self._active_turn is not None:
            raise RuntimeError("cannot rewind while a Codex turn is running")
        # thread/rollback is deprecated with no replacement. Use the supported
        # fork primitive directly and replace this session's native handle with
        # a branch ending at the last kept completed turn. Rewinding before the
        # first prompt becomes a fresh thread. Files remain deliberately
        # untouched in both cases.
        read = await self._thread.read(include_turns=True)
        turns = list(getattr(getattr(read, "thread", None), "turns", None) or [])
        if num_turns > len(turns):
            raise RuntimeError("rewind exceeds the available Codex turns")
        kept = turns[:-num_turns]
        old_id = self.claude_session_id
        if kept:
            result = await self._client._client.thread_fork(old_id, {
                "cwd": self.cwd, "lastTurnId": getattr(kept[-1], "id", None),
                "approvalsReviewer": self.codex_config.get("approvals_reviewer", "user"),
            })
            from openai_codex.api import AsyncThread
            new_thread = AsyncThread(self._client, result.thread.id)
            response_thread = result.thread
        else:
            new_thread = await self._sdk_thread_start(self._client, resume=False)
            response_thread = {"id": getattr(new_thread, "id", None)}
        new_id = getattr(new_thread, "id", None)
        if not new_id:
            raise RuntimeError("Codex rewind produced no replacement thread id")
        self.claude_session_id = new_id
        self._thread = new_thread
        self._emit("session_id", claude_session_id=new_id)
        await self._save_state()
        try:
            await self._client._client.thread_archive(old_id)
        except Exception:
            pass
        return {"ok": True, "thread": self._json_safe(response_thread),
                "strategy": "fork", "claude_session_id": new_id}

    @staticmethod
    def _thread_status_type(thread: Any) -> str:
        status = getattr(thread, "status", None)
        status = getattr(status, "root", status)
        value = getattr(status, "type", status)
        return str(getattr(value, "value", value) or "")

    @staticmethod
    def _turn_status_type(turn: Any) -> str:
        value = getattr(turn, "status", None)
        return str(getattr(value, "value", value) or "")

    async def _attach_active_external_turn(self) -> bool:
        """Adopt a server-started turn (goals/reviews/other clients).

        Codex goals may immediately start a continuation turn after the handle
        Charon was streaming completes.  The SDK router buffers that turn by
        id, but ``next_notification()`` deliberately cannot see it.  Without
        adopting the in-progress turn, a later ``turn/start`` is folded into
        the goal while Charon waits on a different handle and appears frozen.
        """
        if self._thread is None or self._client is None:
            return False
        if self._active_turn is not None or self._starting_turn:
            return self._active_turn is not None
        if self._external_probe_lock is None:
            self._external_probe_lock = asyncio.Lock()
        async with self._external_probe_lock:
            if self._active_turn is not None or self._starting_turn:
                return self._active_turn is not None
            # A thread created by thread/start exists in memory before its
            # first user message has materialized a rollout.  includeTurns is
            # invalid during that window; inspect the summary first and only
            # ask for turns when the runtime status proves one is active.
            try:
                summary = await self._thread.read(include_turns=False)
            except Exception as e:
                if "not materialized yet" in str(e):
                    return False
                raise
            thread = getattr(summary, "thread", None)
            if thread is None or self._thread_status_type(thread) != "active":
                return False
            try:
                read = await self._thread.read(include_turns=True)
            except Exception as e:
                if "not materialized yet" in str(e):
                    return False
                raise
            thread = getattr(read, "thread", None)
            turns = list(getattr(thread, "turns", None) or [])
            live = next(
                (turn for turn in reversed(turns)
                 if self._turn_status_type(turn) in ("inProgress", "in_progress")),
                None,
            )
            turn_id = getattr(live, "id", None)
            if not isinstance(turn_id, str) or not turn_id:
                raise RuntimeError(
                    "Codex reports an active external turn but did not expose its id"
                )
            handle = AsyncTurnHandle(self._client, self.claude_session_id, turn_id)
            # Claim synchronously before scheduling the consumer.  Otherwise a
            # user input arriving in this event-loop tick starts a second turn.
            self._active_turn = handle
            self._external_turn_task = asyncio.create_task(
                self._consume_external_turn(handle),
                name=f"codex-external-{self.session_id}",
            )
            return True

    def _schedule_external_turn_probe(self) -> None:
        if self._active_turn is not None or self._starting_turn:
            return
        task = self._external_probe_task
        if task is not None and not task.done():
            return

        async def probe() -> None:
            try:
                # ThreadStatusChanged can precede the turn being visible in
                # thread/read by a few milliseconds.
                for delay in (0.0, 0.05, 0.2, 0.5):
                    if delay:
                        await asyncio.sleep(delay)
                    if await self._attach_active_external_turn():
                        return
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # A brand-new thread has no persisted turns yet.  That is an
                # ordinary idle state, not a user-visible session error.
                if "not materialized yet" not in str(e):
                    self._emit("error", msg=f"external Codex turn: {e}")
            finally:
                self._external_probe_task = None

        self._external_probe_task = asyncio.create_task(
            probe(), name=f"codex-external-probe-{self.session_id}"
        )

    async def _consume_external_turn(self, handle: Any) -> None:
        self._active_turn = handle
        self._begin_turn()
        try:
            async for note in handle.stream():
                payload = getattr(note, "payload", note)
                await self._translate_and_emit(payload)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._emit("error", msg=self._format_err("review", e))
            self._emit("stop", subtype="error")
        finally:
            if self._active_turn is handle:
                self._active_turn = None
            self._external_turn_task = None
            self._end_turn()

    async def review(self, target: dict[str, Any], delivery: str = "inline") -> dict[str, Any]:
        try:
            await asyncio.wait_for(self._ready_evt.wait(), timeout=45.0)
        except asyncio.TimeoutError as e:
            raise RuntimeError("Codex thread did not become ready for review") from e
        if self._client is None or not self.claude_session_id:
            raise RuntimeError("Codex thread is not ready")
        if self._active_turn is not None:
            raise RuntimeError("cannot start review while a turn is running")
        from openai_codex.generated.v2_all import ReviewStartResponse
        response = await self._client._client.request(
            "review/start",
            {"threadId": self.claude_session_id, "target": target, "delivery": delivery},
            response_model=ReviewStartResponse,
        )
        turn = getattr(response, "turn", None)
        review_thread_id = getattr(response, "review_thread_id", None)
        if delivery == "inline" and turn is not None:
            handle = AsyncTurnHandle(self._client, self.claude_session_id, turn.id)
            self._active_turn = handle
            self._external_turn_task = asyncio.create_task(
                self._consume_external_turn(handle),
                name=f"codex-review-{self.session_id}"
            )
        return {
            "ok": True,
            "turn_id": getattr(turn, "id", None),
            "review_thread_id": review_thread_id,
        }

    async def background_terminals(self) -> dict[str, Any]:
        if self._client is None or not self.claude_session_id:
            return {"ok": False, "error": "Codex thread is not running"}
        from pydantic import BaseModel, ConfigDict, Field

        class _List(BaseModel):
            model_config = ConfigDict(populate_by_name=True)
            data: list[dict[str, Any]]
            next_cursor: str | None = Field(default=None, alias="nextCursor")

        rows: list[dict[str, Any]] = []
        cursor = None
        try:
            while True:
                response = await self._client._client.request(
                    "thread/backgroundTerminals/list",
                    {"threadId": self.claude_session_id, "limit": 100,
                     **({"cursor": cursor} if cursor else {})},
                    response_model=_List,
                )
                rows.extend(self._json_safe(x) for x in response.data)
                cursor = response.next_cursor
                if not cursor:
                    break
            return {"ok": True, "terminals": rows}
        except Exception as e:
            return {"ok": False, "error": f"backgroundTerminals/list: {e}",
                    **({"reason": "unsupported"} if getattr(e, "code", None) == -32601 else {})}

    @staticmethod
    def _background_terminal_id(row: dict[str, Any]) -> str:
        value = row.get("processId", row.get("process_id"))
        return str(value) if value is not None else ""

    @staticmethod
    def _background_terminal_description(row: dict[str, Any]) -> str:
        command = row.get("command")
        if isinstance(command, list):
            return " ".join(str(part) for part in command)[:4096]
        if isinstance(command, str) and command:
            return command[:4096]
        return CodexSession._background_terminal_id(row) or "Codex background process"

    async def _sync_background_terminals(
        self, *, start_monitor: bool = True, disappeared_status: str = "completed",
    ) -> None:
        """Reconcile the native process registry into common bg_task events."""
        lock = getattr(self, "_background_sync_lock", None)
        if lock is None:
            lock = asyncio.Lock()
            self._background_sync_lock = lock
        async with lock:
            result = await self.background_terminals()
            if not result.get("ok"):
                return
            current: dict[str, dict[str, Any]] = {}
            for raw in result.get("terminals") or []:
                if not isinstance(raw, dict):
                    continue
                process_id = self._background_terminal_id(raw)
                if process_id:
                    current[process_id] = raw
            previous = getattr(self, "_background_terminals", {})
            for process_id, row in current.items():
                if process_id not in previous:
                    self._emit(
                        "bg_task", kind="started",
                        task_id=f"codex-terminal:{process_id}",
                        description=self._background_terminal_description(row),
                        task_type="codex_terminal", status="running",
                    )
            for process_id in previous.keys() - current.keys():
                self._emit(
                    "bg_task", kind="finished",
                    task_id=f"codex-terminal:{process_id}",
                    status=disappeared_status, terminal=True,
                )
            self._background_terminals = current
        if start_monitor and current:
            task = getattr(self, "_background_monitor_task", None)
            if task is None or task.done():
                self._background_monitor_task = asyncio.create_task(
                    self._monitor_background_terminals(),
                    name=f"codex-background-{self.session_id}",
                )

    async def _monitor_background_terminals(self) -> None:
        try:
            while self._client is not None and getattr(self, "_background_terminals", {}):
                await asyncio.sleep(5.0)
                await self._sync_background_terminals(start_monitor=False)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"codex: background-terminal monitor failed: {e}", file=sys.stderr)
        finally:
            self._background_monitor_task = None

    async def stop_background_terminal(self, process_id: str) -> dict[str, Any]:
        if self._client is None or not self.claude_session_id:
            return {"ok": False, "error": "Codex thread is not running"}
        from pydantic import BaseModel

        class _Terminated(BaseModel):
            terminated: bool
        lock = getattr(self, "_background_sync_lock", None)
        if lock is None:
            lock = asyncio.Lock()
            self._background_sync_lock = lock
        async with lock:
            response = await self._client._client.request(
                "thread/backgroundTerminals/terminate",
                {"threadId": self.claude_session_id, "processId": process_id},
                response_model=_Terminated,
            )
            if response.terminated:
                tracked = getattr(self, "_background_terminals", {}).pop(process_id, None)
                # Emit even when the direct UI lookup found the process before
                # the end-of-turn reconciliation did. A lone finished row is
                # harmless; silently losing a requested kill is not.
                self._emit(
                    "bg_task", kind="finished",
                    task_id=f"codex-terminal:{process_id}",
                    description=(self._background_terminal_description(tracked)
                                 if isinstance(tracked, dict) else None),
                    task_type="codex_terminal", status="killed", terminal=True,
                )
        return {"ok": True, "terminated": response.terminated}

    def respond_permission(self, perm_id: str, allow: bool, always: bool = False) -> None:
        fut = self._pending_perms.pop(perm_id, None)
        self._pending_request_meta.pop(perm_id, None)
        if fut is not None and not fut.done():
            fut.set_result({"allow": bool(allow), "always": bool(always)})

    def respond_question(self, q_id: str, answers: dict | None) -> None:
        fut = self._pending_perms.pop(q_id, None)
        self._pending_request_meta.pop(q_id, None)
        if fut is not None and not fut.done():
            fut.set_result(answers)

    def respond_exit_plan(self, q_id: str, decision: str, feedback: str = "") -> None:
        fut = self._pending_perms.pop(q_id, None)
        self._pending_request_meta.pop(q_id, None)
        if fut is not None and not fut.done():
            fut.set_result({"decision": decision, "feedback": feedback})

    def _cancel_pending_requests(self) -> None:
        """Unblock the SDK reader before interrupt/close.

        The SDK invokes approval_handler synchronously from its only reader
        thread. Leaving one future pending would prevent that reader from
        routing the interrupt response and make shutdown wait for the 30 minute
        card timeout.
        """
        pending = getattr(self, "_pending_perms", {})
        for fut in list(pending.values()):
            if not fut.done():
                fut.set_result(None)
        pending.clear()
        getattr(self, "_pending_request_meta", {}).clear()

    async def _await_sdk_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = str(
            params.get("requestId") or params.get("itemId")
            or params.get("turnId") or uuid.uuid4().hex
        )
        # An item may issue more than one gate (notably managed network after a
        # command gate), so never let a repeated item id steal the first future.
        if request_id in self._pending_perms:
            request_id = f"{request_id}-{uuid.uuid4().hex[:8]}"
        fut = asyncio.get_running_loop().create_future()
        self._pending_perms[request_id] = fut
        self._pending_request_meta[request_id] = {"method": method, "params": params}

        try:
            if method == "mcpServer/elicitation/request" and params.get("mode") in ("form", "openai/form"):
                schema = params.get("requestedSchema") or {}
                properties = schema.get("properties") if isinstance(schema, dict) else {}
                questions = []
                key_by_question: dict[str, str] = {}
                for key, spec in (properties.items() if isinstance(properties, dict) else []):
                    spec = spec if isinstance(spec, dict) else {}
                    question = str(spec.get("title") or key)
                    key_by_question[question] = str(key)
                    enum = spec.get("enum") if isinstance(spec.get("enum"), list) else []
                    questions.append({
                        "question": question,
                        "header": str(params.get("serverName") or "MCP"),
                        "multiSelect": spec.get("type") == "array",
                        "options": [{"label": str(v), "description": ""} for v in enum],
                    })
                if not questions:
                    questions = [{
                        "question": str(params.get("message") or "Approve this MCP request?"),
                        "header": str(params.get("serverName") or "MCP"),
                        "multiSelect": False,
                        "options": [{"label": "Accept"}, {"label": "Decline"}],
                    }]
                self._emit("user_question", id=request_id, questions=questions)
                answers = await asyncio.wait_for(fut, timeout=1800.0)
                if not isinstance(answers, dict):
                    return {"action": "decline", "content": None}
                if key_by_question:
                    content = {
                        key: answers[question]
                        for question, key in key_by_question.items()
                        if isinstance(answers.get(question), str)
                    }
                else:
                    accepted = next(iter(answers.values()), "")
                    if str(accepted).lower() != "accept":
                        return {"action": "decline", "content": None}
                    content = {}
                return {"action": "accept", "content": content}

            if method == "item/tool/requestUserInput":
                raw_questions = params.get("questions") or []
                questions = []
                for i, q in enumerate(raw_questions if isinstance(raw_questions, list) else []):
                    if not isinstance(q, dict):
                        continue
                    options = []
                    for opt in q.get("options") or []:
                        if isinstance(opt, dict):
                            options.append({
                                "label": str(opt.get("label") or ""),
                                "description": str(opt.get("description") or ""),
                            })
                    questions.append({
                        "question": str(q.get("question") or q.get("id") or f"Question {i + 1}"),
                        "header": str(q.get("header") or "Codex"),
                        "multiSelect": bool(q.get("multiSelect")),
                        "options": options,
                    })
                self._emit("user_question", id=request_id, questions=questions)
                timeout_ms = params.get("autoResolutionMs")
                timeout = max(1.0, float(timeout_ms) / 1000.0) if isinstance(timeout_ms, int) else 1800.0
                answers = await asyncio.wait_for(fut, timeout=timeout)
                if not isinstance(answers, dict):
                    return {"answers": {}}
                wire_answers: dict[str, Any] = {}
                for i, q in enumerate(raw_questions if isinstance(raw_questions, list) else []):
                    if not isinstance(q, dict):
                        continue
                    qid = str(q.get("id") or i)
                    text = str(q.get("question") or qid)
                    value = answers.get(text)
                    if isinstance(value, str) and value:
                        wire_answers[qid] = {"answers": [v.strip() for v in value.split(",") if v.strip()]}
                return {"answers": wire_answers}

            tool = {
                "item/commandExecution/requestApproval": "Codex command",
                "item/fileChange/requestApproval": "Codex file changes",
                "item/permissions/requestApproval": "Codex permissions",
                "mcpServer/elicitation/request": "MCP elicitation",
            }.get(method, method)
            preview = dict(params)
            # Thread/turn ids are routing metadata, not useful card content.
            preview.pop("threadId", None)
            preview.pop("turnId", None)
            self._emit("permission_request", id=request_id, tool=tool, input=preview)
            answer = await asyncio.wait_for(fut, timeout=1800.0)
            allow = bool(answer and answer.get("allow")) if isinstance(answer, dict) else False
            always = bool(answer and answer.get("always")) if isinstance(answer, dict) else False
            if method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
                return {"decision": "acceptForSession" if allow and always else "accept" if allow else "decline"}
            if method == "item/permissions/requestApproval":
                return {
                    "permissions": params.get("permissions") if allow else {},
                    "scope": "session" if allow and always else "turn",
                }
            if method == "mcpServer/elicitation/request":
                return {"action": "accept" if allow else "decline", "content": {} if allow else None}
            return {}
        except (asyncio.TimeoutError, asyncio.CancelledError):
            if method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
                return {"decision": "cancel"}
            if method == "item/permissions/requestApproval":
                return {"permissions": {}, "scope": "turn"}
            if method == "mcpServer/elicitation/request":
                return {"action": "cancel", "content": None}
            return {"answers": {}} if method == "item/tool/requestUserInput" else {}
        finally:
            self._pending_perms.pop(request_id, None)
            self._pending_request_meta.pop(request_id, None)

    def _sdk_approval_handler(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        """SDK reader-thread callback → dashboard future on the agent loop."""
        if method not in {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "item/tool/requestUserInput",
            "mcpServer/elicitation/request",
        }:
            return {}
        loop = self._loop
        if loop is None or loop.is_closed():
            return {"decision": "cancel"}
        pending = asyncio.run_coroutine_threadsafe(
            self._await_sdk_request(method, dict(params or {})), loop
        )
        try:
            return pending.result(timeout=1810.0)
        except (concurrent.futures.TimeoutError, concurrent.futures.CancelledError):
            pending.cancel()
            return {"decision": "cancel"}

    async def _initialize_sdk(self, client: Any) -> None:
        """Initialize through the SDK client with egress capabilities.

        AsyncCodex's convenience initializer currently hard-codes only
        experimentalApi. The wrapped typed client exposes request/notify, so we
        can advertise notification opt-outs while remaining on the SDK-owned
        process, router and models.
        """
        from openai_codex._initialize_metadata import validate_initialize_metadata
        from openai_codex.models import InitializeResponse

        raw = client._client
        await raw.start()
        payload = await raw.request(
            "initialize",
            {
                "clientInfo": {
                    "name": raw._sync.config.client_name,
                    "title": raw._sync.config.client_title,
                    "version": raw._sync.config.client_version,
                },
                "capabilities": {
                    "experimentalApi": True,
                    "mcpServerOpenaiFormElicitation": True,
                    "optOutNotificationMethods": list(CODEX_OPT_OUT_NOTIFICATIONS),
                },
            },
            response_model=InitializeResponse,
        )
        await asyncio.to_thread(raw._sync.notify, "initialized", None)
        client._init = validate_initialize_metadata(payload)
        client._initialized = True

    async def _sdk_thread_start(self, client: Any, *, resume: bool) -> Any:
        params: dict[str, Any] = {
            "cwd": self.cwd,
            "approvalPolicy": "never" if self.permission_mode == "read-only" else "on-request",
            "approvalsReviewer": self.codex_config.get("approvals_reviewer", "user"),
        }
        profile = self.codex_config.get("permission_profile")
        if profile:
            params["permissions"] = profile
        else:
            params["sandbox"] = _sandbox_mode_wire(self.permission_mode)
        if self.model:
            params["model"] = self.model
        for src, dst in (
            ("base_instructions", "baseInstructions"),
            ("developer_instructions", "developerInstructions"),
            ("personality", "personality"),
            ("service_tier", "serviceTier"),
            ("model_provider", "modelProvider"),
        ):
            value = self.codex_config.get(src)
            if value is not None:
                params[dst] = _enum_val(value)
        if not resume and self.codex_config.get("ephemeral"):
            params["ephemeral"] = True
        # Lightweight test doubles and older SDKs retain the high-level path;
        # production 0.144.x takes the typed-client branch below.
        if not hasattr(client, "_client"):
            sandbox, approval = _mode_to_sandbox_approval(self.permission_mode)
            common = {
                "cwd": self.cwd, "sandbox": sandbox, "approval_mode": approval,
                **({"model": self.model} if self.model else {}),
            }
            if resume:
                return await client.thread_resume(self.claude_session_id, **common)
            return await client.thread_start(**common)
        from openai_codex.api import AsyncThread
        if resume:
            result = await client._client.thread_resume(self.claude_session_id, params)
        else:
            result = await client._client.thread_start(params)
        return AsyncThread(client, result.thread.id)

    async def _sdk_turn(self, thread: Any, content: Any) -> Any:
        from openai_codex.api import AsyncTurnHandle

        params: dict[str, Any] = {
            "approvalPolicy": "never" if self.permission_mode == "read-only" else "on-request",
            "approvalsReviewer": self.codex_config.get("approvals_reviewer", "user"),
        }
        # A named profile is thread-scoped and cannot be combined with legacy
        # sandbox settings. With no profile, preserve the existing per-turn
        # sandbox override.
        if not self.codex_config.get("permission_profile"):
            params["sandboxPolicy"] = _sandbox_policy_wire(self.permission_mode)
        if self.model:
            params["model"] = self.model
        if self.effort:
            params["effort"] = self.effort
        for src, dst in (
            ("output_schema", "outputSchema"),
            ("personality", "personality"),
            ("service_tier", "serviceTier"),
            ("summary", "summary"),
        ):
            value = self.codex_config.get(src)
            if value is not None:
                params[dst] = _enum_val(value)
        result = await self._client._client.turn_start(thread.id, content, params=params)
        return AsyncTurnHandle(self._client, thread.id, result.turn.id)

    def to_info(self) -> dict[str, Any]:
        return {
            "kind": "codex",
            "session_id": self.session_id,
            "claude_session_id": self.claude_session_id,
            "cwd": self.cwd,
            "name": self.name,
            "handle": getattr(self, "handle", None),
            "permission_mode": self.permission_mode,
            "status": self.status,
            "model": self.model,
            "fallback_model": None,
            "effort": self.effort,
            "provider_config": self._persisted_codex_config(),
            "codex_config": self._persisted_codex_config(),
        }

    def to_persist(self) -> dict[str, Any]:
        persist_status = self.status
        if persist_status in ("starting", "thinking"):
            persist_status = "active"
        return {
            "kind": "codex",
            "session_id": self.session_id,
            "claude_session_id": self.claude_session_id,
            "cwd": self.cwd,
            "name": self.name,
            "handle": getattr(self, "handle", None),
            "permission_mode": self.permission_mode,
            "status": persist_status,
            "model": self.model,
            "fallback_model": None,
            "effort": self.effort,
            "provider_config": self._persisted_codex_config(),
            # Compatibility with state.json written/read by agent <0.66.
            "codex_config": self._persisted_codex_config(),
        }

    # ── Internals ────────────────────────────────────────────────────────────
    def _emit(self, event: str, **fields: Any) -> None:
        msg = {"event": event, "session_id": self.session_id}
        msg.update(fields)
        try:
            self._emit_to_server(msg)
        except Exception:
            traceback.print_exc(file=sys.stderr)

    async def _save_state(self) -> None:
        try:
            res = self._on_state_change()
            if asyncio.iscoroutine(res):
                await res
        except Exception:
            traceback.print_exc(file=sys.stderr)

    def _format_err(self, label: str, e: Exception) -> str:
        parts = [f"{label}: {type(e).__name__}: {e}"]
        stderr = "\n".join(self._codex_stderr_lines[-40:]).strip()
        if stderr:
            parts.append("--- codex stderr ---\n" + stderr[-3000:])
        parts.append("--- traceback ---\n" + traceback.format_exc())
        return "\n".join(parts)

    def _begin_turn(self) -> None:
        if self.status == "thinking":
            return
        self.status = "thinking"
        self._emit("status", status="thinking")

    def _end_turn(self) -> None:
        if self.status != "thinking":
            return
        self.status = "active"
        self._emit("status", status="active")

    def _turn_overrides(self) -> dict[str, Any]:
        sandbox, approval = _mode_to_sandbox_approval(self.permission_mode)
        kw: dict[str, Any] = {"sandbox": sandbox, "approval_mode": approval}
        if self.model:
            kw["model"] = self.model
        eff = _coerce_effort(self.effort)
        if eff is not None:
            kw["effort"] = eff
        for key in ("output_schema", "personality", "service_tier", "summary"):
            value = self.codex_config.get(key)
            if value is not None:
                kw[key] = value
        return kw

    def _persisted_codex_config(self) -> dict[str, Any]:
        return {
            "configOverrides": self.codex_config.get("config_overrides", []),
            "outputSchema": self.codex_config.get("output_schema"),
            "baseInstructions": self.codex_config.get("base_instructions"),
            "developerInstructions": self.codex_config.get("developer_instructions"),
            "summary": self.codex_config.get("summary"),
            "personality": self.codex_config.get("personality"),
            "serviceTier": self.codex_config.get("service_tier"),
            "ephemeral": self.codex_config.get("ephemeral", False),
            "modelProvider": self.codex_config.get("model_provider"),
            "env": self.codex_config.get("env", {}),
            "codexBin": self.codex_config.get("codex_bin"),
            "approvalsReviewer": self.codex_config.get("approvals_reviewer", "user"),
            "permissionProfile": self.codex_config.get("permission_profile"),
        }

    # ── Translate Codex notifications → Charon events ─────────────────────────
    async def _translate_and_emit(self, payload: Any) -> None:
        events = self._translate(payload)
        # Discover background PTYs BEFORE the translated stop reaches the hub.
        # Otherwise the hub briefly (and observably) declares the session done,
        # sends its completion notification and may pass the fleet quiet gate.
        if type(payload).__name__ == "TurnCompletedNotification":
            await self._sync_background_terminals()
        for event in events:
            self._emit_to_server({"session_id": self.session_id, **event})

    def _translate(self, payload: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        try:
            pt = type(payload).__name__

            if pt == "AgentMessageDeltaNotification":
                delta = getattr(payload, "delta", "") or ""
                item_id = getattr(payload, "item_id", "") or ""
                if delta:
                    if item_id:
                        self._streamed_items.add(item_id)
                    out.append({"event": "assistant_text", "delta": delta,
                                "uuid": getattr(payload, "turn_id", None)})

            elif pt in ("ReasoningTextDeltaNotification", "ReasoningSummaryTextDeltaNotification"):
                delta = getattr(payload, "delta", "") or ""
                item_id = getattr(payload, "item_id", "") or ""
                if delta:
                    if item_id:
                        self._streamed_items.add(item_id)
                    out.append({"event": "thinking", "text": delta})

            elif pt in ("CommandExecutionOutputDeltaNotification", "CommandExecOutputDeltaNotification"):
                delta = getattr(payload, "delta", "") or ""
                item_id = getattr(payload, "item_id", "") or ""
                if delta and item_id:
                    out.append({"event": "tool_progress", "tool_use_id": item_id, "delta": delta})

            elif pt == "FileChangePatchUpdatedNotification":
                item_id = getattr(payload, "item_id", "") or ""
                for change in (getattr(payload, "changes", None) or []):
                    path = self._path_str(getattr(change, "path", None)) or ""
                    diff = getattr(change, "diff", "") or ""
                    if path and diff:
                        out.append({
                            "event": "edit_progress", "tool_use_id": item_id,
                            "file_path": path, "diff": diff[:256 * 1024],
                            "size": len(diff), "truncated": len(diff) > 256 * 1024,
                        })

            elif pt == "TurnDiffUpdatedNotification":
                diff = getattr(payload, "diff", "") or ""
                turn_id = getattr(payload, "turn_id", "") or "turn"
                for path, patch in self._split_turn_diff(diff):
                    out.append({
                        "event": "edit_progress", "tool_use_id": f"codex-turn-{turn_id}",
                        "file_path": path, "diff": patch[:256 * 1024],
                        "size": len(patch), "truncated": len(patch) > 256 * 1024,
                    })

            elif pt == "PlanDeltaNotification":
                item_id = getattr(payload, "item_id", "") or "plan"
                turn_id = getattr(payload, "turn_id", "") or item_id
                delta = getattr(payload, "delta", "") or ""
                if delta:
                    text = self._plan_deltas.get(item_id, "") + delta
                    self._plan_deltas[item_id] = text[-128 * 1024:]
                    out.append({
                        "event": "plan_progress", "id": f"turn-{turn_id}",
                        "text": self._plan_deltas[item_id],
                    })

            elif pt == "TurnPlanUpdatedNotification":
                turn_id = getattr(payload, "turn_id", "") or "plan"
                steps = []
                for step in (getattr(payload, "plan", None) or []):
                    steps.append({
                        "step": str(getattr(step, "step", "") or ""),
                        "status": str(_enum_val(getattr(step, "status", "pending"))),
                    })
                out.append({
                    "event": "plan_update", "id": f"turn-{turn_id}",
                    "explanation": getattr(payload, "explanation", None),
                    "steps": steps,
                })

            elif pt == "ItemStartedNotification":
                self._on_item(getattr(payload, "item", None), phase="started", out=out)

            elif pt == "ItemCompletedNotification":
                self._on_item(getattr(payload, "item", None), phase="completed", out=out)

            elif pt == "ThreadTokenUsageUpdatedNotification":
                tu = getattr(payload, "token_usage", None)
                self._last_thread_usage = self._json_safe(tu)
                u = self._usage_from(tu)
                if u is not None:
                    self._last_usage = u
                    out.append({"event": "usage", **u})

            elif pt == "ThreadStatusChangedNotification":
                status = self._json_safe(getattr(payload, "status", None))
                root = status.get("root", status) if isinstance(status, dict) else status
                status_type = root.get("type", "unknown") if isinstance(root, dict) else str(root)
                self._thread_status = root if isinstance(root, dict) else {"type": status_type}
                out.append({
                    "event": "codex_signal", "kind": "thread_status",
                    "id": getattr(payload, "thread_id", None) or "thread",
                    "status": status_type, "detail": root,
                })

            elif pt == "AccountRateLimitsUpdatedNotification":
                snap = getattr(payload, "rate_limits", None)
                out.append({
                    "event": "codex_signal", "kind": "account_limits",
                    "id": "account", "status": "updated",
                    "detail": self._json_safe(snap),
                })

            elif pt == "McpServerStatusUpdatedNotification":
                status = _enum_val(getattr(payload, "status", "updated"))
                name = getattr(payload, "name", None) or "mcp"
                startup_cache = getattr(self, "_mcp_startup", None)
                if startup_cache is None:
                    startup_cache = self._mcp_startup = {}
                startup_cache[str(name)] = {
                    "status": str(status),
                    "error": getattr(payload, "error", None) or self._stringify(
                        self._json_safe(getattr(payload, "failure_reason", None))
                    ),
                }
                out.append({
                    "event": "codex_signal", "kind": "mcp_status",
                    "id": name,
                    "status": str(status),
                    "detail": {
                        "name": getattr(payload, "name", None),
                        "error": getattr(payload, "error", None),
                        "failureReason": self._json_safe(
                            getattr(payload, "failure_reason", None)
                        ),
                    },
                })

            elif pt == "McpServerOauthLoginCompletedNotification":
                name = getattr(payload, "name", None) or "mcp"
                success = bool(getattr(payload, "success", False))
                out.append({
                    "event": "codex_signal", "kind": "mcp_oauth",
                    "id": name, "status": "connected" if success else "failed",
                    "detail": {
                        "name": name, "success": success,
                        "error": getattr(payload, "error", None),
                    },
                })

            elif pt == "SkillsChangedNotification":
                out.append({
                    "event": "codex_signal", "kind": "skills",
                    "id": "skills", "status": "changed",
                })

            elif pt == "FsChangedNotification":
                out.append({
                    "event": "codex_signal", "kind": "filesystem",
                    "id": getattr(payload, "watch_id", None) or "fs",
                    "status": "changed",
                    "detail": {
                        "paths": self._json_safe(getattr(payload, "changed_paths", None) or []),
                    },
                })

            elif pt == "ContextCompactedNotification":
                out.append({"event": "compaction", "trigger": "auto"})

            elif pt == "ModelReroutedNotification":
                model = getattr(payload, "to_model", None)
                if isinstance(model, str) and model:
                    self._effective_model = model
                    out.append({"event": "effective_model", "model": model})

            elif pt in ("ModelVerificationNotification", "ModelSafetyBufferingUpdatedNotification"):
                out.append({
                    "event": "tool_activity", "kind": "model",
                    "id": getattr(payload, "turn_id", None) or "model",
                    "status": "updated", "detail": self._json_safe(payload),
                })

            elif pt == "ItemGuardianApprovalReviewStartedNotification":
                rid = getattr(payload, "review_id", None) or "guardian"
                out.append({
                    "event": "tool_use", "id": rid, "name": "auto_review",
                    "input": {"action": self._json_safe(getattr(payload, "action", None))},
                })

            elif pt == "ItemGuardianApprovalReviewCompletedNotification":
                rid = getattr(payload, "review_id", None) or "guardian"
                review = getattr(payload, "review", None)
                out.append({
                    "event": "tool_result", "tool_use_id": rid,
                    "content": self._stringify(self._json_safe(review)),
                    "is_error": str(_enum_val(getattr(review, "status", ""))) in ("denied", "failed"),
                })
                status = str(_enum_val(getattr(review, "status", "")))
                if status == "denied":
                    self._guardian_denials.append({
                        "review_id": str(rid),
                        "action": self._json_safe(getattr(payload, "action", None)),
                        "rationale": getattr(review, "rationale", None),
                        "risk_level": _enum_val(getattr(review, "risk_level", None)),
                        "event": self._json_safe(payload),
                    })
                    self._guardian_denials = self._guardian_denials[-10:]

            elif pt == "GuardianWarningNotification":
                out.append({"event": "thinking", "text": f"Auto-review: {getattr(payload, 'message', '')}"})

            elif pt == "HookStartedNotification":
                run = getattr(payload, "run", None)
                rid = getattr(run, "id", None) or "hook"
                out.append({
                    "event": "tool_use", "id": rid, "name": "codex_hook",
                    "input": self._json_safe(run),
                })

            elif pt == "HookCompletedNotification":
                run = getattr(payload, "run", None)
                rid = getattr(run, "id", None) or "hook"
                status = str(_enum_val(getattr(run, "status", "")))
                out.append({
                    "event": "tool_result", "tool_use_id": rid,
                    "content": self._stringify(self._json_safe(run)),
                    "is_error": status in ("failed", "error"),
                })

            elif pt == "McpToolCallProgressNotification":
                item_id = getattr(payload, "item_id", "") or ""
                message = getattr(payload, "message", "") or ""
                if item_id and message:
                    out.append({"event": "tool_progress", "tool_use_id": item_id, "delta": message + "\n"})

            elif pt == "TerminalInteractionNotification":
                item_id = getattr(payload, "item_id", "") or ""
                stdin = getattr(payload, "stdin", "") or ""
                if item_id and stdin:
                    out.append({"event": "tool_progress", "tool_use_id": item_id, "delta": stdin})

            elif pt == "ThreadGoalUpdatedNotification":
                out.append({
                    "event": "tool_activity", "kind": "goal",
                    "id": getattr(payload, "thread_id", None) or "goal",
                    "status": "updated", "detail": self._json_safe(getattr(payload, "goal", None)),
                })

            elif pt == "TurnCompletedNotification":
                turn = getattr(payload, "turn", None)
                status = getattr(turn, "status", None)
                status = getattr(status, "value", status)
                # Final usage
                final = dict(self._last_usage or {"output_tokens": 0, "input_tokens": 0})
                final["final"] = True
                dm = getattr(turn, "duration_ms", None)
                if isinstance(dm, (int, float)):
                    final["duration_ms"] = int(dm)
                out.append({"event": "usage", **final})
                if str(status) == "failed":
                    err = getattr(turn, "error", None)
                    msg = getattr(err, "message", None) or "turn failed"
                    out.append({"event": "error", "msg": str(msg)})
                subtype = "interrupted" if str(status) == "interrupted" else (
                    "error" if str(status) == "failed" else "")
                out.append({"event": "stop", "subtype": subtype})

            elif pt == "ErrorNotification":
                err = getattr(payload, "error", None)
                will_retry = bool(getattr(payload, "will_retry", False))
                msg = getattr(err, "message", None) or (err if isinstance(err, str) else str(err))
                out.append({"event": "error", "msg": str(msg), "fatal": not will_retry})

            elif pt not in (
                "TurnStartedNotification", "ReasoningSummaryPartAddedNotification",
                "ThreadStartedNotification", "TurnModerationMetadataNotification",
            ):
                # SDK upgrades must not silently black-hole newly introduced
                # notification classes. Keep the wire quiet, but leave an
                # actionable breadcrumb in the daemon log.
                print(f"codex: unhandled notification {pt}", file=sys.stderr)
        except Exception as e:
            out.append({"event": "error", "msg": f"translate: {type(e).__name__}: {e}"})
        return out

    @staticmethod
    def _split_turn_diff(diff: str) -> list[tuple[str, str]]:
        """Split a cumulative git-style turn diff into per-file patches."""
        if not diff:
            return []
        starts = list(re.finditer(r"(?m)^diff --git a/(.+?) b/(.+?)$", diff))
        if not starts:
            return []
        out: list[tuple[str, str]] = []
        for i, match in enumerate(starts):
            end = starts[i + 1].start() if i + 1 < len(starts) else len(diff)
            out.append((match.group(2), diff[match.start():end].rstrip()))
        return out

    def _on_item(self, item_wrapper: Any, *, phase: str, out: list[dict[str, Any]]) -> None:
        """Handle ItemStarted/ItemCompleted. `item_wrapper` is a ThreadItem
        RootModel; the concrete item is `.root`."""
        if item_wrapper is None:
            return
        item = getattr(item_wrapper, "root", item_wrapper)
        it = type(item).__name__
        item_id = getattr(item, "id", "") or ""

        if it == "CommandExecutionThreadItem":
            if phase == "started":
                out.append({
                    "event": "tool_use", "id": item_id, "name": "shell",
                    "input": {"command": self._json_safe(getattr(item, "command", "")),
                              "cwd": self._path_str(getattr(item, "cwd", None))},
                })
            else:
                exit_code = getattr(item, "exit_code", None)
                status = str(getattr(getattr(item, "status", None), "value",
                                     getattr(item, "status", "")))
                is_error = status in ("failed", "declined") or (
                    isinstance(exit_code, int) and exit_code != 0)
                out.append({
                    "event": "tool_result", "tool_use_id": item_id,
                    "content": getattr(item, "aggregated_output", "") or "",
                    "is_error": bool(is_error),
                })

        elif it == "FileChangeThreadItem":
            changes = getattr(item, "changes", None) or []
            if phase == "started":
                paths = [self._path_str(getattr(c, "path", "")) for c in changes]
                out.append({
                    "event": "tool_use", "id": item_id, "name": "apply_patch",
                    "input": {"paths": paths},
                })
            else:
                status = str(getattr(getattr(item, "status", None), "value",
                                     getattr(item, "status", "")))
                # Combined unified diff → tool_result content (always visible).
                blocks = []
                for c in changes:
                    path = self._path_str(getattr(c, "path", "")) or ""
                    kind = getattr(getattr(c, "kind", None), "root", getattr(c, "kind", ""))
                    kind = getattr(kind, "type", kind)
                    diff = getattr(c, "diff", "") or ""
                    blocks.append(f"### {kind} {path}\n{diff}")
                    # Also surface a per-file diff snapshot for the diff viewer.
                    out.append({
                        "event": "edit_snapshot", "phase": "diff",
                        "tool_use_id": item_id, "file_path": path,
                        "content": None, "diff": diff[:256 * 1024],
                        "size": len(diff), "truncated": len(diff) > 256 * 1024,
                    })
                out.append({
                    "event": "tool_result", "tool_use_id": item_id,
                    "content": "\n\n".join(blocks) if blocks else "(no changes)",
                    "is_error": status == "failed",
                })

        elif it == "McpToolCallThreadItem":
            if phase == "started":
                out.append({
                    "event": "tool_use", "id": item_id,
                    "name": f"{getattr(item, 'server', '')}/{getattr(item, 'tool', '')}".strip("/"),
                    "input": self._json_safe(getattr(item, "arguments", {}) or {}),
                })
            else:
                err = getattr(item, "error", None)
                result = getattr(item, "result", None)
                content = ""
                if err is not None:
                    content = getattr(err, "message", None) or str(err)
                elif result is not None:
                    content = self._stringify(getattr(result, "content", result))
                out.append({
                    "event": "tool_result", "tool_use_id": item_id,
                    "content": content, "is_error": err is not None,
                })

        elif it == "ImageViewThreadItem":
            # Codex's built-in `view_image` tool: it loaded a local image into
            # the conversation and can now actually SEE it.
            #
            # This is the whole Codex half of the file-attachment feature (a
            # dropped screenshot is uploaded to <cwd>/.charon-uploads/ and its
            # path written into the prompt; Codex picks it up with this tool —
            # Claude's equivalent is `Read`). Without this branch the item fell
            # through to the ignore bucket, so the model would answer *about* an
            # image with nothing in the transcript showing it had ever looked —
            # indistinguishable from a hallucination, and the ToolPanel stayed
            # empty. Verified live: with the tool, Codex transcribes the image
            # exactly; when it instead shells out to `tesseract` (its fallback
            # when the path is wrong) it gets the text subtly WRONG, so telling
            # the two apart in the UI genuinely matters.
            #
            # `path` is a pydantic RootModel — coerce through _path_str, never
            # emit it raw (§14.59: emit only JSON-native data).
            path = self._path_str(getattr(item, "path", None))
            if phase == "started":
                out.append({
                    "event": "tool_use", "id": item_id, "name": "view_image",
                    "input": {"path": path},
                })
            else:
                out.append({
                    "event": "tool_result", "tool_use_id": item_id,
                    "content": path or "(image loaded)", "is_error": False,
                })

        elif it == "WebSearchThreadItem":
            if phase == "started":
                out.append({
                    "event": "tool_use", "id": item_id, "name": "web_search",
                    "input": {"query": getattr(item, "query", "")},
                })
            else:
                out.append({
                    "event": "tool_result", "tool_use_id": item_id,
                    "content": str(getattr(item, "query", "") or ""), "is_error": False,
                })

        elif it == "AgentMessageThreadItem":
            # If NO delta streamed for this item, emit the full text now so we
            # never drop the assistant message (some models/paths may not
            # stream token deltas).
            if phase == "completed" and item_id not in self._streamed_items:
                text = getattr(item, "text", "") or ""
                if text:
                    out.append({"event": "assistant_text", "delta": text})

        elif it == "ReasoningThreadItem":
            if phase == "completed" and item_id not in self._streamed_items:
                content = getattr(item, "content", None)
                text = self._stringify(content)
                if text:
                    out.append({"event": "thinking", "text": text})

        elif it == "SubAgentActivityThreadItem":
            kind = str(getattr(getattr(item, "kind", None), "value",
                               getattr(item, "kind", "")))
            bg_kind = {"started": "started", "interacted": "updated",
                       "interrupted": "finished"}.get(kind, "updated")
            out.append({
                "event": "bg_task", "kind": bg_kind,
                "task_id": getattr(item, "agent_thread_id", None) or item_id,
                "description": getattr(item, "agent_path", None) or "sub-agent",
                "task_type": "codex_subagent",
            })

        elif it == "PlanThreadItem":
            # A free-form plan message; surface as assistant text on completion.
            if phase == "completed":
                text = getattr(item, "text", "") or ""
                if text:
                    out.append({"event": "assistant_text", "delta": text})

        elif it == "UserMessageThreadItem":
            # Live user input is already durably written by the hub before
            # send_input. Keep the item understood (and available to thread
            # readers/importers) without echoing a duplicate chat bubble.
            return

        elif it == "DynamicToolCallThreadItem":
            name = str(getattr(item, "tool", "dynamic_tool") or "dynamic_tool")
            namespace = getattr(item, "namespace", None)
            if namespace:
                name = f"{namespace}/{name}"
            if phase == "started":
                out.append({
                    "event": "tool_use", "id": item_id, "name": name,
                    "input": self._json_safe(getattr(item, "arguments", None)),
                })
            else:
                success = getattr(item, "success", None)
                content = self._stringify(self._json_safe(
                    getattr(item, "content_items", None) or []
                ))
                out.append({
                    "event": "tool_result", "tool_use_id": item_id,
                    "content": content, "is_error": success is False,
                })

        elif it == "CollabAgentToolCallThreadItem":
            tool = str(_enum_val(getattr(item, "tool", "collab_agent")))
            receivers = list(getattr(item, "receiver_thread_ids", None) or [])
            states = self._json_safe(getattr(item, "agents_states", None) or {})
            if phase == "started":
                out.append({
                    "event": "tool_use", "id": item_id, "name": f"agents/{tool}",
                    "input": {
                        "sender": getattr(item, "sender_thread_id", None),
                        "receivers": receivers, "prompt": getattr(item, "prompt", None),
                        "model": getattr(item, "model", None),
                    },
                })
                for receiver in receivers:
                    out.append({
                        "event": "bg_task", "kind": "started", "task_id": receiver,
                        "description": f"Codex agent {receiver}", "tool_use_id": item_id,
                        "task_type": "codex_collab",
                    })
            else:
                status = str(_enum_val(getattr(item, "status", "")))
                out.append({
                    "event": "tool_result", "tool_use_id": item_id,
                    "content": self._stringify(states),
                    "is_error": status in ("failed", "error", "cancelled"),
                })
                for receiver in receivers:
                    state = states.get(receiver, {}) if isinstance(states, dict) else {}
                    out.append({
                        "event": "bg_task", "kind": "finished", "task_id": receiver,
                        "description": f"Codex agent {receiver}",
                        "status": str(state.get("status", status)) if isinstance(state, dict) else status,
                        "summary": str(state.get("message", "")) if isinstance(state, dict) else "",
                        "task_type": "codex_collab", "terminal": True,
                    })

        elif it == "ImageGenerationThreadItem":
            if phase == "started":
                out.append({
                    "event": "tool_use", "id": item_id, "name": "image_generation",
                    "input": {"prompt": getattr(item, "revised_prompt", None)},
                })
            else:
                path = self._path_str(getattr(item, "saved_path", None))
                result = getattr(item, "result", "") or ""
                out.append({
                    "event": "tool_result", "tool_use_id": item_id,
                    "content": path or str(result),
                    "is_error": str(getattr(item, "status", "")) in ("failed", "error"),
                })

        elif it in ("EnteredReviewModeThreadItem", "ExitedReviewModeThreadItem"):
            if phase == "completed":
                entered = it == "EnteredReviewModeThreadItem"
                out.append({
                    "event": "tool_activity", "kind": "review",
                    "id": item_id or "review", "status": "entered" if entered else "exited",
                    "detail": {"review": getattr(item, "review", "")},
                })

        elif it == "SleepThreadItem":
            if phase == "completed":
                duration = int(getattr(item, "duration_ms", 0) or 0)
                out.append({
                    "event": "tool_activity", "kind": "sleep", "id": item_id or "sleep",
                    "status": "completed", "detail": {"duration_ms": duration},
                })

        elif it == "HookPromptThreadItem":
            if phase == "completed":
                fragments = getattr(item, "fragments", None) or []
                text = "\n".join(
                    str(getattr(fragment, "text", "") or "") for fragment in fragments
                    if getattr(fragment, "text", None)
                )
                out.append({
                    "event": "tool_activity", "kind": "hook_prompt",
                    "id": item_id or "hook-prompt", "status": "injected",
                    "detail": {"text": text},
                })

        elif phase == "completed":
            print(f"codex: unhandled thread item {it}", file=sys.stderr)

    @staticmethod
    def _path_str(v: Any) -> str | None:
        """Codex path fields (cwd, change.path) are pydantic RootModel wrappers
        (e.g. LegacyAppPathString) — unwrap to a plain string."""
        if v is None:
            return None
        root = getattr(v, "root", None)
        if root is not None and not isinstance(root, (str, int, float, bool)):
            root = getattr(root, "root", root)
        return str(root if root is not None else v)

    @staticmethod
    def _json_safe(v: Any) -> Any:
        """Coerce a value to JSON-native types (pydantic models → dict, enums →
        value) so it can go into the durable event log."""
        if v is None or isinstance(v, (str, int, float, bool)):
            return v
        dump = getattr(v, "model_dump", None)
        if callable(dump):
            try:
                return dump(mode="json")
            except Exception:
                try:
                    return dump()
                except Exception:
                    return str(v)
        if isinstance(v, dict):
            return {str(k): CodexSession._json_safe(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [CodexSession._json_safe(x) for x in v]
        return getattr(v, "value", str(v))

    @staticmethod
    def _stringify(v: Any) -> str:
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, list):
            parts = []
            for b in v:
                t = getattr(b, "text", None)
                if isinstance(t, str):
                    parts.append(t)
                elif isinstance(b, dict):
                    parts.append(b.get("text", json.dumps(b, default=str)))
                else:
                    parts.append(str(b))
            return "".join(parts)
        try:
            return json.dumps(v, default=str)
        except Exception:
            return str(v)

    @staticmethod
    def _usage_from(tu: Any) -> dict[str, int] | None:
        if tu is None:
            return None
        # Prefer the current-turn breakdown (`last`); fall back to `total`.
        b = getattr(tu, "last", None) or getattr(tu, "total", None)
        if b is None:
            return None
        out_tok = getattr(b, "output_tokens", None)
        in_tok = getattr(b, "input_tokens", None)
        if out_tok is None and in_tok is None:
            return None
        u = {"output_tokens": int(out_tok or 0), "input_tokens": int(in_tok or 0)}
        cached = getattr(b, "cached_input_tokens", None)
        if isinstance(cached, (int, float)):
            u["cache_read_tokens"] = int(cached)
        return u

    # ── Main loop ────────────────────────────────────────────────────────────
    async def _consume_global_notifications(self) -> None:
        """Drain notifications that are deliberately not routed to a turn.

        AsyncTurnHandle.stream() owns turn-scoped events. The SDK router puts
        account, thread-status, MCP, skills and fs notifications in a separate
        FIFO; leaving it unread made those supported signals disappear and let
        the queue grow for the lifetime of the session.
        """
        raw = getattr(self._client, "_client", None)
        next_notification = getattr(raw, "next_notification", None)
        if not callable(next_notification):
            print("codex: SDK has no global notification consumer", file=sys.stderr)
            return
        try:
            while True:
                note = await next_notification()
                payload = getattr(note, "payload", note)
                thread_id = getattr(payload, "thread_id", None)
                if thread_id and self.claude_session_id and thread_id != self.claude_session_id:
                    continue
                for event in self._translate(payload):
                    self._emit_to_server({"session_id": self.session_id, **event})
                if type(payload).__name__ == "ThreadStatusChangedNotification":
                    status = getattr(payload, "status", None)
                    status = getattr(status, "root", status)
                    status_type = getattr(status, "type", status)
                    status_type = str(getattr(status_type, "value", status_type) or "")
                    if status_type == "active":
                        self._schedule_external_turn_probe()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # Closing the SDK wakes the blocking FIFO with a transport error.
            # It is diagnostic only; the owning _run task decides lifecycle.
            if self._client is not None:
                print(f"codex: global notification reader stopped: {e}", file=sys.stderr)

    async def _start_fs_watch(self) -> None:
        """Watch the session cwd so app-server pushes precise invalidations.

        Charon's editor already has a stat-poll safety net; this supplies the
        immediate signal and exercises the supported fs/watch lifecycle. Old
        app-servers simply return -32601 and continue normally.
        """
        if self._client is None:
            return
        raw = getattr(self._client, "_client", None)
        request = getattr(raw, "request", None)
        if not callable(request):
            return  # lightweight test double / old SDK
        try:
            from openai_codex.generated.v2_all import FsWatchResponse
            watch_id = f"charon-{self.session_id}"
            await request(
                "fs/watch", {"watchId": watch_id, "path": self.cwd},
                response_model=FsWatchResponse,
            )
            self._fs_watch_id = watch_id
        except Exception as e:
            if getattr(e, "code", None) != -32601:
                print(f"codex: fs/watch unavailable: {e}", file=sys.stderr)

    async def _stop_fs_watch(self) -> None:
        watch_id = self._fs_watch_id
        self._fs_watch_id = None
        if not watch_id or self._client is None:
            return
        raw = getattr(self._client, "_client", None)
        request = getattr(raw, "request", None)
        if not callable(request):
            return
        try:
            from openai_codex.generated.v2_all import FsUnwatchResponse
            await request(
                "fs/unwatch", {"watchId": watch_id}, response_model=FsUnwatchResponse,
            )
        except Exception:
            pass

    async def _run(self) -> None:
        try:
            self._loop = asyncio.get_running_loop()
            client = AsyncCodex(self._session_sdk_config())
            # Install before start(): app-server may issue a server request as
            # soon as initialization completes.
            if hasattr(client, "_client"):
                client._client._sync._approval_handler = self._sdk_approval_handler
                await self._initialize_sdk(client)
            self._client = client
        except Exception as e:
            self.status = "error"
            self._error_msg = f"AsyncCodex init: {e}"
            self._emit("error", msg=self._error_msg, fatal=True)
            self._emit("status", status="error")
            await self._save_state()
            return

        try:
            thread = None
            resuming_known_thread = bool(self.claude_session_id)
            if self.claude_session_id:
                # ── Resuming a KNOWN thread ──────────────────────────────────
                # NEVER silently fall back to thread_start() here. The thread id
                # IS the conversation: a fresh thread gets a NEW id which then
                # overwrites self.claude_session_id below and is persisted, so a
                # single transient hiccup (app-server still booting, codex
                # logged out, cwd temporarily missing) would destroy the resume
                # handle permanently — the user keeps a session that silently
                # lost all its context, with only one `error` line as evidence.
                # Retry only typed transient transport/overload failures, then
                # fail LOUDLY and keep the id. Invalid params, auth and missing
                # threads must not incur a blind 1.5-second retry.
                last_err: Exception | None = None
                for attempt in (1, 2, 3):
                    try:
                        thread = await self._sdk_thread_start(client, resume=True)
                        last_err = None
                        break
                    except Exception as e:
                        last_err = e
                        thread = None
                        retryable = bool(is_retryable_error(e)) or isinstance(
                            e, TransportClosedError
                        )
                        if not retryable or attempt == 3:
                            break
                        await asyncio.sleep(0.5 * (2 ** (attempt - 1)))
                if last_err is not None:
                    self.status = "error"
                    self._error_msg = (
                        f"resume of Codex thread {self.claude_session_id} failed: "
                        f"{self._format_err('resume', last_err)}"
                    )
                    self._emit("error", msg=self._error_msg, fatal=True)
                    self._emit("status", status="error")
                    self._ready_evt.set()   # unblock any waiter, else it hangs
                    return                  # _run's finally closes + persists
            if thread is None:
                thread = await self._sdk_thread_start(client, resume=False)
            self._thread = thread

            tid = getattr(thread, "id", None)
            if tid and not self._session_id_emitted:
                self.claude_session_id = tid
                self._emit("session_id", claude_session_id=tid)
                self._session_id_emitted = True
                asyncio.create_task(self._save_state())

            self.status = "active"
            self._emit("ready")
            self._emit("mode_changed", mode=self.permission_mode)
            self._emit("status", status="active")
            self._ready_evt.set()
            self._global_task = asyncio.create_task(
                self._consume_global_notifications(),
                name=f"codex-global-{self.session_id}",
            )
            # A goal/review may already own a physical turn before a RESUME.
            # A fresh thread cannot; probing it with includeTurns before its
            # first user message is invalid in app-server.
            if resuming_known_thread:
                self._schedule_external_turn_probe()
            await self._start_fs_watch()

            # ── Turn loop ─────────────────────────────────────────────────────
            while True:
                msg = await self._stdin_queue.get()
                if msg is None:
                    break
                if not isinstance(msg, dict) or msg.get("type") != "user_message":
                    continue
                content = msg.get("content") or ""
                turn_input = msg.get("codex_inputs") or content
                try:
                    if await self._attach_active_external_turn():
                        turn = self._active_turn
                        if turn is None:
                            raise RuntimeError("external Codex turn vanished before steer")
                        res = turn.steer(turn_input)
                        if asyncio.iscoroutine(res):
                            await res
                        continue
                except Exception as e:
                    # The active status can arrive just before thread/read
                    # exposes its turn. Retry the SAME input a few times; do
                    # not silently start another turn or drop what the user
                    # typed while the server-owned turn is still running.
                    retry = int(msg.get("_external_retry") or 0)
                    if retry < 5:
                        msg["_external_retry"] = retry + 1
                        await asyncio.sleep(0.1 * (retry + 1))
                        await self._stdin_queue.put(msg)
                        continue
                    self._emit("error", msg=f"could not join active Codex turn: {e}")
                    continue
                self._streamed_items.clear()
                self._last_usage = None
                # Announce the resolved model for this turn (effective_model).
                if self.model and self.model != self._effective_model:
                    self._effective_model = self.model
                    self._emit("effective_model", model=self.model)
                try:
                    self._starting_turn = True
                    handle = await self._sdk_turn(thread, turn_input)
                    self._active_turn = handle
                    self._starting_turn = False
                    self._begin_turn()
                    async for note in handle.stream():
                        payload = getattr(note, "payload", note)
                        await self._translate_and_emit(payload)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    self._emit("error", msg=self._format_err("turn", e))
                    # Make sure the turn is closed on the stop path.
                    self._emit("stop", subtype="error")
                finally:
                    self._starting_turn = False
                    self._active_turn = None
                self._end_turn()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.status = "error"
            self._error_msg = self._format_err("client", e)
            self._emit("error", msg=self._error_msg, fatal=True)
            self._emit("status", status="error")
        finally:
            me = asyncio.current_task()
            if self._main_task is None or self._main_task is me:
                await self._stop_fs_watch()
                global_task = self._global_task
                self._global_task = None
                if global_task is not None:
                    global_task.cancel()
                    await asyncio.gather(global_task, return_exceptions=True)
                background_task = getattr(self, "_background_monitor_task", None)
                self._background_monitor_task = None
                if background_task is not None and background_task is not me:
                    background_task.cancel()
                    await asyncio.gather(background_task, return_exceptions=True)
                self._background_terminals = {}
                try:
                    if self._client is not None:
                        res = self._client.close()
                        if asyncio.iscoroutine(res):
                            await asyncio.wait_for(res, timeout=5.0)
                except Exception:
                    pass
                self._client = None
                self._thread = None
                self._active_turn = None
                self._loop = None
                if self.status not in ("error", "killed", "sleeping"):
                    self.status = "sleeping"
                    self._emit("status", status="sleeping")
                await self._save_state()
