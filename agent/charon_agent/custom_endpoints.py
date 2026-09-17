"""Bounded API catalog and streaming/tool probes, executed on the selected VPS."""
from __future__ import annotations

import asyncio
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .endpoint_responses import response_event
from .endpoint_headers import endpoint_headers
from .endpoint_catalogs import endpoint_catalog, NO_CATALOG

MAX_BYTES = 2 * 1024 * 1024


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Endpoint redirected the request. Enter its final URL explicitly.")


def _request(endpoint: dict, path: str, body: dict | None = None) -> Any:
    base = str(endpoint.get("baseUrl") or "").rstrip("/")
    url = urllib.parse.urlsplit(base)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Invalid endpoint URL")
    headers = endpoint_headers(endpoint, path, endpoint.get("_probe_session") or secrets.token_hex(16))
    headers["anthropic-version"] = "2023-06-01"
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with urllib.request.build_opener(_NoRedirect()).open(req, timeout=20) as response:
        if body is None:
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES: raise ValueError("Endpoint response is too large")
            return json.loads(raw)
        events = []
        size = 0
        started = time.monotonic()
        for line in response:
            size += len(line)
            if size > MAX_BYTES or time.monotonic() - started > 22:
                raise ValueError("Endpoint streaming test exceeded its limit")
            if not line.startswith(b"data:"): continue
            value = line[5:].strip()
            if value == b"[DONE]": break
            try:
                event = json.loads(value)
                events.append(response_event(event) if path == "/v1/responses" else event)
            except (ValueError, UnicodeError): continue
        return events


def catalog(endpoint: dict) -> list[dict]:
    route = endpoint_catalog(endpoint.get("baseUrl", ""))
    if route is None:
        raise ValueError(NO_CATALOG)
    result = _request({**endpoint, "baseUrl": route["baseUrl"]}, route["modelsPath"])
    models = []
    for item in result.get("data", [])[:500]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str): continue
        model: dict = {"id": item["id"][:256]}
        context = item.get("max_model_len") or item.get("context_window") or item.get("context_length")
        if isinstance(context, int) and 0 < context <= 100_000_000: model["contextWindow"] = context
        # A generic /models list usually cannot advertise reasoning support.
        levels = item.get("supported_reasoning_efforts")
        if isinstance(levels, list):
            model["effortLevels"] = [v for v in levels if v in ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")]
        models.append(model)
    return models


def _message_blocks(events: list[dict]) -> list[dict]:
    """Replay the complete assistant message, including signed thinking blocks."""
    blocks: dict[int, dict] = {}
    arguments: dict[int, str] = {}
    for event in events:
        index = event.get("index")
        if event.get("type") == "content_block_start":
            blocks[index] = dict(event["content_block"])
        elif event.get("type") == "content_block_delta" and index in blocks:
            delta = event.get("delta", {})
            if delta.get("type") == "input_json_delta":
                arguments[index] = arguments.get(index, "") + delta.get("partial_json", "")
            else:
                field = {"text_delta": "text", "thinking_delta": "thinking", "signature_delta": "signature"}.get(delta.get("type"))
                if field:
                    blocks[index][field] = blocks[index].get(field, "") + delta.get(field, "")
    for index, value in arguments.items():
        blocks[index]["input"] = json.loads(value)
    return list(blocks.values())


def _probe(endpoint: dict, engine: str, action: str) -> dict:
    endpoint = {**endpoint, "_probe_session": "probe-" + secrets.token_hex(16)}
    # Discovery is an explicit action, never a side effect of testing inference.
    if action == "models":
        if not endpoint_catalog(endpoint.get("baseUrl", "")):
            return {"ok": False, "models": [], "catalogError": NO_CATALOG}
        try:
            return {"ok": True, "models": catalog(endpoint)}
        except Exception:
            return {"ok": False, "models": [], "catalogError": "Model discovery unavailable; enter a model ID manually."}
    if action != "test":
        raise ValueError("Unsupported endpoint probe action")
    models = endpoint.get("models") or []
    model = str(endpoint.get("model") or "")
    check: dict = {"ok": False, "engine": engine, "model": model, "streaming": False, "tools": False}
    schema = {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"], "additionalProperties": False}
    # Forced tool_choice is rejected by some thinking models. Ask naturally,
    # then require a real streamed call + result round trip before passing.
    prompt = 'Call endpoint_check with value "connection-test". This is a harmless connection test. Do not reply before calling the tool.'
    if engine == "claude":
        body = {"model": model, "max_tokens": 1024, "stream": True,
                "messages": [{"role": "user", "content": prompt}],
                "tools": [{"name": "endpoint_check", "description": "Check connection", "input_schema": schema}],
                "tool_choice": {"type": "auto"}}
        events = _request(endpoint, "/v1/messages", body)
        check["streaming"] = any(e.get("type") == "message_start" for e in events) and any(e.get("type") == "message_stop" for e in events)
        content = _message_blocks(events)
        calls = [block for block in content if block.get("type") == "tool_use"]
        if not calls: raise ValueError("Streaming response did not include the requested tool call")
        call = calls[0]
        if call.get("name") != "endpoint_check": raise ValueError("Unexpected tool in test response")
        if call.get("input") != {"value": "connection-test"}: raise ValueError("Unexpected tool arguments in test response")
        body["messages"] += [{"role": "assistant", "content": content}, {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call["id"], "content": "Connection verified. Reply OK."}]}]
        second = _request(endpoint, "/v1/messages", body)
        check["tools"] = any(e.get("delta", {}).get("text") for e in second) and any(e.get("type") == "message_stop" for e in second)
    elif engine == "codex":
        body = {"model": model, "max_output_tokens": 1024, "stream": True,
                "input": [{"role": "user", "content": prompt}],
                "tools": [{"type": "function", "name": "endpoint_check", "description": "Check connection", "parameters": schema}],
                "tool_choice": "auto"}
        events = _request(endpoint, "/v1/responses", body)
        completed = next((e.get("response", {}) for e in events if e.get("type") == "response.completed"), {})
        check["streaming"] = bool(completed) and any(e.get("type") == "response.created" for e in events)
        calls = [item for item in completed.get("output", []) if item.get("type") == "function_call"]
        if not calls: raise ValueError("Responses API did not include the requested function call")
        call = calls[0]
        if call.get("name") != "endpoint_check": raise ValueError("Unexpected tool in test response")
        if json.loads(call.get("arguments", "{}")) != {"value": "connection-test"}: raise ValueError("Unexpected tool arguments in test response")
        body["input"] += completed.get("output", []) + [{"type": "function_call_output", "call_id": call["call_id"], "output": "Connection verified. Reply OK."}]
        second = _request(endpoint, "/v1/responses", body)
        check["tools"] = any(e.get("type") == "response.output_text.delta" and e.get("delta") for e in second) and any(e.get("type") == "response.completed" for e in second)
    else: raise ValueError("Unsupported endpoint engine")
    check["ok"] = check["streaming"] and check["tools"]
    metadata = next((m for m in models if m["id"] == model), {})
    for key in ("effortLevels", "contextWindow"):
        if key in metadata: check[key] = metadata[key]
    if not check["ok"]: check["error"] = "The endpoint did not complete the streaming tool round trip."
    return {"ok": check["ok"], "models": models, "check": check}


async def probe(endpoint: dict, engine: str, action: str = "test") -> dict:
    try:
        return await asyncio.wait_for(asyncio.to_thread(_probe, endpoint, engine, action), 55)
    except Exception as exc:
        if isinstance(exc, urllib.error.HTTPError):
            message = f"Endpoint returned HTTP {exc.code}. Check the URL, authentication and API compatibility."
            try:
                raw = await asyncio.wait_for(asyncio.to_thread(exc.read, 8192), 2)
                detail = json.loads(raw).get("error", {})
                if isinstance(detail, dict) and isinstance(detail.get("message"), str):
                    safe = detail["message"].replace(str(endpoint.get("token") or "\0"), "[redacted]")
                    message = f"Endpoint returned HTTP {exc.code}: {safe[:500]}"
            except (ValueError, OSError, AttributeError):
                pass
        elif isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
            message = "Endpoint test timed out."
        else:
            message = str(exc).replace(str(endpoint.get("token") or "\0"), "[redacted]")[:300]
        return {"ok": False, "check": {"ok": False, "engine": engine, "model": endpoint.get("model", ""), "streaming": False, "tools": False, "error": message}, "models": []}
