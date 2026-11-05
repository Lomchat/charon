"""Per-turn prompt-cache counters (hub: lib/promptCache.ts).

A turn is several API requests (one per tool call); each re-sends the whole
prompt, and the provider serves the part it still holds from its cache. The
agent counts them one by one and ships the totals on the turn's single
`usage final:true` event as `turn_cache`:

- a request HITS when it read the prefix (read >= write): it rewrote only the
  new tail;
- it MISSES when it wrote more than it read: the conversation prefix was gone
  (expired TTL, model or account switch) and had to be rewritten — what a
  cold turn costs;
- `last_request_at` (ms) + `last_prompt_tokens` are what the NEXT message
  will find: the hub turns them into the session's countdown.

Stdlib only, no I/O.
"""
from __future__ import annotations

import time
from typing import Any


def new_turn_cache() -> dict[str, Any]:
    return {
        "requests": 0, "hits": 0, "misses": 0, "miss_write_tokens": 0,
        "read_tokens": 0, "write_tokens": 0, "uncached_tokens": 0,
        "output_tokens": None, "ttl_s": None,
        "last_request_at": None, "last_prompt_tokens": 0,
    }


def _int(v: Any) -> int:
    return int(v) if isinstance(v, (int, float)) and v > 0 else 0


def count_request(tc: dict[str, Any], *, read: Any, write: Any, uncached: Any,
                  ttl_s: int | None = None, output: Any = None,
                  now_ms: int | None = None) -> None:
    """Fold ONE API request of the turn into `tc` (in place)."""
    r, w, u = _int(read), _int(write), _int(uncached)
    tc["requests"] += 1
    tc["read_tokens"] += r
    tc["write_tokens"] += w
    tc["uncached_tokens"] += u
    if w > r:
        tc["misses"] += 1
        tc["miss_write_tokens"] += w
    elif r > 0:
        tc["hits"] += 1
    if output is not None:
        tc["output_tokens"] = (tc["output_tokens"] or 0) + _int(output)
    if ttl_s:
        tc["ttl_s"] = int(ttl_s)
    tc["last_request_at"] = int(now_ms if now_ms is not None else time.time() * 1000)
    tc["last_prompt_tokens"] = r + w + u


def anthropic_ttl_s(usage: dict[str, Any]) -> int | None:
    """The TTL the request WROTE with, from Anthropic's `cache_creation`
    breakdown: 1 h beats 5 min (the longer entry outlives the shorter)."""
    nested = usage.get("cache_creation")
    if not isinstance(nested, dict):
        return None
    if _int(nested.get("ephemeral_1h_input_tokens")):
        return 3600
    if _int(nested.get("ephemeral_5m_input_tokens")):
        return 300
    return None


def anthropic_write_tokens(usage: dict[str, Any]) -> int:
    flat = usage.get("cache_creation_input_tokens")
    if isinstance(flat, (int, float)):
        return _int(flat)
    nested = usage.get("cache_creation")
    if isinstance(nested, dict):
        return sum(_int(v) for v in nested.values())
    return 0


def payload(tc: dict[str, Any]) -> dict[str, Any] | None:
    """What rides on `usage final:true`; None when no request was counted."""
    if not tc.get("requests"):
        return None
    return dict(tc)
