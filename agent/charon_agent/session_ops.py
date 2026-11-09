"""Operations on ONE live session object, shared by the daemon and the runtime.

The daemon (`server.py`) owns everything that spans sessions: the durable
event log, subscribers, the peer ledger, handle uniqueness, `send_input`
idempotency. What acts on a single provider session lives here, so the same
code runs whether that session sits in the daemon itself (tests) or in a
session RUNTIME process (`runtime.py`, §14.117): the daemon forwards the
call by method name and the runtime answers it with this function.

`host` is whoever holds the session: it must provide `schedule_save()`.
Every public branch keeps the literal `if method == ...:` shape — the
protocol test scrapes those (with server.py's) against `protocol.METHODS`.
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
from pathlib import Path
from typing import Any

from .account_profiles import profile_id as _profile_id, sdk_call, config_dir
from .protocol import (
    ERR_INTERNAL,
    ERR_INVALID_PARAMS,
    ERR_METHOD_NOT_FOUND,
    ERR_SDK_UNAVAILABLE,
    RpcError,
)
from .providers import get_provider

PEER_HANDLE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
_PEER_HANDLE_RE = PEER_HANDLE_RE
_SPAWN_FIELD_MAX = 256


def profile_id(value: Any = None) -> str:
    try:
        return _profile_id(value)
    except ValueError as e:
        raise RpcError(ERR_INVALID_PARAMS, str(e)) from e


def row_parent(row: dict[str, Any], key: str) -> str | None:
    value = row.get(key)
    return value if isinstance(value, str) and 0 < len(value) <= _SPAWN_FIELD_MAX else None


def peer_mcp_config(session_id: str, socket_path: Any) -> dict[str, Any]:
    """Command both providers launch for the common peer MCP server.

    `sys.argv[0]` is the zipapp THIS process runs: in a runtime that is its
    frozen copy (`runtimes/<sha>.pyz`), never the live path an update replaces
    — a long-lived MCP child must not lazily import from a swapped archive."""
    entry = str(Path(sys.argv[0]).resolve())
    args = [entry] if entry.endswith(".pyz") else ["-m", "charon_agent"]
    args.extend(("--peer-mcp", session_id, "--socket", str(socket_path)))
    return {"command": sys.executable, "args": args}


def row_config(row: dict[str, Any]) -> dict[str, Any] | None:
    """A persisted row's provider config (`codex_config` = pre-registry rows)."""
    value = row.get("provider_config")
    if isinstance(value, dict):
        return value
    value = row.get("codex_config")
    return value if isinstance(value, dict) else None


def build_session(row: dict[str, Any], *, emit: Any, on_state_change: Any,
                  socket_path: Any) -> Any:
    """Construct (never start) a session object from a persisted row.

    Factory keyed on the agent-type discriminator, driven by the provider
    REGISTRY (providers.py): every backend shares the exact constructor
    signature + contract the driver uses; only its class and config kwarg
    differ. Adding a backend is one registry entry — never an edit here."""
    session_id = row["session_id"]
    spec = get_provider(row.get("kind") or "claude")
    cls = spec.session_class()
    handle = row.get("handle") or row.get("cli_name")
    kwargs: dict[str, Any] = dict(
        cwd=row["cwd"],
        name=row.get("name"),
        permission_mode=row.get("permission_mode") or "normal",
        claude_session_id=row.get("claude_session_id"),
        emit=emit,
        on_state_change=on_state_change,
        model=row.get("model"),
        fallback_model=row.get("fallback_model"),
        effort=row.get("effort"),
        handle=handle,
        peer_mcp=peer_mcp_config(session_id, socket_path),
    )
    kwargs[spec.config_kwarg] = row_config(row)
    s = cls(session_id, **kwargs)
    s.parent_session_id = row_parent(row, "parent_session_id")
    s.parent_handle = row_parent(row, "parent_handle")
    # Mirror Charon's stable handle to Claude's native START-time --name.
    # Codex uses the common MCP bus and simply has no cli_name attribute.
    cli_name = row.get("cli_name") or handle
    if cli_name and hasattr(s, "cli_name"):
        s.cli_name = cli_name
    return s


def live_task(s: Any) -> bool:
    task = getattr(s, "_main_task", None)
    return task is not None and not task.done()


def migration_blocker(s: Any) -> str | None:
    """Why stopping this session NOW would interrupt something, or None.

    Asked by the runtime at the instant it would stop the session for a
    hot-update move (§14.117), so nothing can slip in between the check and
    the stop: a turn, a gate a human may still answer, input not yet read."""
    if getattr(s, "status", None) != "active":
        return f"status {getattr(s, 'status', None)}"
    if getattr(s, "compacting", False) is True:
        return "compacting"
    if getattr(s, "_pending_perms", None):
        return "pending gate"
    queue = getattr(s, "_stdin_queue", None)
    try:
        if queue is not None and queue.qsize() > 0:
            return "queued input"
    except Exception:
        pass
    return None


def session_extras(s: Any) -> dict[str, Any]:
    """Live facts the daemon mirrors beside `to_info()` / `to_persist()`."""
    return {
        "compacting": getattr(s, "compacting", False) is True,
        "blocker": migration_blocker(s),
    }


#: Methods `run` answers. The daemon forwards exactly these to a runtime.
OPS = frozenset({
    "approve_codex_denial",
    "codex_fork_points",
    "codex_resources",
    "codex_security_status",
    "compact_session",
    "force_stop",
    "fork_session",
    "get_context_usage",
    "get_subagent_messages",
    "inject_history",
    "interrupt",
    "kill_session",
    "list_background_terminals",
    "list_subagents",
    "mcp_oauth_login",
    "mcp_reconnect",
    "mcp_status",
    "mcp_toggle",
    "respond_exit_plan",
    "respond_permission",
    "respond_question",
    "resume_session",
    "review_session",
    "rollback_session",
    "send_input",
    "session_identity",
    "session_resources",
    "set_codex_security",
    "set_codex_skill",
    "set_effort",
    "set_model",
    "set_permission_mode",
    "set_session_handle",
    "set_session_name",
    "sleep_session",
    "stop_background_terminal",
    "stop_bg_task",
})


#: Insight RPC → the session attribute that answers it. Used to degrade a
#: method a backend does not implement into an `unavailable` envelope
#: instead of an AttributeError (§14.103).
#:
#: ⚠ `unavailable`, NOT `unsupported`. The hub renders `unsupported` as
#: "needs a newer agent on this VPS" (§14.95) — true for a rollout lag,
#: a lie for a backend that will never have the method however new the
#: agent gets. Telling a user to update a box that is already current is
#: worse than saying nothing.
_SESSION_INSIGHT_ATTR = {
    "get_context_usage": "context_usage",
    "mcp_status": "mcp_status",
    "mcp_toggle": "mcp_toggle",
    "mcp_reconnect": "mcp_reconnect",
    "mcp_oauth_login": "mcp_oauth_login",
    "list_subagents": "subagents",
    "get_subagent_messages": "subagent_messages",
    "session_identity": "identity",
    # Missing from this map, `session_resources` reached `s_.resources()`
    # on a class that has none and surfaced the raw AttributeError
    # (-32603 "'CursorSession' object has no attribute 'resources'") in
    # the panel.
    "session_resources": "resources",
}

def insight_unavailable(session: Any, method: str) -> "dict[str, Any] | None":
    """The `unavailable` envelope when this backend has no such surface."""
    attr = _SESSION_INSIGHT_ATTR.get(method)
    if attr is None or callable(getattr(session, attr, None)):
        return None
    return {
        "ok": False, "reason": "unavailable",
        "error": f"{getattr(session, 'kind', 'this')} sessions do not support {method}",
    }


async def rewind_claude_session(host: Any, session: Any,
                                up_to_message_id: str | None) -> dict[str, Any]:
    """Replace one live Claude handle with a truncated native branch.

    Claude has no rollback primitive. Its supported transcript fork is the
    equivalent operation: branch at the last message we keep, stop the old
    writer, then restart this Charon session against the branch. With no
    anchor we restart fresh. The old transcript stays on disk and files are
    deliberately untouched.
    """
    old_id = getattr(session, "claude_session_id", None)
    if not isinstance(old_id, str) or not old_id:
        raise RpcError(ERR_INVALID_PARAMS, "session has no transcript to rewind")
    if getattr(session, "status", None) in ("thinking", "starting"):
        raise RpcError(ERR_INVALID_PARAMS, "cannot rewind while a Claude turn is running")

    new_id: str | None = None
    if up_to_message_id:
        try:
            from claude_agent_sdk import fork_session as _fork
            result = await asyncio.to_thread(
                sdk_call, getattr(session, "session_config", {}).get("accountProfile"), "fork_session", old_id, directory=getattr(session, "cwd", None),
                up_to_message_id=up_to_message_id,
                title=getattr(session, "name", None),
            )
        except FileNotFoundError as e:
            raise RpcError(ERR_INVALID_PARAMS, f"transcript not found: {e}")
        except ValueError as e:
            raise RpcError(ERR_INVALID_PARAMS, str(e))
        new_id = getattr(result, "session_id", None) or (
            result.get("session_id") if isinstance(result, dict) else None)
        if not isinstance(new_id, str) or not new_id:
            raise RpcError(ERR_INTERNAL, "Claude rewind fork returned no session id")

    # Release the old native writer before starting the replacement. A new
    # queue is intentional: stop() injects an EOF sentinel and a timeout
    # can leave stale input behind; neither may leak into the new history.
    await session.stop(mark="sleeping")
    session.claude_session_id = new_id
    session._stdin_queue = asyncio.Queue()
    session._stopped.clear()
    session._ready_evt.clear()
    session._session_id_emitted = False
    session._main_task = None
    session._client = None
    session._client_ctx = None
    session._cli_title_value = None
    session._error_msg = None
    session.status = "starting"
    if new_id:
        session._emit("session_id", claude_session_id=new_id)
    await session._save_state()
    await session.start()
    host.schedule_save()
    return {
        "ok": True,
        "strategy": "fork" if new_id else "fresh",
        "old_claude_session_id": old_id,
        "claude_session_id": new_id,
    }

async def run(method: str, params: dict[str, Any], session: Any, host: Any) -> Any:
    """Answer one session RPC against the live object `session`."""
    if method == "interrupt":
        s = session
        await s.interrupt()
        return {"ok": True}

    # NB: top-level branch on purpose - a dispatch nested under another
    # method's `if` is unreachable and the METHODS-vs-dispatch test cannot
    # see it (that shipped once, CLAUDE.md §14.89).
    if method == "stop_bg_task":
        s = session
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
        s = session
        mode = params.get("mode") or "normal"
        await s.set_permission_mode(mode)
        return {"ok": True, "mode": s.permission_mode}

    if method == "set_model":
        s = session
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
                  "mcp_reconnect", "mcp_oauth_login", "list_subagents", "get_subagent_messages",
                  "session_identity"):
        s_ = session
        # A backend implements the slice of this surface its runtime can
        # answer; anything it does not is reported as `reason:'unavailable'`
        # — an envelope the hub renders beside a chat rather than throwing
        # (§14.95). Probing the session object rather than testing its kind
        # is what lets a new provider (§14.103) implement one method at a
        # time instead of stubbing all nine.
        _missing = insight_unavailable(s_, method)
        if _missing is not None:
            return _missing
        # Codex now exposes context/status, identity and MCP inventory
        # through the SDK typed client. Sub-agent transcript browsing and
        # config mutation remain Claude-only.
        if getattr(s_, "kind", "claude") == "codex":
            if method == "session_identity":
                return s_.identity()
            if method == "get_context_usage":
                return await s_.context_usage()
            if method == "mcp_status":
                return await s_.mcp_status()
            if method == "mcp_reconnect":
                name = params.get("name")
                if not isinstance(name, str) or not name:
                    raise RpcError(ERR_INVALID_PARAMS, "name must be a non-empty string")
                return await s_.mcp_reconnect(name)
            if method == "mcp_oauth_login":
                name = params.get("name")
                if not isinstance(name, str) or not name:
                    raise RpcError(ERR_INVALID_PARAMS, "name must be a non-empty string")
                return await s_.mcp_oauth_login(name)
            if method == "list_subagents":
                return await s_.subagents()
            if method == "get_subagent_messages":
                agent_id = params.get("agent_id")
                if not isinstance(agent_id, str) or not agent_id:
                    raise RpcError(ERR_INVALID_PARAMS, "agent_id must be a non-empty string")
                limit = params.get("limit")
                return await s_.subagent_messages(
                    agent_id, int(limit) if isinstance(limit, int) else 400)
            return {"ok": False, "error": "not available on Codex sessions"}
        # The sync readers below may shell out (an isolated account
        # profile's SDK helpers, account_profiles.sdk_call): off the loop.
        if method == "session_identity":
            return await asyncio.to_thread(s_.identity)
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
        if method == "mcp_oauth_login":
            return {"ok": False, "error": "MCP OAuth login is Codex-only"}
        if method == "list_subagents":
            return await asyncio.to_thread(s_.subagents)
        # Explicit rather than a fall-through: the protocol test scans for
        # the literal `method == "..."`, and §14.89 is the incident where a
        # branch it could not see shipped unreachable.
        if method == "get_subagent_messages":
            agent_id = params.get("agent_id")
            if not isinstance(agent_id, str) or not agent_id:
                raise RpcError(ERR_INVALID_PARAMS, "agent_id must be a non-empty string")
            limit = params.get("limit")
            return await asyncio.to_thread(
                s_.subagent_messages, agent_id, int(limit) if isinstance(limit, int) else 400)
        raise RpcError(ERR_INTERNAL, f"unhandled: {method}")

    if method == "fork_session":
        # Branch a session's transcript into a NEW one, optionally cutting
        # at a message. Pure file work (the SDK copies the transcript and
        # remaps every uuid) — it does NOT touch the live session, so the
        # original keeps running untouched, which is the whole point.
        s_ = session
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
        if getattr(s_, "kind", "claude") == "codex":
            try:
                last_turn_id = params.get("last_turn_id")
                if last_turn_id is not None and not isinstance(last_turn_id, str):
                    raise RpcError(ERR_INVALID_PARAMS, "last_turn_id must be a string")
                return await s_.fork(title, last_turn_id)
            except Exception as e:
                raise RpcError(ERR_INTERNAL, f"Codex fork failed: {e}")
        try:
            from claude_agent_sdk import fork_session as _fork
        except Exception as e:
            raise RpcError(ERR_SDK_UNAVAILABLE,
                           f"this SDK cannot fork sessions: {e}")
        try:
            res = await asyncio.to_thread(sdk_call, getattr(s_, "session_config", {}).get("accountProfile"), "fork_session", csid, directory=getattr(s_, "cwd", None),
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
        source_profile = profile_id(getattr(s_, "session_config", {}).get("accountProfile"))
        target_profile = profile_id(params.get("account_profile", source_profile))
        if source_profile != target_profile:
            import shutil
            source_dir = config_dir("claude", source_profile)
            target_dir = config_dir("claude", target_profile)
            matches = list((source_dir / "projects").rglob(f"{new_id}.jsonl"))
            if len(matches) != 1:
                raise RpcError(ERR_INVALID_PARAMS, "Fork transcript could not be located in its account profile")
            transcript = matches[0]
            destination = target_dir / transcript.relative_to(source_dir)
            # Hub accounts LINK `projects` to the shared ~/.claude (§14.115):
            # the branch is already in the target home. Moving it there
            # would copy the file onto itself, then delete the only copy.
            if os.path.realpath(transcript) != os.path.realpath(destination):
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                await asyncio.to_thread(shutil.copy2, transcript, destination)
                child_dir = transcript.with_suffix("")
                if child_dir.is_dir():
                    await asyncio.to_thread(shutil.copytree, child_dir, destination.with_suffix(""), dirs_exist_ok=True)
                    await asyncio.to_thread(shutil.rmtree, child_dir)
                # This is the SDK-created branch, never the source transcript.
                # Leaving a copy in the old home would expose it under the
                # wrong account in native scans and legacy resume paths.
                await asyncio.to_thread(transcript.unlink)
        return {"ok": True, "claude_session_id": new_id, "forked_from": csid}

    if method == "codex_fork_points":
        s_ = session
        if getattr(s_, "kind", "claude") != "codex":
            return {"ok": False, "error": "Codex-only surface"}
        try:
            return await s_.fork_points()
        except Exception as e:
            if getattr(e, "code", None) == ERR_METHOD_NOT_FOUND:
                raise RpcError(ERR_METHOD_NOT_FOUND, str(e))
            raise RpcError(ERR_INTERNAL, f"Codex fork points failed: {e}")

    if method == "compact_session":
        s_ = session
        kind_ = getattr(s_, "kind", "claude")
        # Declared per backend (providers.py), never a kind ternary with a
        # Claude fallthrough: `/compact` sent to a provider that does not
        # know the command reaches the MODEL as a literal prompt.
        strategy = get_provider(kind_).compact
        if strategy is None:
            raise RpcError(ERR_INVALID_PARAMS,
                           f"{kind_} sessions cannot be compacted")
        if strategy == "native":
            try:
                return await s_.compact()
            except Exception as e:
                raise RpcError(ERR_INTERNAL, f"{kind_} compaction failed: {e}")
        # Claude's SDK has no compact() method; the CLI command travels
        # through the same query channel and emits the normal marker.
        await s_.send_input("/compact")
        return {"ok": True}

    if method == "rollback_session":
        s_ = session
        kind_ = getattr(s_, "kind", "claude")
        # ⚠ The fallthrough this replaces was DESTRUCTIVE, not merely wrong:
        # `_rewind_claude_session` clears `claude_session_id`, which for a
        # non-Claude backend is its only resume handle (§14.74).
        strategy = get_provider(kind_).rewind
        if strategy is None:
            raise RpcError(ERR_INVALID_PARAMS,
                           f"{kind_} sessions cannot be rewound")
        if strategy == "native":
            num_turns = params.get("num_turns")
            if not isinstance(num_turns, int) or isinstance(num_turns, bool) or not 1 <= num_turns <= 100:
                raise RpcError(ERR_INVALID_PARAMS, "num_turns must be an integer from 1 to 100")
            try:
                return await s_.rollback(num_turns)
            except Exception as e:
                if getattr(e, "code", None) == ERR_METHOD_NOT_FOUND:
                    raise RpcError(ERR_METHOD_NOT_FOUND, str(e))
                raise RpcError(ERR_INTERNAL, f"{kind_} rewind failed: {e}")
        up_to = params.get("up_to_message_id")
        if up_to is not None and (not isinstance(up_to, str) or not up_to):
            raise RpcError(ERR_INVALID_PARAMS, "up_to_message_id must be a non-empty string or null")
        return await rewind_claude_session(host, s_, up_to)

    if method == "review_session":
        s_ = session
        if getattr(s_, "kind", "claude") != "codex":
            raise RpcError(ERR_INVALID_PARAMS, "native review is only supported for Codex sessions")
        target = params.get("target")
        delivery = params.get("delivery", "inline")
        if not isinstance(target, dict) or target.get("type") not in (
            "uncommittedChanges", "baseBranch", "commit", "custom"
        ):
            raise RpcError(ERR_INVALID_PARAMS, "invalid review target")
        if delivery not in ("inline", "detached"):
            raise RpcError(ERR_INVALID_PARAMS, "delivery must be inline or detached")
        try:
            return await s_.review(target, delivery)
        except Exception as e:
            if getattr(e, "code", None) == ERR_METHOD_NOT_FOUND:
                raise RpcError(ERR_METHOD_NOT_FOUND, str(e))
            raise RpcError(ERR_INTERNAL, f"Codex review failed: {e}")

    if method == "codex_security_status":
        s_ = session
        if getattr(s_, "kind", "claude") != "codex":
            return {"ok": False, "error": "Codex-only surface"}
        return await s_.security_status(bool(params.get("force_reload")))

    if method == "set_codex_security":
        s_ = session
        if getattr(s_, "kind", "claude") != "codex":
            raise RpcError(ERR_INVALID_PARAMS, "Codex-only surface")
        reviewer = params.get("reviewer")
        profile = params.get("permission_profile")
        if reviewer not in ("user", "auto_review"):
            raise RpcError(ERR_INVALID_PARAMS, "reviewer must be user or auto_review")
        if profile is not None and not isinstance(profile, str):
            raise RpcError(ERR_INVALID_PARAMS, "permission_profile must be a string or null")
        try:
            return await s_.set_security(reviewer, profile)
        except ValueError as e:
            raise RpcError(ERR_INVALID_PARAMS, str(e))
        except Exception as e:
            if getattr(e, "code", None) == ERR_METHOD_NOT_FOUND:
                raise RpcError(ERR_METHOD_NOT_FOUND, str(e))
            raise RpcError(ERR_INTERNAL, f"Codex security update failed: {e}")

    if method == "approve_codex_denial":
        s_ = session
        review_id = params.get("review_id")
        if getattr(s_, "kind", "claude") != "codex":
            raise RpcError(ERR_INVALID_PARAMS, "Codex-only surface")
        if not isinstance(review_id, str) or not review_id:
            raise RpcError(ERR_INVALID_PARAMS, "review_id required")
        try:
            return await s_.approve_guardian_denial(review_id)
        except ValueError as e:
            raise RpcError(ERR_INVALID_PARAMS, str(e))
        except Exception as e:
            if getattr(e, "code", None) == ERR_METHOD_NOT_FOUND:
                raise RpcError(ERR_METHOD_NOT_FOUND, str(e))
            raise RpcError(ERR_INTERNAL, f"Guardian override failed: {e}")

    if method == "codex_resources":
        s_ = session
        if getattr(s_, "kind", "claude") != "codex":
            return {"ok": False, "error": "Codex-only surface"}
        try:
            return await s_.resources(bool(params.get("force_reload")))
        except Exception as e:
            if getattr(e, "code", None) == ERR_METHOD_NOT_FOUND:
                raise RpcError(ERR_METHOD_NOT_FOUND, str(e))
            raise RpcError(ERR_INTERNAL, f"Codex resources failed: {e}")

    if method == "session_resources":
        s_ = session
        _missing = insight_unavailable(s_, method)
        if _missing is not None:
            return _missing
        try:
            return await s_.resources(bool(params.get("force_reload")))
        except Exception as e:
            if getattr(e, "code", None) == ERR_METHOD_NOT_FOUND:
                raise RpcError(ERR_METHOD_NOT_FOUND, str(e))
            raise RpcError(ERR_INTERNAL, f"session resources failed: {e}")

    if method == "set_codex_skill":
        s_ = session
        path, enabled = params.get("path"), params.get("enabled")
        if getattr(s_, "kind", "claude") != "codex":
            raise RpcError(ERR_INVALID_PARAMS, "Codex-only surface")
        if not isinstance(path, str) or not path or not isinstance(enabled, bool):
            raise RpcError(ERR_INVALID_PARAMS, "path and enabled required")
        try:
            return await s_.set_skill_enabled(path, enabled)
        except Exception as e:
            if getattr(e, "code", None) == ERR_METHOD_NOT_FOUND:
                raise RpcError(ERR_METHOD_NOT_FOUND, str(e))
            raise RpcError(ERR_INTERNAL, f"Codex skill update failed: {e}")

    if method == "list_background_terminals":
        s_ = session
        if getattr(s_, "kind", "claude") != "codex":
            return {"ok": False, "error": "Codex-only surface"}
        return await s_.background_terminals()

    if method == "stop_background_terminal":
        s_ = session
        if getattr(s_, "kind", "claude") != "codex":
            raise RpcError(ERR_INVALID_PARAMS, "Codex-only surface")
        process_id = params.get("process_id")
        if not isinstance(process_id, str) or not process_id:
            raise RpcError(ERR_INVALID_PARAMS, "process_id required")
        try:
            return await s_.stop_background_terminal(process_id)
        except Exception as e:
            if getattr(e, "code", None) == ERR_METHOD_NOT_FOUND:
                raise RpcError(ERR_METHOD_NOT_FOUND, str(e))
            raise RpcError(ERR_INTERNAL, f"stop background terminal failed: {e}")

    if method == "inject_history":
        # Cross-provider fork primitive (agent >= 0.46.0).  Only Codex has
        # an app-server history-injection API; Claude uses fork_session's
        # native transcript copy instead.  The session method waits for a
        # freshly-started Codex thread to be loaded before injecting.
        s_ = session
        if getattr(s_, "kind", "claude") != "codex":
            raise RpcError(ERR_INVALID_PARAMS,
                           "inject_history is only supported for Codex sessions")
        items = params.get("items")
        if not isinstance(items, list) or not items:
            raise RpcError(ERR_INVALID_PARAMS, "items must be a non-empty list")
        try:
            return await s_.inject_history(items)
        except ValueError as e:
            raise RpcError(ERR_INVALID_PARAMS, str(e))
        except Exception as e:
            raise RpcError(ERR_INTERNAL, f"history import failed: {e}")

    if method == "set_session_name":
        s = session
        name = params.get("name")
        if not isinstance(name, str) or not name.strip():
            raise RpcError(ERR_INVALID_PARAMS, "name must be a non-empty string")
        s.name = name
        # Mirror the DISPLAY title into each provider's native transcript.
        # Peer routing uses `handle`, independently. Never fatal: the hub
        # keeps the display name either way.
        written = False
        fn = getattr(s, "write_cli_title", None)   # Claude sessions only
        if callable(fn):
            try:
                written = bool(fn(name))
            except Exception:
                written = False
        sdk_name = getattr(s, "set_session_name", None)
        if callable(sdk_name):
            try:
                written = bool(await sdk_name(name))
            except Exception:
                written = False
        # Record what actually landed. On failure the value stays stale, so
        # the turn-end comparison retries — that is the whole point of
        # tracking the value rather than a "done" flag.
        if written:
            s._cli_title_value = name
        return {"ok": True, "name": name, "cli_title": written}

    if method == "set_session_handle":
        s = session
        raw_handle = params.get("handle")
        handle = raw_handle.strip().lstrip("@").lower() if isinstance(raw_handle, str) else ""
        if not _PEER_HANDLE_RE.fullmatch(handle):
            raise RpcError(ERR_INVALID_PARAMS, "invalid session handle")
        s.handle = handle
        # Claude's native peer name remains useful outside Charon. It is a
        # start-time flag, so changing it here applies at the next restart;
        # the provider-neutral bus routes the new handle immediately.
        if hasattr(s, "cli_name"):
            s.cli_name = handle
        host.schedule_save()
        return {"ok": True, "handle": handle, "addressable": True}

    if method == "set_effort":
        s = session
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
        s = session
        perm_id = params.get("perm_id") or params.get("id")
        if not isinstance(perm_id, str):
            raise RpcError(ERR_INVALID_PARAMS, "perm_id required")
        always = bool(params.get("always"))
        # Claude: index of the CLI's own "don't ask again" suggestion the
        # answer picked (permission_request.suggestions).
        suggestion = params.get("suggestion")
        if suggestion is not None and (
                not isinstance(suggestion, int) or isinstance(suggestion, bool)
                or suggestion < 0):
            raise RpcError(ERR_INVALID_PARAMS, "suggestion must be a non-negative integer")
        try:
            if suggestion is not None:
                resolved = s.respond_permission(
                    perm_id, bool(params.get("allow")), always, suggestion=suggestion)
            else:
                resolved = s.respond_permission(perm_id, bool(params.get("allow")), always)
        except TypeError:
            # Claude sessions on older SDK-compatible code keep the
            # two-argument method; Charon persists its alwaysAllow rule.
            resolved = s.respond_permission(perm_id, bool(params.get("allow")))
        return {"ok": True, "resolved": resolved is not False}

    if method == "respond_question":
        s = session
        q_id = params.get("q_id") or params.get("id")
        if not isinstance(q_id, str):
            raise RpcError(ERR_INVALID_PARAMS, "q_id required")
        answers = params.get("answers")
        resolved = s.respond_question(q_id, answers if isinstance(answers, dict) else None)
        return {"ok": True, "resolved": resolved is not False}

    if method == "respond_exit_plan":
        s = session
        q_id = params.get("q_id") or params.get("id")
        if not isinstance(q_id, str):
            raise RpcError(ERR_INVALID_PARAMS, "q_id required")
        decision = params.get("decision") or "reject"
        feedback = params.get("feedback") or ""
        resolved = s.respond_exit_plan(q_id, decision, feedback)
        return {"ok": True, "resolved": resolved is not False}

    if method == "resume_session":
        # For a session already in memory (typically after an agent
        # reboot where it was registered 'sleeping'), restart the SDK.
        s = session
        # Apply identity even on the noop path: a hub PATCH must converge
        # a live daemon without forcing a provider restart.
        incoming_handle = params.get("handle") or params.get("cli_name")
        if isinstance(incoming_handle, str) and _PEER_HANDLE_RE.fullmatch(incoming_handle):
            s.handle = incoming_handle
            if hasattr(s, "cli_name"):
                s.cli_name = incoming_handle
        for key in ("parent_session_id", "parent_handle"):
            if key in params:
                setattr(s, key, row_parent(params, key))
        incoming_config = params.get("session_config")
        if isinstance(incoming_config, dict) and hasattr(s, "apply_session_config"):
            await s.apply_session_config(incoming_config)
        if s.status in ("active", "thinking", "starting"):
            return {"ok": True, "status": s.status, "noop": True}
        for key in ("model", "fallback_model", "effort"):
            if key in params:
                setattr(s, key, params[key])
        # ⚠ Status said stopped; the RUN may disagree. Starting a second
        # one over a live task gives one session two provider clients:
        # Codex's newcomer then cannot take the thread's writer lock
        # ("already has an active writer") while the older app-server
        # holds it — and that older process is now unreachable, so the
        # lock never comes back (§14.97). Stop it first, always.
        old_run = getattr(s, "_main_task", None)
        if old_run is not None and not old_run.done():
            try:
                await s.stop(mark="sleeping")
            except Exception as e:
                print(f"[server] resume: stopping the previous run failed: {e}",
                      file=sys.stderr, flush=True)
        # Claude's native --name is start-time only. The common handle was
        # already applied above even when this resume is a noop.
        # Reset internal state so we can restart cleanly.
        # ⚠ The QUEUE is part of that state. `stop()` pushes an EOF
        # sentinel, and when the run loop has already exited (a failed
        # start, or a stop that timed out and cancelled the task) that
        # sentinel simply STAYS. The next run loop then emits ready/active
        # and immediately reads it — a session that reports itself alive
        # and never executes another turn, with no error anywhere. Same
        # reasoning as the rewind path, which has always done this.
        s.status = "starting"
        s._stdin_queue = asyncio.Queue()
        s._stopped.clear()
        s._ready_evt.clear()
        s._session_id_emitted = False
        s._main_task = None
        s._connection_changing = False
        if "model" in params:
            s._emit("model_changed", model=s.model, fallback_model=s.fallback_model, applied_at_next_start=False)
        if "effort" in params:
            s._emit("effort_changed", effort=s.effort, applied_at_next_start=False)
        await s.start()
        host.schedule_save()
        return {"ok": True, "status": s.status}

    # ── Lifecycle cores. The daemon keeps what spans sessions (idempotency,
    # the event log, the connection-change flag) and calls these for the
    # part that touches the provider object.
    if method == "send_input":
        content = params.get("content")
        if not isinstance(content, str):
            raise RpcError(ERR_INVALID_PARAMS, "content required (str)")
        codex_inputs = params.get("codex_inputs")
        peer_request_id = params.get("peer_request_id")
        if isinstance(peer_request_id, str) and peer_request_id:
            await session.send_input(content, peer_request_id=peer_request_id)
        elif codex_inputs is not None:
            await session.send_input(content, codex_inputs)
        else:
            await session.send_input(content)
        return {"ok": True}

    if method == "sleep_session":
        if params.get("only_if_idle"):
            if session.status in ("thinking", "starting"):
                return {"ok": False, "busy": True}
            session._connection_changing = True
        await session.stop(mark="sleeping")
        host.schedule_save()
        return {"ok": True}

    if method == "force_stop":
        await session.force_stop()
        host.schedule_save()
        return {"ok": True}

    if method == "kill_session":
        await session.stop(mark="killed")
        host.schedule_save()
        return {"ok": True}

    raise RpcError(ERR_METHOD_NOT_FOUND, f"unknown method: {method}")
