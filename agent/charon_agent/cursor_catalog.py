"""Box-level Cursor queries: model catalog, importable agents, archive state.

None of these belong to a running session — the import tab asks "what is on
this box" before any session exists, and the model picker must answer on a VPS
whose sessions are all asleep. So each one borrows a SHORT-LIVED bridge, the
same reason the Codex fork path uses a throwaway client (§14.94): a resident
session's client is busy owning its own agent.

Every function answers with an envelope (`ok` plus a `reason`/`error`) instead
of raising, because these render beside a chat and a thrown error there reads
as a broken session rather than a missing capability (§14.95).
"""
from __future__ import annotations

import asyncio
import re
from typing import Any

from .cursor_runtime import (
    CURSOR_AVAILABLE,
    CURSOR_IMPORT_ERROR,
    effective_api_key,
    legacy_store_agent_ids,
    legacy_store_config,
    legacy_store_messages,
    legacy_store_rows,
    require_sdk,
    state_root,
    workspace_ref,
)

# A catalog call must not hang the RPC: the hub's own bound is 60s (§6), so
# fail earlier and say so rather than being cut off mid-answer.
_BRIDGE_TIMEOUT_S = 45.0


class _Bridge:
    """A bridge that lives exactly as long as one query.

    `state_root` is the bridge's own bookkeeping dir (per hub instance, §14.70);
    it does NOT choose the agent store — the workspace does (`workspace_ref`).
    """

    def __init__(self, workspace: str) -> None:
        self._workspace = workspace
        self._client: Any = None

    async def __aenter__(self) -> Any:
        sdk = require_sdk()
        self._client = await sdk.AsyncClient.launch_bridge(
            workspace=self._workspace,
            state_root=str(state_root()),
            timeout=_BRIDGE_TIMEOUT_S,
        )
        return self._client

    async def __aexit__(self, *_exc: Any) -> None:
        if self._client is not None:
            try:
                await asyncio.wait_for(self._client.aclose(), timeout=10.0)
            except Exception:
                pass


#: A scan opens one bridge (and one Node process) per workspace, so ONE call is
#: bounded. The bound is a PAGE, not a limit: what it did not reach comes back
#: as `remaining` so the caller can continue — silently stopping at the eighth
#: folder left conversations permanently unfindable with nothing saying so.
_MAX_SCAN_WORKSPACES = 8


def _workspace_page(params: dict[str, Any]) -> "tuple[list[str], list[str]]":
    """`(scan these now, left for the next call)`.

    The order is the CALLER's: it is the only side that knows which folder was
    used most recently. This function must not re-sort it.
    """
    raw = params.get("cwds")
    candidates = [c for c in (raw or []) if isinstance(c, str) and c]
    single = params.get("cwd")
    if isinstance(single, str) and single:
        # An explicitly chosen folder is the whole scan: the user picked it.
        candidates = [single]
    deduped: list[str] = []
    for c in candidates:
        if c not in deduped:
            deduped.append(c)
    # Never empty: the home store is where a cwd-less agent would have landed.
    if not deduped:
        deduped = [workspace_ref(None)]
    return deduped[:_MAX_SCAN_WORKSPACES], deduped[_MAX_SCAN_WORKSPACES:]


def _scoped_options(workspace: str) -> dict[str, Any]:
    """Wire options for `ListAgents` / `ArchiveAgent` / `UnarchiveAgent`.

    ⚠ These two proto messages carry `cwd` and `api_key` and NOTHING ELSE — no
    store, no local options. Sending an `AgentOptions` here looks right and is
    silently dropped as an unknown field, which is how the import list came back
    empty and archive answered "Agent not found" for an agent that was really
    there. The CWD is the only lever: it selects the SDK's own per-workspace
    store, so it must be the SAME cwd the session ran under.
    """
    return {"cwd": workspace, "apiKey": effective_api_key() or ""}


def _resume_options(sdk: Any, workspace: str, agent_id: str | None = None) -> Any:
    """`ResumeAgent` DOES take a full `AgentOptions`; still no store override —
    the cwd picks the same workspace store the agent was created in. The one
    exception is a pre-0.95.3 agent, which only exists in the old private store
    and is read where it is (§14.103)."""
    local: dict[str, Any] = {"cwd": workspace}
    legacy = legacy_store_config(sdk, agent_id)
    if legacy is not None:
        local["store"] = legacy
    return sdk.AgentOptions(
        local=sdk.LocalAgentOptions(**local),
        api_key=effective_api_key(),
    )


def _unavailable() -> dict[str, Any]:
    return {"ok": False, "reason": "unsupported",
            "error": f"cursor-sdk unavailable: {CURSOR_IMPORT_ERROR}"}


def _failure(exc: Exception) -> dict[str, Any]:
    # An unauthenticated box is a DIFFERENT answer from a broken one: the hub
    # turns the first into a Sign-in call to action (§14.68), so keep them
    # distinguishable instead of flattening both into "error".
    from .cursor_session import _is_auth_error

    reason = "auth" if _is_auth_error(exc) else "error"
    return {"ok": False, "reason": reason, "error": f"{type(exc).__name__}: {exc}"}


async def list_models(params: dict[str, Any] | None = None) -> dict[str, Any]:
    """The account's model catalog.

    Account-driven and per-box, like Codex's (§14.59) and unlike Claude's,
    which needs an API key (§14.43): whatever this box is signed in as decides
    what it may run.
    """
    if not CURSOR_AVAILABLE:
        return _unavailable()
    try:
        async with _Bridge(workspace_ref((params or {}).get("cwd"))) as client:
            models = await client.list_models(api_key=effective_api_key())
    except Exception as e:
        return _failure(e)
    out = []
    for m in models or []:
        model_id = getattr(m, "id", None)
        if not isinstance(model_id, str) or not model_id:
            continue
        # A variant is identified by its parameter values; it has no id.
        variants = []
        for v in getattr(m, "variants", None) or []:
            params = {}
            for pv in getattr(v, "params", None) or []:
                pid, val = getattr(pv, "id", None), getattr(pv, "value", None)
                if isinstance(pid, str) and pid and val is not None:
                    params[pid] = str(val)
            variants.append({
                "params": params,
                "label": getattr(v, "display_name", None) or "",
                "description": getattr(v, "description", None) or "",
                "isDefault": bool(getattr(v, "is_default", False)),
            })
        # The parameter DEFINITIONS give each knob a human name and its allowed
        # values. This IS the effort axis — per model rather than global, which
        # is what the hub's effort control fills itself from. Forwarded verbatim:
        # deciding which knob is the reasoning ladder is a hub concern
        # (`lib/modelParams.ts`), so a newly-named one costs a deploy and not a
        # fleet-wide agent rollout.
        parameters = []
        for p_ in getattr(m, "parameters", None) or []:
            pid = getattr(p_, "id", None)
            if not isinstance(pid, str) or not pid:
                continue
            values = []
            for pv in getattr(p_, "values", None) or []:
                val = getattr(pv, "value", None)
                if val is None:
                    continue
                values.append({
                    "value": str(val),
                    "label": getattr(pv, "display_name", None) or "",
                })
            parameters.append({
                "id": pid,
                "label": getattr(p_, "display_name", None) or pid,
                "values": values,
            })
        out.append({
            "id": model_id,
            "label": getattr(m, "display_name", None) or model_id,
            "description": getattr(m, "description", None) or "",
            "parameters": parameters,
            "variants": variants,
        })
    return {"ok": True, "models": out}


async def list_agents(params: dict[str, Any] | None = None) -> dict[str, Any]:
    """Conversations already on this box, for the import tab.

    Read through the SDK rather than by parsing `~/.cursor` on disk: the store
    is the SDK's own (a JSONL/SQLite checkpoint tree whose layout is an
    implementation detail), and it is the only thing that also knows which ids
    `Agent.resume` will actually accept — which is the entire question the
    import tab is asking.
    """
    if not CURSOR_AVAILABLE:
        return _unavailable()
    p = params or {}
    include_archived = bool(p.get("include_archived"))
    limit = p.get("limit")
    limit = int(limit) if isinstance(limit, int) and 0 < limit <= 500 else 100
    # ⚠ ONE workspace = one store, so a single listing only ever sees one
    # project's conversations. The hub sends every cwd it knows for this box
    # (known paths + live session cwds); a scan with none would answer from the
    # HOME store alone and report "nothing to import" on a box full of them.
    workspaces, remaining = _workspace_page(p)
    scanned: list[str] = []
    items: list[Any] = []
    first_error: Exception | None = None
    try:
        sdk = require_sdk()
    except Exception as e:
        return _failure(e)
    for workspace in workspaces:
        try:
            async with _Bridge(workspace) as client:
                options = _scoped_options(workspace)
                options.update({"limit": limit, "includeArchived": include_archived})
                page = await sdk.AsyncAgent.list(options, client=client)
                # `limit` is the SDK page size, not the number of agents in a
                # workspace. Keep following `next_cursor` while THIS bridge is
                # alive: the continuation closure captures its client, and a
                # fresh bridge would have a different store snapshot. Stopping
                # after page one silently hid every conversation after #100.
                seen_cursors: set[str] = set()
                while True:
                    items.extend(getattr(page, "items", None) or [])
                    next_cursor = getattr(page, "next_cursor", "") or ""
                    if not next_cursor:
                        break
                    if next_cursor in seen_cursors:
                        raise RuntimeError("Cursor agent listing repeated its pagination cursor")
                    seen_cursors.add(next_cursor)
                    page = await page.get_next_page()
            scanned.append(workspace)
        except Exception as e:
            # One unreadable workspace must not lose the others: a box with a
            # stale path in its known list would otherwise scan as empty.
            if first_error is None:
                first_error = e
    if not scanned and first_error is not None:
        return _failure(first_error)

    rows = []
    for info in items:
        agent_id = getattr(info, "agent_id", None)
        if not isinstance(agent_id, str) or not agent_id:
            continue
        archived = bool(getattr(info, "archived", False))
        if archived and not include_archived:
            continue
        # Cloud agents run on Cursor's infrastructure against a cloned repo —
        # importing one into a VPS-rooted session would attach a transcript to
        # a working tree it never touched.
        if str(getattr(info, "runtime", "local") or "local") != "local":
            continue
        row_cwd = getattr(info, "cwd", None)
        rows.append({
            "id": agent_id,
            "cwd": str(row_cwd) if row_cwd else "",
            "name": getattr(info, "name", None) or getattr(info, "summary", None) or "",
            "summary": getattr(info, "summary", None) or "",
            "archived": archived,
            "status": getattr(info, "status", None) or "",
            "updated_at": _epoch(getattr(info, "last_modified", None)),
            "created_at": _epoch(getattr(info, "created_at", None)),
        })

    # Pre-0.95.3 agents live in a store no listing RPC can reach, so they are
    # read from its own index. Without this a conversation from before the
    # store rule could never be re-imported after its Charon row was deleted.
    seen = {r["id"] for r in rows}
    for row in legacy_store_rows():
        agent_id = row.get("agentId")
        if not isinstance(agent_id, str) or agent_id in seen:
            continue
        archived = bool(row.get("archived"))
        if archived and not include_archived:
            continue
        rows.append({
            "id": agent_id,
            "cwd": str(row.get("cwd") or ""),
            "name": str(row.get("name") or ""),
            "summary": str(row.get("summary") or ""),
            "archived": archived,
            "status": str(row.get("status") or ""),
            "updated_at": _epoch(row.get("updatedAt")),
            "created_at": _epoch(row.get("createdAt")),
        })
    # `remaining` is what this page did not reach. Reporting it is the
    # difference between "there is nothing" and "there is more" (§14.84).
    return {"ok": True, "agents": rows, "scanned": scanned,
            "remaining": remaining, "truncated": bool(remaining)}


async def agent_messages(params: dict[str, Any]) -> dict[str, Any]:
    """One agent's conversation, for the import.

    Current agents resume through a throwaway bridge, then read the SDK's own
    transcript view. Legacy agents are read through the bundled public JS SDK
    against their explicit JSONL store because ListAgentMessages cannot carry
    that store; Charon never parses the checkpoint layout itself.
    """
    if not CURSOR_AVAILABLE:
        return _unavailable()
    p = params or {}
    agent_id = p.get("agent_id")
    if not isinstance(agent_id, str) or not agent_id:
        return {"ok": False, "error": "agent_id required"}
    workspace = workspace_ref(p.get("cwd"))
    limit = p.get("limit")
    limit = int(limit) if isinstance(limit, int) and 0 < limit <= 5000 else 2000
    agent = None
    try:
        sdk = require_sdk()
        if agent_id in legacy_store_agent_ids():
            # ListAgentMessages has no store field. Resuming against the legacy
            # store and then calling the instance method still reads the
            # default store, so use the public JS SDK against that JSONL store.
            raw = await legacy_store_messages(agent_id, workspace, limit)
        else:
            async with _Bridge(workspace) as client:
                options = _resume_options(sdk, workspace, agent_id)
                agent = await sdk.AsyncAgent.resume(agent_id, options, client=client)
                raw = await agent.list_messages({"limit": limit, "cwd": workspace})
    except Exception as e:
        return _failure(e)
    finally:
        if agent is not None:
            try:
                res = agent.close()
                if asyncio.iscoroutine(res):
                    await res
            except Exception:
                pass

    out = []
    for m in raw or []:
        for role, text in _message_rows(m):
            if text:
                out.append({"role": role, "content": text})
    return {"ok": True, "messages": out}


# A user turn reaches the model wrapped in context envelopes; only the query is
# the human's own words. Importing the envelope would paste a page of git status
# and OS info into the transcript as if the user had typed it.
_QUERY_RE = re.compile(r"<user_query>\s*(.*?)\s*</user_query>", re.S)
_ENVELOPE_RE = re.compile(
    r"<(?:user_info|git_status|system_reminder|timestamp|agent_transcripts|"
    r"additional_data|attached_files)>.*?</(?:user_info|git_status|system_reminder|"
    r"timestamp|agent_transcripts|additional_data|attached_files)>", re.S)


def _clean_user_text(text: str) -> str:
    """The words the human actually typed."""
    queries = _QUERY_RE.findall(text)
    if queries:
        return "\n\n".join(q.strip() for q in queries if q.strip()).strip()
    return _ENVELOPE_RE.sub("", text).strip()


def _blocks_text(value: Any) -> str:
    """Plain text out of a content field, whatever shape it takes.

    ⚠ `reasoning` blocks are skipped: they carry an empty `text` and a huge
    opaque `signature`, and they are not part of the conversation.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    blocks = value
    if not isinstance(blocks, (list, tuple)):
        blocks = getattr(value, "content", None)
        if blocks is None and isinstance(value, dict):
            blocks = value.get("content")
        if isinstance(blocks, str):
            return blocks
    out: list[str] = []
    for block in blocks or []:
        btype = getattr(block, "type", None)
        if btype is None and isinstance(block, dict):
            btype = block.get("type")
        if btype in ("reasoning", "redacted_reasoning"):
            continue
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
            text = block.get("text")
        if isinstance(text, str) and text:
            out.append(text)
    return "".join(out)


def _field(obj: Any, *names: str) -> Any:
    for name in names:
        value = getattr(obj, name, None)
        if value is None and isinstance(obj, dict):
            value = obj.get(name)
        if value is not None:
            return value
    return None


def _value(obj: Any) -> Any:
    """Unwrap the bridge's protobuf-oneof-shaped ``{value: ...}`` values."""
    value = _field(obj, "value")
    return obj if value is None else value


def _message_rows(m: Any) -> "list[tuple[str, str]]":
    """One SDK record → the conversation rows it contains.

    ⚠ Returns a LIST, because a record is not always one message: the SDK hands
    back TURNS that carry the user's prompt AND the responses together. Reading
    only a `{role, content}` pair — the shape the checkpoint blobs use — found no
    `content` on a turn and imported an empty history.

    Only USER and ASSISTANT prose is imported: tool traffic belongs to the run
    that produced it and would replay as unresolved cards against tool ids the
    new transcript does not have (§14.39).
    """
    payload = _field(m, "message") or m
    rows: list[tuple[str, str]] = []

    # The real ListAgentMessages wire shape is an AgentMessage whose outer
    # `type` is merely "user". Its prose is one level deeper:
    # `message.turn.value.userMessage.text`, with assistant replies in
    # `...steps`. Decode that turn BEFORE the direct role/content shortcut;
    # otherwise `type: user` returns early with an empty `content` field and
    # drops the whole exchange.
    turn_box = _field(payload, "turn")
    if turn_box is not None:
        turn = _value(turn_box)
        user = _field(turn, "userMessage", "user_message")
        user_text = _clean_user_text(
            _blocks_text(_field(user, "text", "content") or user))
        if user_text:
            rows.append(("user", user_text[:200_000]))

        steps = _field(turn, "steps")
        if isinstance(steps, (list, tuple)):
            for raw_step in steps:
                step = _value(_field(raw_step, "step") or raw_step)
                message_box = _field(step, "message")
                case = _field(message_box, "case")
                if case is not None:
                    if case != "assistantMessage":
                        continue
                    message = _value(message_box)
                else:
                    # A full conversation resolved directly from the legacy
                    # checkpoint serializes a oneof as `{assistantMessage: …}`.
                    message = _field(step, "assistantMessage", "assistant_message")
                    if message is None:
                        # Compatibility with ConversationStep dataclasses and
                        # older checkpoint objects exposing a direct `type`.
                        if _field(step, "type") != "assistantMessage":
                            continue
                        message = message_box
                text = _blocks_text(_field(message, "text", "content") or message)
                if text:
                    rows.append(("assistant", text[:200_000]))
        return rows

    role = _field(payload, "role") or _field(m, "role") or _field(m, "type")
    if isinstance(role, str) and role in ("user", "assistant"):
        text = _blocks_text(_field(payload, "content"))
        if role == "user":
            text = _clean_user_text(text)
        if text:
            rows.append((role, text[:200_000]))
        return rows

    # A TURN: the user's prompt, then whatever came back.
    user = _field(payload, "userMessage", "user_message", "prompt", "input")
    user_text = _clean_user_text(
        _blocks_text(_field(user, "text", "content") or user))
    if user_text:
        rows.append(("user", user_text[:200_000]))

    replies = _field(payload, "responses", "assistantMessages", "assistant_messages",
                     "messages", "outputs")
    if isinstance(replies, (list, tuple)):
        for reply in replies:
            for sub_role, sub_text in _message_rows(reply):
                rows.append((sub_role, sub_text))
    # `result` is the turn's final assistant text (that is what runs.ndjson
    # stores); only use it when the replies did not already carry prose.
    if not any(r == "assistant" for r, _ in rows):
        result = _field(payload, "result", "text", "output")
        result_text = _blocks_text(result)
        if result_text:
            rows.append(("assistant", result_text[:200_000]))
    return rows


async def set_archived(params: dict[str, Any], archived: bool) -> dict[str, Any]:
    """Mirror Charon's archive flag into Cursor's own store."""
    if not CURSOR_AVAILABLE:
        return _unavailable()
    agent_id = (params or {}).get("agent_id") or (params or {}).get("thread_id")
    if not isinstance(agent_id, str) or not agent_id:
        return {"ok": False, "error": "agent_id required"}
    workspace = workspace_ref((params or {}).get("cwd"))
    # ⚠ A pre-0.95.3 agent lives in the old private store, and `ArchiveAgent`
    # carries `cwd` + `api_key` and NOTHING else — no store, on any code path
    # (the bridge calls `Agent.archive` directly, it does not resolve through
    # its registry). So the mirror is IMPOSSIBLE for those, not merely unwired:
    # attempting it answers "Agent not found". Report that as a non-failure and
    # let Charon's own `archived` column carry the state — exactly the `adapted`
    # behaviour Claude has always had — instead of failing a legitimate action.
    if agent_id in legacy_store_agent_ids():
        return {"ok": True, "archived": archived, "mirrored": False,
                "reason": "legacy_store"}
    try:
        sdk = require_sdk()
        async with _Bridge(workspace) as client:
            fn = sdk.AsyncAgent.archive if archived else sdk.AsyncAgent.unarchive
            await fn(agent_id, _scoped_options(workspace), client=client)
    except Exception as e:
        return _failure(e)
    return {"ok": True, "archived": archived, "mirrored": True}


def _epoch(value: Any) -> int | None:
    """Normalise a timestamp to unix SECONDS.

    The SDK types these as ISO strings but has been seen returning epoch ms;
    accept both rather than showing 1970 in the import list on a shape change.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        n = float(value)
        return int(n / 1000) if n > 1e11 else int(n)
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        n = float(text)
        return int(n / 1000) if n > 1e11 else int(n)
    try:
        from datetime import datetime

        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp())
    except Exception:
        return None
