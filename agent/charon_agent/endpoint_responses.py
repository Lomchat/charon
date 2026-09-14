"""Responses stream compatibility shared by endpoint probes and the CLI relay."""
from __future__ import annotations

import json
import re
from typing import Any, Iterator

MAX_EVENT_BYTES = 2 * 1024 * 1024
_SEPARATOR = re.compile(br"\r?\n\r?\n")


def response_event(event: Any) -> Any:
    """Missing usage is valid; incomplete counters must never become fake zeros.

    Some gateways (including fal) replace Responses usage with their billing
    schema. Codex rejects the terminal event if this optional object lacks the
    required token counts, then retries a turn whose tools already executed.
    Preserve valid usage and every other field, including errors/status/output.
    """
    if not isinstance(event, dict) or not str(event.get("type", "")).startswith("response."):
        return event
    response = event.get("response")
    if not isinstance(response, dict) or response.get("usage") is None:
        return event
    usage = response["usage"]
    if isinstance(usage, dict) and all(
        type(usage.get(key)) is int and usage[key] >= 0
        for key in ("input_tokens", "output_tokens", "total_tokens")
    ):
        return event
    return {**event, "response": {**response, "usage": None}}


def _frame(frame: bytes) -> bytes:
    lines = frame.splitlines(keepends=True)
    data = [line[5:].strip() for line in lines if line.startswith(b"data:")]
    if not data:
        return frame
    try:
        event = json.loads(b"\n".join(data))
    except (ValueError, UnicodeError):
        return frame
    normalized = response_event(event)
    if normalized is event:
        return frame
    replacement = b"data: " + json.dumps(normalized, separators=(",", ":")).encode() + b"\n"
    output = []
    for line in lines:
        if line.startswith(b"data:"):
            if replacement:
                output.append(replacement)
                replacement = b""
        else:
            output.append(line)
    return b"".join(output)


def response_stream(upstream: Any) -> Iterator[bytes]:
    """Bound each SSE event, not the whole stream; preserve framing/heartbeats."""
    pending = b""
    while True:
        chunk = upstream.read1(65536)
        if not chunk:
            if pending:
                yield pending  # A truncated frame must not become a completion.
            return
        pending += chunk
        while match := _SEPARATOR.search(pending):
            if match.end() > MAX_EVENT_BYTES:
                raise ValueError("Endpoint stream event is too large")
            yield _frame(pending[:match.end()])
            pending = pending[match.end():]
        if len(pending) > MAX_EVENT_BYTES:
            raise ValueError("Endpoint stream event is too large")
