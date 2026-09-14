"""Cursor sign-in: the SDK's browser-link flow, driven headlessly (§14.104).

Why this shape. The Python `cursor-sdk` exposes no auth surface at all — it
only *consumes* a credential. The bundled JavaScript SDK does: `Cursor.auth`
runs a PKCE handshake (challenge → browser page → poll `/auth/poll`), mints a
named user API key, and persists it to `~/.cursor/sdk/auth.json`, which every
later SDK call picks up automatically. So Charon drives that flow through the
wheel's own Node runtime (`cursor_runtime`) and never handles a key itself.

For the user this is the Claude flow (§14.64), one step shorter: we surface the
URL, they open it anywhere, and there is **no code to paste back** — the helper
polls until the browser finishes. Nothing here is a device code (§14.61); the
verifier never leaves the host except in the poll body.

The helper process must stay ALIVE for the whole attempt: it holds the verifier
that redeems the login, and only the process that generated it can complete it.
Hence one module-level attempt (a second start cancels the first) reaped on
success, cancel, or TTL — the same discipline §14.64 needed for the same
reason, and for the same failure if we skip it (an orphan poll running for
twenty minutes against a modal nobody has open).

RPCs (the hub POLLS — no events, no session binding):
    cursor_login_start   {}         → {ok, login_id, url}
    cursor_login_status  {login_id} → {ok, status: 'pending'|'success'|'error', ...}
    cursor_login_cancel  {login_id} → {ok}
    cursor_auth_status   {}         → {ok, logged_in, email?, expires_at?}
    cursor_logout        {}         → {ok}
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any, Optional

from .cursor_runtime import (
    CursorRuntimeError,
    auth_path,
    effective_api_key,
    run_node_helper,
    spawn_node_helper,
    stored_api_key,
)

# The SDK's poll gives up around 20 minutes; reap a beat earlier so a forgotten
# modal never leaves a helper (and its Node runtime) alive past its usefulness.
_TTL_S = 19 * 60

# Named so a human can find and revoke it in the Cursor dashboard's API-key
# list — an opaque key nobody can attribute is a key nobody dares delete.
_KEY_NAME = "Charon"


class _Attempt:
    def __init__(self, login_id: str, proc: Any) -> None:
        self.login_id = login_id
        self.proc = proc
        self.url: Optional[str] = None
        self.status = "pending"           # pending | success | error
        self.error: Optional[str] = None
        self.email: Optional[str] = None
        self.started_at = time.time()
        self.reader: Optional[asyncio.Task] = None
        self.watchdog: Optional[asyncio.Task] = None
        # Set the moment there is something to report — a url to show, or a
        # verdict. `login_start` waits on THIS rather than polling: a
        # `sleep(0.1)` loop is a busy wait that also makes the caller pay up to
        # 100ms for a link that already arrived.
        self.settled = asyncio.Event()


_current: Optional[_Attempt] = None


async def _reap(attempt: Optional[_Attempt]) -> None:
    """Kill the helper and stop reading it. Safe to call repeatedly."""
    if attempt is None:
        return
    for task in (attempt.reader, attempt.watchdog):
        if task is not None and not task.done():
            task.cancel()
    attempt.settled.set()
    try:
        if attempt.proc.returncode is None:
            attempt.proc.kill()
            await asyncio.wait_for(attempt.proc.wait(), timeout=5.0)
    except Exception:
        pass


async def _expire(attempt: _Attempt) -> None:
    """Reap abandoned login helpers on an independent TTL (§14.104)."""
    try:
        await asyncio.sleep(_TTL_S)
    except asyncio.CancelledError:
        raise
    if attempt.status != "pending":
        return
    attempt.status = "error"
    attempt.error = "the sign-in link expired — start again"
    attempt.watchdog = None
    await _reap(attempt)


_LOGIN_BODY = """
  const opts = {
    openBrowser: false,
    onLoginUrl: (url) => emit({ type: 'url', url }),
    apiKeyName: %s,
  };
  const res = await sdk.Cursor.auth.login(opts);
  emit({ type: 'ok', email: res && res.email, expiresAtMs: res && res.apiKeyExpiresAtMs });
""" % json.dumps(_KEY_NAME)


async def _read_attempt(attempt: _Attempt) -> None:
    """Consume the helper's JSON lines until it resolves.

    A line we cannot parse is skipped rather than fatal: the helper shares
    stdout with whatever Node itself may print, and a stray warning must not
    fail a login that is otherwise fine.
    """
    try:
        while True:
            raw = await attempt.proc.stdout.readline()
            if not raw:
                break
            try:
                msg = json.loads(raw.decode("utf-8", "replace").strip())
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            kind = msg.get("type")
            if kind == "url" and isinstance(msg.get("url"), str):
                attempt.url = msg["url"]
                attempt.settled.set()
            elif kind == "ok":
                attempt.email = msg.get("email") or None
                attempt.status = "success"
                break
            elif kind == "error":
                attempt.error = str(msg.get("message") or "login failed")
                attempt.status = "error"
                break
    except asyncio.CancelledError:
        raise
    except Exception as e:
        attempt.status = "error"
        attempt.error = f"{type(e).__name__}: {e}"
    finally:
        if attempt.status == "pending":
            # The helper exited without a verdict: report it rather than
            # leaving the modal spinning until its own timeout.
            stderr = b""
            try:
                stderr = await attempt.proc.stderr.read()
            except Exception:
                pass
            detail = stderr.decode("utf-8", "replace").strip()[-300:]
            attempt.status = "error"
            attempt.error = detail or "the sign-in helper exited before completing"
        attempt.settled.set()


async def login_start(_params: dict[str, Any] | None = None) -> dict[str, Any]:
    global _current
    # A second start supersedes the first — its verifier is now unreachable
    # from any modal the user still has open.
    await _reap(_current)
    _current = None

    proc = await spawn_node_helper(_LOGIN_BODY)
    attempt = _Attempt(uuid.uuid4().hex, proc)
    attempt.reader = asyncio.create_task(_read_attempt(attempt))
    # Reaped on its own clock, not only when someone polls (see _expire).
    attempt.watchdog = asyncio.create_task(_expire(attempt))
    _current = attempt

    # Wait for the URL specifically: without it the modal has nothing to show,
    # and returning "started" would strand the user on a spinner.
    try:
        await asyncio.wait_for(attempt.settled.wait(), timeout=30.0)
    except asyncio.TimeoutError:
        await _reap(attempt)
        _current = None
        raise CursorRuntimeError("timed out waiting for the Cursor sign-in link")
    if attempt.status == "error":
        err = attempt.error or "login failed"
        await _reap(attempt)
        _current = None
        raise CursorRuntimeError(err)
    return {"ok": True, "login_id": attempt.login_id, "url": attempt.url}


async def login_status(params: dict[str, Any]) -> dict[str, Any]:
    global _current
    login_id = str((params or {}).get("login_id") or "")
    attempt = _current
    if attempt is None or attempt.login_id != login_id:
        return {"ok": False, "status": "error", "error": "no such login attempt"}

    # Belt and braces: the watchdog owns the TTL, this catches a clock jump
    # (a suspended VPS) where the sleep has not yet come due.
    if attempt.status == "pending" and time.time() - attempt.started_at > _TTL_S:
        attempt.status = "error"
        attempt.error = "the sign-in link expired — start again"
        await _reap(attempt)

    out: dict[str, Any] = {"ok": True, "status": attempt.status}
    if attempt.url:
        out["url"] = attempt.url
    if attempt.status == "success":
        out["email"] = attempt.email
        await _reap(attempt)
        _current = None
    elif attempt.status == "error":
        out["error"] = attempt.error or "login failed"
        await _reap(attempt)
        _current = None
    return out


async def login_cancel(params: dict[str, Any]) -> dict[str, Any]:
    global _current
    login_id = str((params or {}).get("login_id") or "")
    attempt = _current
    if attempt is not None and (not login_id or attempt.login_id == login_id):
        await _reap(attempt)
        _current = None
    return {"ok": True}


_STATUS_BODY = """
  const st = await sdk.Cursor.auth.status();
  emit({ type: 'status', ...st });
"""

_LOGOUT_BODY = """
  await sdk.Cursor.auth.logout();
  emit({ type: 'ok' });
"""


async def auth_status(_params: dict[str, Any] | None = None) -> dict[str, Any]:
    """Is this box signed in to Cursor?

    Authoritative, like `claude auth status --json` (§14.64): the stored file's
    mere existence is not the answer — the SDK also checks the key is unexpired
    and was minted against the backend this process talks to.

    ⚠ It must judge the SAME credential a SESSION will run under
    (`effective_api_key`), not just the stored file. A box configured through
    `CURSOR_API_KEY` starts sessions perfectly well, so answering "signed out"
    for it flips `cursorLoggedIn=0` and turns every launcher into a sign-in
    button for a backend that was never broken.

    The NEGATIVE half needs no helper, and this probe runs on a 24h sweep across
    the whole fleet: with no credential at all there is nothing for
    `Cursor.auth.status()` to validate, so skip the ~129 MB Node spawn and
    answer from the file. An env-only key skips it too — `auth.status()` reports
    on the STORED login, so it would say "logged out" about a key it would
    nonetheless happily use.
    """
    if not stored_api_key():
        if effective_api_key():
            return {"ok": True, "logged_in": True, "source": "env"}
        return {"ok": True, "logged_in": False}
    lines = await run_node_helper(_STATUS_BODY, timeout=20.0)
    for msg in lines:
        if msg.get("type") == "status":
            logged_in = msg.get("status") == "logged-in"
            out: dict[str, Any] = {"ok": True, "logged_in": logged_in}
            if msg.get("email"):
                out["email"] = msg["email"]
            if msg.get("apiKeyExpiresAtMs"):
                out["expires_at_ms"] = msg["apiKeyExpiresAtMs"]
            return out
    return {"ok": False, "logged_in": False, "error": "no status reported"}


async def logout(_params: dict[str, Any] | None = None) -> dict[str, Any]:
    await run_node_helper(_LOGOUT_BODY, timeout=20.0)
    # Local-only, exactly like the SDK's own logout: the minted key stays valid
    # until it expires or a human revokes it in the dashboard. Say so rather
    # than implying the credential is dead.
    return {"ok": True, "revoked": False, "auth_path": str(auth_path())}
