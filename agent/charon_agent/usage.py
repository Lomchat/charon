"""Account usage (the Claude Code `/usage` equivalent) via the OAuth token.

Stdlib-only (zipapp constraint). The per-VPS `claude login` OAuth token —
stored by the CLI in ``~/.claude/.credentials.json`` — is authorized to call
``GET https://api.anthropic.com/api/oauth/usage`` (scopes include
``user:inference`` / ``user:sessions:claude_code``). That endpoint returns the
account's rolling-window quota exactly as the ``/usage`` slash-command shows it:
``five_hour`` / ``seven_day`` utilization percentages, a rich ``limits[]`` array
(per-window + per-model-scoped ``percent`` / ``severity`` / ``resets_at``),
``extra_usage`` credits and ``spend``.

Why an endpoint poll and not the SDK stream: the SDK's ``RateLimitEvent`` (which
Charon also receives) carries ``status`` / ``resets_at`` but its ``utilization``
is ``null`` on subscription accounts — it never gives the percentages. So the
endpoint is the source of the gauges; the hub polls this method (throttled) and
opportunistically after each turn. See CLAUDE.md §14.58.

Usage is ACCOUNT-scoped, not session-scoped: this reads no session state, just
the credentials file, so it works whether or not a session is streaming.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
_OAUTH_BETA = "oauth-2025-04-20"


def _creds_path() -> Path:
    # The CLI writes the OAuth token here regardless of CHARON_AGENT_HOME
    # (that env var only relocates ~/.charon, not ~/.claude).
    return Path.home() / ".claude" / ".credentials.json"


def _read_oauth() -> dict[str, Any] | None:
    try:
        data = json.loads(_creds_path().read_text())
    except Exception:
        return None
    # Two observed shapes: {"claudeAiOauth": {...}} (current) or a flat dict.
    o = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if not isinstance(o, dict):
        o = data if isinstance(data, dict) else None
    if not isinstance(o, dict) or not isinstance(o.get("accessToken"), str):
        return None
    return o


def fetch_usage(timeout: float = 20.0) -> dict[str, Any]:
    """Blocking GET of /api/oauth/usage. Returns a normalized envelope.

    Success: {ok:True, subscription_type, fetched_at, usage:<raw endpoint json>}
    Failure: {ok:False, error:<slug>, fetched_at, status_code?}
    Never raises — the hub treats a failure envelope as "usage unavailable".
    """
    now = time.time()
    o = _read_oauth()
    if o is None:
        return {"ok": False, "error": "no_credentials", "fetched_at": now}
    req = urllib.request.Request(
        _USAGE_URL,
        headers={
            "Authorization": "Bearer " + o["accessToken"],
            "anthropic-beta": _OAUTH_BETA,
            "Content-Type": "application/json",
            "User-Agent": "charon-agent",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
        data = json.loads(body)
    except urllib.error.HTTPError as e:
        # 401 = token expired (the CLI refreshes it as it runs sessions);
        # 429 = the endpoint's own rate limit (hub backs off).
        return {"ok": False, "error": "http_error", "status_code": e.code,
                "fetched_at": now}
    except Exception as e:
        return {"ok": False, "error": "request_failed",
                "detail": str(e)[:200], "fetched_at": now}
    return {
        "ok": True,
        "subscription_type": o.get("subscriptionType"),
        "fetched_at": now,
        "usage": data,
    }
