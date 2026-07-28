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

import datetime
import email.utils
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


def _retry_after_seconds(headers: Any) -> float | None:
    """Parse a `Retry-After` header → seconds from now, or None.

    RFC 7231 allows either delta-seconds or an HTTP-date; the endpoint sends
    delta-seconds (observed: 0 for the short burst bucket, up to ~3000 for the
    escalated per-IP lockout). The hub uses this as an EXACT wall to back off
    against — a flat guess made it retry ~10x into a 51-minute lockout and pin
    the "rate-limited" state in the UI the whole time. cf. CLAUDE.md §14.72.
    """
    if headers is None:
        return None
    raw = headers.get("Retry-After")
    if raw is None:
        return None
    raw = str(raw).strip()
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        pass
    try:
        dt = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    now = datetime.datetime.now(datetime.timezone.utc)
    return max(0.0, (dt - now).total_seconds())


def fetch_usage(timeout: float = 30.0) -> dict[str, Any]:
    """Blocking GET of /api/oauth/usage. Returns a normalized envelope.

    Success: {ok:True, subscription_type, org_id, fetched_at,
              usage:<raw endpoint json>}
    Failure: {ok:False, error:<slug>, fetched_at, status_code?, retry_after?}
    Never raises — the hub treats a failure envelope as "usage unavailable".

    `org_id` (the `anthropic-organization-id` response header) is the ACCOUNT
    identity: the gauges are account-scoped, so N VPSes signed into the same
    account return byte-identical numbers. The hub keys its cache on it and
    polls ONE VPS per account instead of all of them (§14.72). It is only
    present on a 200 — the 429s are generated at the edge and carry no
    org/request id at all.

    The timeout is generous on purpose: a successful call regularly takes
    ~15s (measured), well past the old 20s margin once TLS setup is included.
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
            org_id = r.headers.get("anthropic-organization-id")
        data = json.loads(body)
    except urllib.error.HTTPError as e:
        # 401 = token expired (the CLI refreshes it as it runs sessions);
        # 429 = throttled at the edge (per source IP, ~1 call/min sustained,
        # with escalating multi-minute lockouts). Retry-After is the exact
        # reset — pass it up so the hub backs off against the real wall.
        out = {"ok": False, "error": "http_error", "status_code": e.code,
               "fetched_at": now}
        ra = _retry_after_seconds(getattr(e, "headers", None))
        if ra is not None:
            out["retry_after"] = ra
        return out
    except Exception as e:
        return {"ok": False, "error": "request_failed",
                "detail": str(e)[:200], "fetched_at": now}
    return {
        "ok": True,
        "subscription_type": o.get("subscriptionType"),
        "org_id": org_id,
        "fetched_at": now,
        "usage": data,
    }
