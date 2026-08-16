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

Permissions (THE incompatibility, see CLAUDE.md §14.59): the SDK exposes only
``ApprovalMode.auto_review`` (a server-side guardian sub-agent auto-decides
escalations) or ``ApprovalMode.deny_all`` — there is NO human-in-the-loop
approval callback like Claude's ``can_use_tool``. Charon's interactive
permission cards / exit-plan / alwaysAllow do NOT apply to Codex sessions; the
sandbox is the guardrail. We map Charon's per-session "mode" to Codex's sandbox
level + approval mode.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import time
import traceback
from typing import Any, Awaitable, Callable

try:
    from openai_codex import (
        AsyncCodex,
        CodexConfig,
        Sandbox,
        ApprovalMode,
    )
    from openai_codex.generated.v2_all import ReasoningEffort as _CodexEffort
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
    _CodexEffort = None  # type: ignore
    CODEX_AVAILABLE = False
    CODEX_IMPORT_ERROR = f"{type(e).__name__}: {e}"
    CODEX_SDK_VERSION = None


EmitCallback = Callable[[dict[str, Any]], None]
StateSaveCallback = Callable[[], Awaitable[None] | None]


# ── Charon per-session "mode" → Codex sandbox + approval ─────────────────────
# Codex has no interactive human approval, so a Charon "permission mode" for a
# Codex session picks a SANDBOX level. approval_mode stays auto_review (the
# guardian sub-agent auto-decides escalations within the sandbox) for the
# permissive modes, and deny_all for the read-only "safe" mode.
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


def _codex_cli_version() -> str | None:
    """Best-effort version of the bundled codex CLI binary."""
    try:
        from importlib.metadata import version as _pkg_version
        return _pkg_version("openai-codex-cli-bin")
    except Exception:
        return None


CODEX_CLI_VERSION = _codex_cli_version() if CODEX_AVAILABLE else None


def _enum_val(v: Any) -> Any:
    return getattr(v, "value", v)


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
        client = AsyncCodex(CodexConfig())
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
        client = AsyncCodex(CodexConfig())
        # account() primes the lazily-spawned app-server process AND yields the
        # plan type; the raw rate-limits request below needs the process live.
        acct = await client.account(refresh_token=False)
        plan = None
        a = getattr(acct, "account", None)
        root = getattr(a, "root", a)
        if root is not None:
            plan = getattr(root, "plan_type", None) or getattr(root, "planType", None)
        resp = await client._client.request(
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
                res = client.close()
                if asyncio.iscoroutine(res):
                    await asyncio.wait_for(res, timeout=5.0)
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
    ) -> None:
        self.session_id = session_id
        self.cwd = cwd
        self.name = name
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
        }
        self._emit_to_server = emit
        self._on_state_change = on_state_change

        self.status: str = "starting"
        self._client: Any = None            # AsyncCodex (non-None while running)
        self._thread: Any = None            # AsyncThread
        self._active_turn: Any = None       # AsyncTurnHandle (live turn)
        self._main_task: asyncio.Task | None = None
        self._stdin_queue: asyncio.Queue = asyncio.Queue()
        # Contract-parity attrs poked by server.py (resume_session):
        self._pending_perms: dict[str, asyncio.Future] = {}   # unused (no human gate)
        self._session_id_emitted = False
        self._stopped = asyncio.Event()
        self._ready_evt = asyncio.Event()
        self._error_msg: str | None = None

        # Translation state
        self._effective_model: str | None = None
        self._streamed_items: set[str] = set()   # item ids that got text deltas
        self._last_usage: dict[str, int] | None = None
        self._codex_stderr_lines: list[str] = []
        self._plan_deltas: dict[str, str] = {}

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
        old_task = self._main_task
        self._main_task = None
        self._client = None
        self._thread = None
        self._active_turn = None
        self._stopped.set()
        if old_task is not None and not old_task.done():
            old_task.cancel()  # fire-and-forget
        await self._save_state()

    async def send_input(self, content: str) -> None:
        if self.status not in ("active", "thinking", "starting"):
            raise RuntimeError(f"session {self.session_id} not running (status={self.status})")
        # Mid-turn: steer the live turn (parity with Claude's mid-turn query).
        turn = self._active_turn
        if turn is not None and self.status == "thinking":
            try:
                res = turn.steer(content)
                if asyncio.iscoroutine(res):
                    await res
                return
            except Exception as e:
                self._emit("error", msg=f"steer: {e}")
                # fall through to queue for the next turn
        await self._stdin_queue.put({"type": "user_message", "content": content})

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

    # No human-in-the-loop gates for Codex — these are no-ops kept for the
    # uniform server.py dispatch contract.
    def respond_permission(self, perm_id: str, allow: bool) -> None:
        fut = self._pending_perms.pop(perm_id, None)
        if fut is not None and not fut.done():
            fut.set_result(bool(allow))

    def respond_question(self, q_id: str, answers: dict | None) -> None:
        fut = self._pending_perms.pop(q_id, None)
        if fut is not None and not fut.done():
            fut.set_result(answers)

    def respond_exit_plan(self, q_id: str, decision: str, feedback: str = "") -> None:
        fut = self._pending_perms.pop(q_id, None)
        if fut is not None and not fut.done():
            fut.set_result({"decision": decision, "feedback": feedback})

    def to_info(self) -> dict[str, Any]:
        return {
            "kind": "codex",
            "session_id": self.session_id,
            "claude_session_id": self.claude_session_id,
            "cwd": self.cwd,
            "name": self.name,
            "permission_mode": self.permission_mode,
            "status": self.status,
            "model": self.model,
            "fallback_model": None,
            "effort": self.effort,
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
            "permission_mode": self.permission_mode,
            "status": persist_status,
            "model": self.model,
            "fallback_model": None,
            "effort": self.effort,
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
        }

    # ── Translate Codex notifications → Charon events ─────────────────────────
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
                    out.append({"event": "assistant_text", "delta": delta})

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
                u = self._usage_from(tu)
                if u is not None:
                    self._last_usage = u
                    out.append({"event": "usage", **u})

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
    async def _run(self) -> None:
        try:
            client = AsyncCodex(CodexConfig(
                cwd=self.cwd,
                config_overrides=tuple(self.codex_config.get("config_overrides") or ()),
                env=self.codex_config.get("env") or None,
                codex_bin=self.codex_config.get("codex_bin") or None,
            ))
            self._client = client
        except Exception as e:
            self.status = "error"
            self._error_msg = f"AsyncCodex init: {e}"
            self._emit("error", msg=self._error_msg, fatal=True)
            self._emit("status", status="error")
            await self._save_state()
            return

        sandbox, approval = _mode_to_sandbox_approval(self.permission_mode)
        start_kw: dict[str, Any] = {"cwd": self.cwd, "sandbox": sandbox,
                                    "approval_mode": approval}
        if self.model:
            start_kw["model"] = self.model
        for key in ("base_instructions", "developer_instructions", "personality",
                    "service_tier", "model_provider"):
            value = self.codex_config.get(key)
            if value is not None:
                start_kw[key] = value
        if self.codex_config.get("ephemeral"):
            start_kw["ephemeral"] = True

        try:
            thread = None
            if self.claude_session_id:
                # ── Resuming a KNOWN thread ──────────────────────────────────
                # NEVER silently fall back to thread_start() here. The thread id
                # IS the conversation: a fresh thread gets a NEW id which then
                # overwrites self.claude_session_id below and is persisted, so a
                # single transient hiccup (app-server still booting, codex
                # logged out, cwd temporarily missing) would destroy the resume
                # handle permanently — the user keeps a session that silently
                # lost all its context, with only one `error` line as evidence.
                # Retry once, then fail LOUDLY and keep the id so a later resume
                # can still succeed once the real cause is fixed.
                last_err: Exception | None = None
                for attempt in (1, 2):
                    try:
                        thread = await client.thread_resume(
                            self.claude_session_id, cwd=self.cwd,
                            approval_mode=approval, sandbox=sandbox,
                            **({"model": self.model} if self.model else {}),
                            **{k: v for k, v in start_kw.items()
                               if k in ("base_instructions", "developer_instructions", "personality",
                                        "service_tier", "model_provider")},
                        )
                        last_err = None
                        break
                    except Exception as e:
                        last_err = e
                        thread = None
                        if attempt == 1:
                            # Transient-failure grace: the app-server child is
                            # spawned lazily by the first RPC.
                            await asyncio.sleep(1.5)
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
                thread = await client.thread_start(**start_kw)
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

            # ── Turn loop ─────────────────────────────────────────────────────
            while True:
                msg = await self._stdin_queue.get()
                if msg is None:
                    break
                if not isinstance(msg, dict) or msg.get("type") != "user_message":
                    continue
                content = msg.get("content") or ""
                self._streamed_items.clear()
                self._last_usage = None
                self._begin_turn()
                # Announce the resolved model for this turn (effective_model).
                if self.model and self.model != self._effective_model:
                    self._effective_model = self.model
                    self._emit("effective_model", model=self.model)
                try:
                    handle = await thread.turn(content, **self._turn_overrides())
                    self._active_turn = handle
                    async for note in handle.stream():
                        payload = getattr(note, "payload", note)
                        for ev in self._translate(payload):
                            self._emit_to_server({"session_id": self.session_id, **ev})
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    self._emit("error", msg=self._format_err("turn", e))
                    # Make sure the turn is closed on the stop path.
                    self._emit("stop", subtype="error")
                finally:
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
                if self.status not in ("error", "killed", "sleeping"):
                    self.status = "sleeping"
                    self._emit("status", status="sleeping")
                await self._save_state()
