"""Cursor backend (`kind='cursor'`, §14.103).

The official SDK supplies persistent agents, per-turn usage, and runtime model
selection. It has no human approval callback, so safety is selected up front:
`plan`, `sandbox`, `agent`, or `force`. Sandbox and auto-review are construction
options; `_rebuild_agent_if_stale` resumes the same agent id before the next turn
when either changes. `claude_session_id` stores that Cursor agent id.
"""
from __future__ import annotations

import asyncio
import enum
import json
import traceback
from pathlib import Path
from typing import Any, Callable, Optional

from .cursor_runtime import (
    CURSOR_AVAILABLE,
    CURSOR_IMPORT_ERROR,
    CURSOR_SDK_VERSION,
    effective_api_key,
    legacy_store_config,
    require_sdk,
    state_root,
)

# `Agent.create` REQUIRES a model for a local agent, so a session with none
# configured still has to name one. `default` is the account's own choice —
# verified against a live catalog, unlike the plausible-looking `auto-smart`
# from the docs, which the backend rejects with `invalid_argument`. Pinning a
# concrete id here would age out instead; this one delegates.
DEFAULT_MODEL = "default"

# Charon's mode ladder → what the SDK actually receives. `mode` is the only
# knob the SDK calls a mode; the other two rungs are a sandbox flag and a
# per-send force, which is why this mapping exists in one place instead of
# being re-derived at each call site.
MODES: dict[str, dict[str, Any]] = {
    "plan":    {"sdk_mode": "plan",  "sandbox": False, "force": False, "auto_review": True},
    "sandbox": {"sdk_mode": "agent", "sandbox": True,  "force": False, "auto_review": True},
    "agent":   {"sdk_mode": "agent", "sandbox": False, "force": False, "auto_review": True},
    "force":   {"sdk_mode": "agent", "sandbox": False, "force": True,  "auto_review": False},
}
DEFAULT_MODE = "agent"


def _decode_params(query: str | None) -> dict[str, str]:
    """`effort=high&thinking=true` → a dict. Malformed pairs are skipped."""
    out: dict[str, str] = {}
    for chunk in (query or "").split("&"):
        key, sep, value = chunk.partition("=")
        key, value = key.strip(), value.strip()
        if sep and key and value:
            out[key] = value
    return out


def parse_model(spec: str | None, effort: str | None = None) -> Any:
    """Turn Charon's stored model + effort into an SDK `ModelSelection`.

    Cursor's reasoning knob is a per-model PARAMETER, not a global effort
    level, so a selection is a model id AND the values it was picked with. The
    two Charon columns carry that pair: `model` is the id, `effort` is the
    parameter set (`effort=high&thinking=true`).

    Parameters may also appear in a model-id `?…` suffix. The effort column
    wins duplicate keys; an empty set lets the SDK choose the default variant.
    """
    sdk = require_sdk()
    raw = (spec or "").strip() or DEFAULT_MODEL
    model_id, _, query = raw.partition("?")
    model_id = model_id.strip() or DEFAULT_MODEL
    params = _decode_params(query)
    params.update(_decode_params(effort))
    if not params:
        return model_id
    return sdk.ModelSelection(
        id=model_id,
        params=[sdk.ModelParameterValue(id=k, value=v) for k, v in sorted(params.items())],
    )


class CursorSession:
    kind = "cursor"

    def __init__(
        self,
        session_id: str,
        *,
        cwd: str,
        name: str | None,
        permission_mode: str,
        claude_session_id: str | None,
        emit: Callable[[dict[str, Any]], None],
        on_state_change: Callable[[], Any],
        model: str | None = None,
        fallback_model: str | None = None,
        effort: str | None = None,
        handle: str | None = None,
        peer_mcp: dict[str, Any] | None = None,
        session_config: dict[str, Any] | None = None,
    ) -> None:
        self.session_id = session_id
        self.cwd = cwd
        self.name = name
        self.handle = handle
        self.permission_mode = permission_mode if permission_mode in MODES else DEFAULT_MODE
        # The Cursor agent id. Named for the column it lands in, which predates
        # every backend but the first (§14.59).
        self.claude_session_id = claude_session_id
        self.model = model or None
        # No fallback model here — accepted and ignored so the common start/
        # resume path stays one shape for every provider. EFFORT is real: it
        # holds this model's parameter set (`effort=high&thinking=true`), which
        # is where Cursor puts what the others call a reasoning level.
        self.fallback_model = None
        self.effort = effort or None
        self.status = "starting"
        self.session_config = dict(session_config or {})
        self._peer_mcp = peer_mcp
        self._emit_to_server = emit
        self._on_state_change = on_state_change

        self._client: Any = None
        self._agent: Any = None
        self._run: Any = None
        self._main_task: Optional[asyncio.Task] = None
        self._stdin_queue: asyncio.Queue = asyncio.Queue()
        self._error_msg: Optional[str] = None
        # Shared lifecycle fields required by server.py and its contract test.
        self._stopped = asyncio.Event()
        self._ready_evt = asyncio.Event()
        self._session_id_emitted = False
        # Claude/Codex hold a client context and a mirrored CLI title; Cursor
        # has neither, but the attributes must EXIST because the shared rewind
        # path resets them by name.
        self._client_ctx: Any = None
        self._cli_title_value: Optional[str] = None
        self._effective_model: Optional[str] = None
        self._saw_text_delta = False
        self._active_peer_request_id: Optional[str] = None
        # Construction inputs the LIVE agent object was built with, so the turn
        # loop can tell a per-send change (model, mode) from one that needs the
        # agent rebuilt (the sandbox). See _construction_signature.
        self._agent_signature: Optional[str] = None

    # ── plumbing ────────────────────────────────────────────────────────────

    def _emit(self, event: str, **fields: Any) -> None:
        msg = {"event": event, "session_id": self.session_id}
        msg.update(fields)
        if self._active_peer_request_id:
            msg["_peer_request_id"] = self._active_peer_request_id
        try:
            self._emit_to_server(msg)
        except Exception:
            traceback.print_exc()

    async def _save_state(self) -> None:
        try:
            res = self._on_state_change()
            if asyncio.iscoroutine(res):
                await res
        except Exception:
            pass

    def _set_status(self, status: str) -> None:
        self.status = status
        self._emit("status", status=status)

    @staticmethod
    def _json_safe(value: Any, _depth: int = 0) -> Any:
        """Coerce SDK objects to JSON-native data.

        Same rule as Codex (§14.59): an event carrying a dataclass or a Path
        crashes the writer at broadcast time, far from here. Bounded depth so a
        self-referencing structure cannot hang the loop.
        """
        if _depth > 6:
            return "…"
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        # ⚠ Before `__dict__`: an Enum member's only attributes are `_name_` /
        # `_value_`, which the private-key filter below drops — so every status
        # and error CODE the SDK types as an enum serialised as `{}`.
        if isinstance(value, enum.Enum):
            return CursorSession._json_safe(value.value, _depth + 1)
        if isinstance(value, Path):
            return str(value)
        if isinstance(value, dict):
            return {str(k): CursorSession._json_safe(v, _depth + 1) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [CursorSession._json_safe(v, _depth + 1) for v in value]
        for attr in ("model_dump", "to_dict", "_asdict"):
            fn = getattr(value, attr, None)
            if callable(fn):
                try:
                    return CursorSession._json_safe(fn(), _depth + 1)
                except Exception:
                    break
        if hasattr(value, "__dict__"):
            return {
                str(k): CursorSession._json_safe(v, _depth + 1)
                for k, v in vars(value).items() if not str(k).startswith("_")
            }
        return str(value)

    # ── construction ────────────────────────────────────────────────────────

    def _mode_spec(self) -> dict[str, Any]:
        return MODES.get(self.permission_mode, MODES[DEFAULT_MODE])

    def _tool_lists(self) -> dict[str, Any]:
        """Built-in tool allow/deny lists.

        ⚠ These live on `AgentOptions`, NOT on `LocalAgentOptions` — that one is
        a frozen dataclass, so passing them there is a `TypeError` at
        construction, i.e. a session that cannot start at all the moment anyone
        configures a tool list.
        """
        cfg = self.session_config
        out: dict[str, Any] = {}
        tools = cfg.get("tools")
        if isinstance(tools, list) and tools:
            out["tools"] = [str(t) for t in tools]
        denied = cfg.get("disallowedTools")
        if isinstance(denied, list) and denied:
            out["disallowed_tools"] = [str(t) for t in denied]
        return out

    def _local_options(self) -> dict[str, Any]:
        sdk = require_sdk()
        spec = self._mode_spec()
        cfg = self.session_config
        auto_review = cfg.get("autoReview")
        if not isinstance(auto_review, bool):
            auto_review = spec["auto_review"]
        sources = cfg.get("settingSources")
        # No `store` override: only create/resume can carry one on the wire, so
        # a private store makes a session's conversation invisible to the import
        # list and to archive, which have no store field at all. The CWD selects
        # the SDK's own per-workspace store — see cursor_runtime.workspace_ref.
        opts: dict[str, Any] = {
            "cwd": self.cwd,
            "auto_review": bool(auto_review),
        }
        # ⚠ EXCEPT for an agent that predates that rule: it lives in the old
        # private JSONL store, and the default store has never heard of it, so
        # resuming without the override answers AgentNotFoundError and the
        # conversation reads as lost. The two store formats are JSONL vs a
        # private SQLite schema, so there is nothing to migrate — the old ones
        # are read where they are. Scoped to ids the legacy index really lists,
        # so a new agent never inherits the override.
        legacy = legacy_store_config(sdk, self.claude_session_id)
        if legacy is not None:
            opts["store"] = legacy
        if isinstance(sources, list):
            opts["setting_sources"] = [str(s) for s in sources if isinstance(s, str)]
        if spec["sandbox"]:
            opts["sandbox_options"] = sdk.SandboxOptions(enabled=True)
        return opts

    def _construction_signature(self) -> str:
        """Construction-only inputs for the live agent.

        Mode-derived sandbox and auto-review stay here so changing either
        rebuilds before the next prompt. Explicit config overrides still win.
        """
        spec = self._mode_spec()
        cfg = self.session_config
        return repr((
            bool(spec["sandbox"]),
            cfg.get("autoReview") if isinstance(cfg.get("autoReview"), bool) else spec["auto_review"],
            cfg.get("settingSources") if isinstance(cfg.get("settingSources"), list) else None,
            sorted(self._tool_lists().items()),
        ))

    def _mcp_servers(self) -> dict[str, Any] | None:
        """Charon's peer bus, passed INLINE.

        Inline rather than written into `~/.cursor/mcp.json`: that file belongs
        to the box's human (and its project twin is often committed to their
        repo), and a hub must not edit either to wire its own transport. The
        SDK takes the server per agent, which is exactly the scope we want.
        """
        if not self._peer_mcp:
            return None
        sdk = require_sdk()
        command = self._peer_mcp.get("command")
        args = self._peer_mcp.get("args") or []
        if not command:
            return None
        return {
            "charon_peer": sdk.StdioMcpServerConfig(
                command=str(command), args=[str(a) for a in args],
            ),
        }

    def _agent_options(self) -> Any:
        sdk = require_sdk()
        opts: dict[str, Any] = {
            "local": sdk.LocalAgentOptions(**self._local_options()),
            "mode": self._mode_spec()["sdk_mode"],
            # Required for a local agent, so never left to chance.
            "model": parse_model(self.model, self.effort),
            **self._tool_lists(),
        }
        key = effective_api_key()
        if key:
            opts["api_key"] = key
        if self.name:
            opts["name"] = self.name
        mcp = self._mcp_servers()
        if mcp:
            opts["mcp_servers"] = mcp
        return sdk.AgentOptions(**opts)

    # ── lifecycle ───────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._main_task is not None:
            return
        if not CURSOR_AVAILABLE:
            self.status = "error"
            self._error_msg = f"cursor-sdk not importable: {CURSOR_IMPORT_ERROR}"
            self._emit("error", msg=self._error_msg, fatal=True)
            self._emit("status", status="error")
            await self._save_state()
            return
        self._main_task = asyncio.create_task(self._run_loop(), name=f"cursor-{self.session_id}")

    async def _run_loop(self) -> None:
        sdk = require_sdk()
        try:
            self._client = await sdk.AsyncClient.launch_bridge(
                workspace=self.cwd,
                state_root=str(state_root()),
                timeout=60,
            )
        except Exception as e:
            await self._fail(f"could not start the Cursor runtime: {e}")
            return

        if not effective_api_key():
            # Say the useful thing before the SDK says the confusing one
            # (`ConfigurationError: missing_api_key`, which reads as a
            # misconfiguration rather than "click Sign in").
            await self._fail(
                "not signed in to Cursor on this VPS — use the Cursor sign-in link",
                auth=True,
            )
            return
        try:
            options = self._agent_options()
            if self.claude_session_id:
                # Resume preserves the provider conversation across restarts.
                self._agent = await sdk.AsyncAgent.resume(
                    self.claude_session_id, options, client=self._client,
                )
            else:
                self._agent = await sdk.AsyncAgent.create(options, client=self._client)
                agent_id = getattr(self._agent, "agent_id", None)
                if isinstance(agent_id, str) and agent_id:
                    self.claude_session_id = agent_id
                    if not self._session_id_emitted:
                        self._emit("session_id", claude_session_id=agent_id)
                        self._session_id_emitted = True
            self._agent_signature = self._construction_signature()
        except Exception as e:
            # An unauthenticated box reports a typed AuthenticationError; the
            # hub turns that into a provider Sign-in card (§14.68) rather than
            # a mystery failure.
            await self._fail(f"{type(e).__name__}: {e}", auth=_is_auth_error(e))
            return

        # Announce the model BEFORE the first turn: the per-message chip and the
        # header both read `effective_model`, and Cursor has no init frame that
        # reliably carries it. Without this the bubble says "assistant" with no
        # attribution at all, which on a hub running three backends is the one
        # thing a transcript must never be vague about.
        resolved = self.model or DEFAULT_MODEL
        if resolved != self._effective_model:
            self._effective_model = resolved
            self._emit("effective_model", model=resolved)
        self._set_status("active")
        self._ready_evt.set()
        self._emit("ready")
        await self._save_state()

        while True:
            item = await self._stdin_queue.get()
            if item is None:
                break
            try:
                await self._do_turn(item)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self._emit("error", msg=f"{type(e).__name__}: {e}",
                           fatal=_is_auth_error(e))
                self._emit("stop", subtype="error")
                if self.status not in ("sleeping", "killed"):
                    self._set_status("active")

    async def _fail(self, msg: str, *, auth: bool = False) -> None:
        # Release the gate first: a caller blocked on `_ready_evt` must learn
        # about the failure now, not after its own timeout.
        self._ready_evt.set()
        self.status = "error"
        self._error_msg = msg
        self._emit("error", msg=msg, fatal=True, **({"kind": "authentication"} if auth else {}))
        self._emit("status", status="error")
        await self._save_state()
        await self._close_client()

    async def _close_client(self) -> None:
        agent, client = self._agent, self._client
        self._agent = self._client = None
        for obj, meth in ((agent, "close"), (client, "aclose")):
            if obj is None:
                continue
            try:
                res = getattr(obj, meth)()
                if asyncio.iscoroutine(res):
                    await asyncio.wait_for(res, timeout=10.0)
            except Exception:
                pass

    async def stop(self, *, mark: str = "sleeping") -> None:
        self.status = mark
        self._emit("status", status=mark)
        self._stopped.set()
        await self._stdin_queue.put(None)
        if self._main_task is not None:
            try:
                await asyncio.wait_for(self._main_task, timeout=20.0)
            except Exception:
                self._main_task.cancel()
        self._main_task = None
        await self._close_client()
        await self._save_state()

    async def force_stop(self) -> None:
        """Cancel without waiting for the SDK to unwind.

        The session becomes resumable immediately; the cancelled task may keep
        living until the bridge returns, so `_close_client` runs after the
        cancellation rather than inside it.
        """
        self.status = "sleeping"
        self._emit("status", status="sleeping")
        self._stopped.set()
        run = self._run
        if run is not None:
            try:
                await asyncio.wait_for(run.cancel(), timeout=5.0)
            except Exception:
                pass
        if self._main_task is not None:
            self._main_task.cancel()
            self._main_task = None
        await self._close_client()
        await self._save_state()

    # ── turns ───────────────────────────────────────────────────────────────

    async def send_input(self, content: str, *, peer_request_id: str | None = None) -> None:
        if self.status not in ("active", "thinking", "starting"):
            raise RuntimeError(f"session {self.session_id} not running (status={self.status})")
        await self._stdin_queue.put({"content": content, "peer_request_id": peer_request_id})

    async def _rebuild_agent_if_stale(self) -> None:
        """Resume the same agent id when a construction option changes.

        Resume replaces the bridge's handle; closing the old Python handle would
        close the replacement too. A failure aborts the turn because the pending
        change may tighten tool access.
        """
        if self._agent is None or self._agent_signature == self._construction_signature():
            return
        if not self.claude_session_id or self._client is None:
            return
        sdk = require_sdk()
        options = self._agent_options()
        self._agent = await sdk.AsyncAgent.resume(
            self.claude_session_id, options, client=self._client,
        )
        self._agent_signature = self._construction_signature()

    def _send_options(self) -> dict[str, Any]:
        sdk = require_sdk()
        spec = self._mode_spec()
        options: dict[str, Any] = {
            "on_delta": self._on_delta,
            "mode": spec["sdk_mode"],
            # Clearing both fields must reset a previously explicit agent model.
            "model": parse_model(self.model, self.effort),
        }
        if spec["force"]:
            options["local"] = sdk.LocalSendOptions(force=True)
        return options

    async def _do_turn(self, item: dict[str, Any]) -> None:
        sdk = require_sdk()
        if self._agent is None:
            raise RuntimeError("session not running")
        self._active_peer_request_id = item.get("peer_request_id")
        self._saw_text_delta = False
        self._set_status("thinking")
        await self._rebuild_agent_if_stale()

        run = await self._agent.send(item["content"], sdk.SendOptions(**self._send_options()))
        self._run = run
        result: Any = None
        try:
            async for msg in run.stream():
                self._on_message(msg)
            result = await run.wait()
            self._on_result(result)
        finally:
            self._run = None
            self._active_peer_request_id = None
            if self.status == "thinking":
                self._set_status("active")
        # Billing lookup follows stop so it cannot delay turn completion.
        if result is not None:
            await self._emit_final_usage(result)

    def _on_delta(self, update: Any) -> None:
        """Live deltas. Sync by contract — the SDK calls it inline."""
        try:
            kind = getattr(update, "type", None) or (
                update.get("type") if isinstance(update, dict) else None)
            if kind == "text-delta":
                text = getattr(update, "text", None) or ""
                if text:
                    self._saw_text_delta = True
                    self._emit("assistant_text", delta=text)
            elif kind == "thinking-delta":
                text = getattr(update, "text", None) or ""
                if text:
                    self._emit("thinking", text=text)
        except Exception:
            traceback.print_exc()

    def _on_message(self, msg: Any) -> None:
        try:
            mtype = getattr(msg, "type", None) or (
                msg.get("type") if isinstance(msg, dict) else None)
            if mtype == "assistant":
                # The deltas already streamed this text; re-emitting it would
                # double the bubble. Only speak when no delta arrived (a
                # transport that skipped the callback).
                if self._saw_text_delta:
                    return
                content = getattr(msg, "message", None)
                text = _assistant_text(content)
                if text:
                    self._emit("assistant_text", delta=text)
            elif mtype == "tool_call":
                self._on_tool(msg)
            elif mtype == "usage":
                usage = self._json_safe(getattr(msg, "usage", None)) or {}
                self._emit_usage(usage, final=False)
            elif mtype == "system":
                model = getattr(msg, "model", None)
                model_id = getattr(model, "id", None) if model is not None else None
                if isinstance(model_id, str) and model_id and model_id != self._effective_model:
                    self._effective_model = model_id
                    self._emit("effective_model", model=model_id)
        except Exception:
            traceback.print_exc()

    def _on_tool(self, msg: Any) -> None:
        call_id = str(getattr(msg, "call_id", "") or "")
        name = str(getattr(msg, "name", "") or "tool")
        status = str(getattr(msg, "status", "") or "")
        if not call_id:
            return
        if status == "running":
            self._emit("tool_use", id=call_id, name=name,
                       input=self._json_safe(getattr(msg, "args", None)))
            return
        result = self._json_safe(getattr(msg, "result", None))
        if not isinstance(result, str):
            try:
                import json as _json
                result = _json.dumps(result, ensure_ascii=False)[:64_000]
            except Exception:
                result = str(result)[:64_000]
        self._emit("tool_result", tool_use_id=call_id, content=result,
                   is_error=status == "error")

    def _emit_usage(self, usage: dict[str, Any], *, final: bool, duration_ms: int | None = None,
                    cost_usd: float | None = None) -> None:
        payload: dict[str, Any] = {
            "output_tokens": int(usage.get("output_tokens") or 0),
            "input_tokens": int(usage.get("input_tokens") or 0),
            "cache_read_tokens": int(usage.get("cache_read_tokens") or 0),
            "cache_write_tokens": int(usage.get("cache_write_tokens") or 0),
        }
        if final:
            payload["final"] = True
        if duration_ms is not None:
            payload["duration_ms"] = duration_ms
        if cost_usd is not None:
            payload["cost_usd"] = cost_usd
        self._emit("usage", **payload)

    async def _turn_cost_usd(self) -> float | None:
        """Best-effort cost of the latest run, queried after turn completion.

        Use the last run's raw cost, then charged cost. The top-level total is
        cumulative and must not be persisted as another per-turn amount.
        """
        agent = self._agent
        if agent is None:
            return None
        try:
            usage = await asyncio.wait_for(agent.get_usage(), timeout=10.0)
        except Exception:
            return None
        runs = getattr(usage, "runs", None) or []
        cost = getattr(runs[-1], "cost", None) if runs else None
        if cost is None:
            # No per-run breakdown: report nothing rather than the cumulative
            # total, which the hub would add to every previous turn.
            return None
        for field in ("raw_cost_cents", "charged_cents"):
            cents = getattr(cost, field, None)
            if isinstance(cents, (int, float)) and cents > 0:
                return round(float(cents) / 100.0, 6)
        # A genuine zero (fully cached, or a free model) is still an answer.
        return 0.0

    async def _emit_final_usage(self, result: Any) -> None:
        """The one `final:true` usage frame, with its dollar figure attached.

        Exactly one per turn: the hub persists `final:true` as a single
        `turn_usage` row (§6), so a second frame would double the accounting.
        """
        try:
            usage = self._json_safe(getattr(result, "usage", None)) or {}
            if not usage:
                return
            self._emit_usage(usage, final=True,
                             duration_ms=getattr(result, "duration_ms", None),
                             cost_usd=await self._turn_cost_usd())
        except Exception:
            traceback.print_exc()

    def _on_result(self, result: Any) -> None:
        status = str(getattr(result, "status", "") or "")
        # The run reports which model actually answered — with `default` (or the
        # router) the configured id is a request, not the outcome. Emitting on
        # CHANGE only keeps the flush ordering rule of §6: earlier text is never
        # relabelled by a later switch.
        model = getattr(result, "model", None)
        model_id = getattr(model, "id", None) if model is not None else None
        if isinstance(model_id, str) and model_id and model_id != self._effective_model:
            self._effective_model = model_id
            self._emit("effective_model", model=model_id)
        if status == "error":
            # A failed TURN is not a broken SESSION (§14.68): report it as an
            # error stop and stay connected so the next prompt can recover.
            # RunResult exposes failed-run detail in `result`; cursor-sdk 1.x
            # has no `error` field on that type.
            detail = _error_text(self._json_safe(getattr(result, "result", None)))
            # A non-fatal `error` carries the human half: the hub reads it as
            # `pendingAgentError` and puts it in the durable blocking-error row,
            # instead of the generic "the turn ended with an API error".
            self._emit("error", msg=detail, fatal=False)
            # ⚠ `kind`, not `error`: the hub's contract is a typed kind string
            # (`types.ts § turn_error`), and it tests it with /auth/i to flag a
            # lapsed credential. Emitted under any other name, an expired Cursor
            # key never flipped `cursorLoggedIn=0` and no Sign-in card appeared.
            self._emit("turn_error", kind=_turn_error_kind(detail))
            self._emit("stop", subtype="error")
        elif status == "cancelled":
            self._emit("stop", subtype="cancelled")
        else:
            self._emit("stop")

    async def interrupt(self) -> None:
        run = self._run
        if run is None:
            return
        try:
            await run.cancel()
            self._emit("interrupted")
        except Exception as e:
            self._emit("error", msg=f"interrupt: {e}")

    # ── settings ────────────────────────────────────────────────────────────

    async def set_permission_mode(self, mode: str) -> None:
        if mode not in MODES:
            mode = DEFAULT_MODE
        self.permission_mode = mode
        # Applies to the NEXT turn, and that is a promise the turn loop keeps:
        # `mode` and `force` ride every send, while the SANDBOX is a
        # construction option — so `_rebuild_agent_if_stale` re-creates the
        # agent on the same id before the next prompt (§14.103). Announcing a
        # deferred change instead would be honest but useless: nothing in the
        # UI applies a pending MODE.
        self._emit("mode_changed", mode=mode, applied_at_next_start=False)
        await self._save_state()

    async def set_model(self, model: str | None, fallback_model: str | None = None) -> None:
        self.model = model or None
        # Sent with every turn, so a change lands on the next one — no restart,
        # unlike Claude's effort (§14.35).
        self._emit("model_changed", model=self.model, fallback_model=None,
                   applied_at_next_start=False)
        await self._save_state()

    async def set_effort(self, effort: str | None) -> None:
        self.effort = effort or None
        # Sent with every turn like the model, so a change lands on the next one
        # — no restart, unlike Claude's effort (§14.35).
        self._emit("effort_changed", effort=self.effort, applied_at_next_start=False)
        await self._save_state()

    async def apply_session_config(self, config: dict[str, Any] | None) -> dict[str, Any]:
        self.session_config = dict(config or {})
        await self._save_state()
        # Same mechanism as the mode: the next turn rebuilds the agent when a
        # construction option moved, so nothing waits for a restart.
        return {"ok": True, "applied_at_next_start": False}

    # ── interactions (none: see the module docstring) ───────────────────────

    def respond_permission(self, perm_id: str, allow: bool, always: bool = False) -> bool:
        return False

    def respond_question(self, q_id: str, answers: Any) -> bool:
        return False

    def respond_exit_plan(self, plan_id: str, approve: bool, mode: str | None = None) -> bool:
        return False

    # ── insight ─────────────────────────────────────────────────────────────

    def identity(self) -> dict[str, Any]:
        return {
            "ok": True,
            "name": self.name,
            "handle": self.handle,
            "cli_title": self.name,
            "native_id": self.claude_session_id,
        }

    # Archive/unarchive are NOT here: `cursor_archive_agent` is a box-level RPC
    # (the import tab archives conversations no session owns), so it lives in
    # `cursor_catalog` and runs on a short-lived bridge. A second copy on this
    # class would be a path nothing calls — and therefore nothing tests.

    # ── persistence ─────────────────────────────────────────────────────────

    def to_info(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "session_id": self.session_id,
            "claude_session_id": self.claude_session_id,
            "cwd": self.cwd,
            "name": self.name,
            "handle": self.handle,
            "permission_mode": self.permission_mode,
            "status": self.status,
            "model": self.model,
            "fallback_model": None,
            "effort": self.effort,
            "error": self._error_msg,
            "sdk_version": CURSOR_SDK_VERSION,
        }

    def to_persist(self) -> dict[str, Any]:
        status = self.status
        if status in ("starting", "thinking"):
            status = "active"
        return {
            "kind": self.kind,
            "session_id": self.session_id,
            "claude_session_id": self.claude_session_id,
            "cwd": self.cwd,
            "name": self.name,
            "handle": self.handle,
            "permission_mode": self.permission_mode,
            "status": status,
            "model": self.model,
            "fallback_model": None,
            "effort": self.effort,
            # ⚠ `provider_config` is the key `server.py` READS BACK at boot
            # (`_restore_existing` / `_register_sleeping`); written under any
            # other name the whole construction config — auto-review, the
            # settings scope, the deny list — silently reverted to defaults on
            # every daemon restart.
            "provider_config": self.session_config or None,
        }


def _assistant_text(content: Any) -> str:
    """Pull plain text out of an assistant message, whatever shape it takes."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    blocks = getattr(content, "content", None)
    if blocks is None and isinstance(content, dict):
        blocks = content.get("content")
    if isinstance(blocks, str):
        return blocks
    out: list[str] = []
    for block in blocks or []:
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
            text = block.get("text")
        if isinstance(text, str) and text:
            out.append(text)
    return "".join(out)


def _error_text(detail: Any) -> str:
    """One human sentence out of whatever shape the run reported."""
    if isinstance(detail, str) and detail.strip():
        return detail.strip()[:2000]
    if isinstance(detail, dict):
        for key in ("message", "error", "detail", "description"):
            value = detail.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:2000]
        try:
            return json.dumps(detail, ensure_ascii=False)[:2000]
        except Exception:
            pass
    if detail:
        return str(detail)[:2000]
    return "the run failed"


def _turn_error_kind(text: str) -> str:
    """The typed `kind` the hub classifies a failed turn on (§14.68).

    Only one value has to be exact: anything matching /auth/i makes the hub
    clear `cursorLoggedIn` and offer Sign in, which is the difference between
    "renew your key" and a session that keeps failing for no stated reason.
    """
    return "authentication_failed" if _is_auth_text(text) else "turn_failed"


def _is_auth_text(text: str) -> bool:
    lowered = text.lower()
    return any(s in lowered for s in (
        "unauthenticated", "unauthorized", "api key is required", "missing_api_key",
        "requires api_key", "invalid api key", "authenticationerror", "expired",
    ))


def _is_auth_error(exc: Exception) -> bool:
    """Is this the box not being signed in?

    Matched on the SDK's own typed class first; the message check is the
    fallback for an error raised before the typed layer (bridge startup).
    """
    if type(exc).__name__ == "AuthenticationError":
        return True
    text = str(exc).lower()
    # `missing_api_key` is the Python client refusing BEFORE the bridge: on this
    # path it means the box was never signed in, which is an auth problem the
    # user can fix, not a configuration bug they cannot.
    return any(s in text for s in (
        "unauthenticated", "api key is required", "missing_api_key", "requires api_key",
    ))
