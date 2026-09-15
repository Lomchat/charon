"""Request-scoped endpoint counters, before gateway usage normalization."""
from __future__ import annotations

import json
import secrets

from .endpoint_responses import MAX_EVENT_BYTES


def count(value):
    return value if type(value) is int and value >= 0 else None


class EndpointUsage:
    def __init__(self, engine: str):
        self.engine = engine
        self.request_id = secrets.token_hex(16)
        self.usage = {}
        self.pending = b""
        self.event_data = []
        self.event_size = 0
        self.complete = False
        self.oversized = False

    def event(self, event):
        if not isinstance(event, dict):
            return
        if event.get("type") in ("response.completed", "response.incomplete", "response.failed", "message_stop"):
            self.complete = True
        if self.engine == "codex":
            response = event.get("response", event)
            usage = response.get("usage") if isinstance(response, dict) else None
        else:
            message = event.get("message", event)
            usage = message.get("usage") if isinstance(message, dict) else None
        if isinstance(usage, dict):
            # Anthropic's message_delta updates output only; input/cache counts
            # from message_start must survive. Repeated snapshots are not sums.
            self.usage.update({k: v for k, v in usage.items() if v is not None})

    def feed(self, chunk: bytes, *, streaming: bool):
        # Observing an unfamiliar/oversized response must never break delivery.
        if self.oversized:
            return
        self.pending += chunk
        if streaming:
            while b"\n" in self.pending:
                line, self.pending = self.pending.split(b"\n", 1)
                line = line.rstrip(b"\r")
                self.event_size += len(line)
                if self.event_size > MAX_EVENT_BYTES:
                    self.oversized = True
                    self.pending = b""
                    self.event_data = []
                    return
                if line.startswith(b"data:"):
                    self.event_data.append(line[5:].strip())
                elif not line:
                    try:
                        self.event(json.loads(b"\n".join(self.event_data)))
                    except (ValueError, UnicodeError):
                        pass
                    self.event_data = []
                    self.event_size = 0
        if len(self.pending) > MAX_EVENT_BYTES:
            self.pending = b""
            self.oversized = True

    def result(self, *, streaming: bool):
        if not streaming and self.pending and not self.oversized:
            try:
                self.event(json.loads(self.pending))
            except (ValueError, UnicodeError):
                pass
        u = self.usage
        sent = count(u.get("input_tokens", u.get("prompt_tokens")))
        received = count(u.get("output_tokens", u.get("completion_tokens")))
        if self.engine == "claude" and sent is not None:
            # Anthropic separates cached input; Responses includes it already.
            sent += count(u.get("cache_read_input_tokens")) or 0
            sent += count(u.get("cache_creation_input_tokens")) or 0
        total = count(u.get("total_tokens"))
        if total is None and sent is not None and received is not None:
            total = sent + received
        return {"request_id": self.request_id, "input_tokens": sent,
                "output_tokens": received, "total_tokens": total,
                "partial": streaming and not self.complete}
