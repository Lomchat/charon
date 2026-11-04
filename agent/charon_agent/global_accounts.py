"""Hub-owned provider accounts (CLAUDE.md §14.115).

The hub is the ONLY holder of refresh tokens: it signs each account in once,
refreshes it itself and pushes SHORT-LIVED credentials here (`accounts_set`).
Nothing on a VPS can rotate a login, so the per-VPS expiries and the
refresh-token races of local logins are gone.

An account id is a 16-hex `accountProfile` (account_profiles.profile_id), so
every session path that already threads a profile works unchanged; the marker
file below is what makes a profile GLOBAL. Per provider:

- Claude: `<root>/accounts/claude/<id>/` is the session's CLAUDE_CONFIG_DIR,
  holding a `.credentials.json` WITHOUT refresh token (the CLI re-reads it at
  every request and cannot refresh it) and a private `.claude.json`. History
  and settings are LINKED to the default home, so any account can resume any
  conversation.
- Codex: sessions keep the default CODEX_HOME (threads stay where they are);
  the access token is handed to each app-server in memory
  (`account/login/start` chatgptAuthTokens), which ignores any `auth.json`.
- Cursor: the API key is passed explicitly to each session.

Codex and Cursor credentials are also kept on disk (0600) so sessions the
daemon restores at boot run before the hub reconnects.
"""
from __future__ import annotations

import errno
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Optional

PROVIDERS = ("claude", "codex", "cursor")
MARKER = ".charon-global"
_ID = re.compile(r"[a-f0-9]{16}")
_CRED_FILE = {"codex": "codex-tokens.json", "cursor": "cursor-key.json"}

# Claude: entries of the default home every account shares. Settings and
# instructions (what profiles already shared) plus everything a conversation
# needs to resume, rewind or remember. Never the credentials, `.claude.json`
# (per-account identity + project state), backups or account-scoped caches.
CLAUDE_SHARED = ("settings.json", "settings.local.json", "CLAUDE.md", "skills",
                 "agents", "commands", "plugins", "output-styles")
CLAUDE_HISTORY = ("projects", "file-history", "todos", "plans", "tasks",
                  "session-env", "sessions", "shell-snapshots", "paste-cache",
                  "history.jsonl", "ide")
_HISTORY_FILES = ("history.jsonl",)

_lock = threading.Condition()
_meta: dict[tuple[str, str], dict[str, Any]] = {}


def _root() -> Path:
    return Path(os.environ.get("CHARON_AGENT_HOME") or str(Path.home() / ".charon"))


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_ID.fullmatch(value))


def account_dir(provider: str, account_id: str) -> Path:
    if provider not in PROVIDERS or not valid_id(account_id):
        raise ValueError("invalid global account")
    return _root() / "accounts" / provider / account_id


def is_global(provider: str, account_id: Any) -> bool:
    if provider not in PROVIDERS or not valid_id(account_id):
        return False
    return (account_dir(provider, account_id) / MARKER).is_file()


def default_home(provider: str) -> Path:
    var = "CLAUDE_CONFIG_DIR" if provider == "claude" else "CODEX_HOME"
    return Path(os.environ.get(var) or str(Path.home() / f".{provider}"))


def _write_private(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data.encode())
    finally:
        os.close(fd)
    os.replace(tmp, path)


def meta(provider: str, account_id: str) -> dict[str, Any]:
    """Public identity the hub pushed (email, plan, account_key…)."""
    key = (provider, account_id)
    with _lock:
        if key not in _meta:
            try:
                _meta[key] = json.loads((account_dir(provider, account_id) / MARKER).read_text())
            except (OSError, ValueError):
                _meta[key] = {}
        return dict(_meta[key])


# ── Claude home ──────────────────────────────────────────────────────────────

def _link(target: Path, source: Path) -> None:
    if os.path.lexists(target):
        return
    try:
        target.symlink_to(source)
    except OSError:
        pass


def prepare_claude(account_id: str) -> Path:
    """Make the account's CLAUDE_CONFIG_DIR share the default home. Re-run
    before every use: an entry created later in the default home reaches
    every account, and a history dir is created there first so it is never
    born private inside one account."""
    directory = account_dir("claude", account_id)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    home = default_home("claude")
    for name in CLAUDE_HISTORY:
        source = home / name
        if not os.path.lexists(source):
            try:
                if name in _HISTORY_FILES:
                    source.parent.mkdir(parents=True, exist_ok=True)
                    source.touch()
                else:
                    source.mkdir(parents=True, exist_ok=True)
            except OSError:
                continue
        _link(directory / name, source)
    for name in CLAUDE_SHARED:
        if (home / name).exists():
            _link(directory / name, home / name)
    return directory


def _seed_claude_json(directory: Path, account: dict[str, Any]) -> None:
    """Private `.claude.json`: a one-time copy of the default one (per-project
    trust, MCP servers…) with this account as `oauthAccount`. Only written
    when absent or naming another account — the CLI owns it afterwards."""
    path = directory / ".claude.json"
    wanted = account.get("oauthAccount")
    if not isinstance(wanted, dict) or not wanted.get("accountUuid"):
        return
    try:
        current = json.loads(path.read_text())
        if (current.get("oauthAccount") or {}).get("accountUuid") == wanted["accountUuid"]:
            return
    except (OSError, ValueError, AttributeError):
        current = None
    if current is None:
        source = Path.home() / ".claude.json" if not os.environ.get("CLAUDE_CONFIG_DIR") else default_home("claude") / ".claude.json"
        try:
            current = json.loads(source.read_text())
            if not isinstance(current, dict):
                current = {}
        except (OSError, ValueError):
            current = {}
    current["oauthAccount"] = wanted
    current.setdefault("hasCompletedOnboarding", True)
    _write_private(path, json.dumps(current))


def _apply_claude(account_id: str, account: dict[str, Any]) -> None:
    creds = account.get("credentials") or {}
    token = creds.get("accessToken")
    if not isinstance(token, str) or not token:
        raise ValueError("claude credentials need accessToken")
    oauth = {"accessToken": token}
    for key in ("expiresAt", "scopes", "subscriptionType", "rateLimitTier", "refreshTokenExpiresAt"):
        if creds.get(key) is not None:
            oauth[key] = creds[key]
    directory = prepare_claude(account_id)
    _seed_claude_json(directory, creds)
    # NEVER a refreshToken: a CLI that could refresh would rotate the hub's
    # login away from it (the SDK redacts it the same way for its children).
    _write_private(directory / ".credentials.json", json.dumps({"claudeAiOauth": oauth}))


def claude_token(account_id: str) -> Optional[str]:
    try:
        data = json.loads((account_dir("claude", account_id) / ".credentials.json").read_text())
        token = (data.get("claudeAiOauth") or {}).get("accessToken")
        return token if isinstance(token, str) and token else None
    except (OSError, ValueError, AttributeError):
        return None


# ── Codex / Cursor credentials ───────────────────────────────────────────────

def credentials(provider: str, account_id: str) -> Optional[dict[str, Any]]:
    if provider == "claude":
        token = claude_token(account_id)
        return {"accessToken": token} if token else None
    try:
        data = json.loads((account_dir(provider, account_id) / _CRED_FILE[provider]).read_text())
        return data if isinstance(data, dict) else None
    except (OSError, ValueError, KeyError):
        return None


def _apply_secret(provider: str, account_id: str, account: dict[str, Any]) -> None:
    creds = account.get("credentials") or {}
    if provider == "codex":
        if not (isinstance(creds.get("accessToken"), str) and isinstance(creds.get("accountId"), str)):
            raise ValueError("codex credentials need accessToken and accountId")
        keep = {k: creds.get(k) for k in ("accessToken", "accountId", "planType")}
    else:
        if not isinstance(creds.get("apiKey"), str) or not creds["apiKey"]:
            raise ValueError("cursor credentials need apiKey")
        keep = {"apiKey": creds["apiKey"], "expiresAt": creds.get("expiresAt")}
    directory = account_dir(provider, account_id)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    _write_private(directory / _CRED_FILE[provider], json.dumps(keep))


def codex_login_params(account_id: str) -> Optional[dict[str, Any]]:
    """`account/login/start` params for an app-server, or None."""
    creds = credentials("codex", account_id)
    if not creds or not creds.get("accessToken"):
        return None
    return {"type": "chatgptAuthTokens", "accessToken": creds["accessToken"],
            "chatgptAccountId": creds.get("accountId"), "chatgptPlanType": creds.get("planType")}


def codex_refresh_answer(account_id: str) -> dict[str, Any]:
    """Answer to the app-server's `account/chatgptAuthTokens/refresh`: the
    newest token the hub pushed (the hub refreshes days before expiry, so a
    request here means "hand me what you have")."""
    params = codex_login_params(account_id)
    if params is None:
        raise RuntimeError("no Charon credentials for this Codex account")
    return {k: params[k] for k in ("accessToken", "chatgptAccountId", "chatgptPlanType")}


def cursor_api_key(account_id: str) -> Optional[str]:
    creds = credentials("cursor", account_id)
    key = (creds or {}).get("apiKey")
    return key if isinstance(key, str) and key else None


# ── accounts_set ─────────────────────────────────────────────────────────────

_PUBLIC = ("name", "email", "display_name", "organization", "plan", "account_key")


def apply(params: dict[str, Any]) -> dict[str, Any]:
    """Write pushed accounts; drop removed ones. `replace` = the push is the
    hub's whole list, so any other global account here is gone."""
    accounts = params.get("accounts") or []
    if not isinstance(accounts, list):
        raise ValueError("accounts must be a list")
    applied, errors = [], []
    seen: set[tuple[str, str]] = set()
    for account in accounts:
        if not isinstance(account, dict):
            continue
        provider, account_id = account.get("provider"), account.get("id")
        try:
            if provider not in PROVIDERS or not valid_id(account_id):
                raise ValueError("invalid account")
            seen.add((provider, account_id))
            if account.get("credentials") is not None:
                if provider == "claude":
                    _apply_claude(account_id, account)
                else:
                    _apply_secret(provider, account_id, account)
            public = {k: account.get(k) for k in _PUBLIC if account.get(k) is not None}
            public["updated_at"] = int(time.time() * 1000)
            _write_private(account_dir(provider, account_id) / MARKER, json.dumps(public))
            with _lock:
                _meta[(provider, account_id)] = public
                _lock.notify_all()
            applied.append(account_id)
        except Exception as e:  # one bad entry must not block the others
            errors.append({"id": account_id, "error": str(e)[:200]})
    removed = []
    targets = set()
    for item in params.get("remove") or []:
        if isinstance(item, dict) and item.get("provider") in PROVIDERS and valid_id(item.get("id")):
            targets.add((item["provider"], item["id"]))
    if params.get("replace"):
        for provider in PROVIDERS:
            base = _root() / "accounts" / provider
            try:
                entries = list(base.iterdir())
            except OSError:
                continue
            for entry in entries:
                if valid_id(entry.name) and (entry / MARKER).is_file() and (provider, entry.name) not in seen:
                    targets.add((provider, entry.name))
    for provider, account_id in targets:
        directory = account_dir(provider, account_id)
        if not (directory / MARKER).is_file():
            continue  # never a legacy profile
        shutil.rmtree(directory, ignore_errors=True)
        with _lock:
            _meta.pop((provider, account_id), None)
        removed.append(account_id)
    return {"ok": not errors, "applied": applied, "removed": removed, "errors": errors}


def listing() -> list[dict[str, Any]]:
    """What this box holds (no secrets): the hub's reconnect diff."""
    out = []
    for provider in PROVIDERS:
        base = _root() / "accounts" / provider
        try:
            entries = sorted(base.iterdir())
        except OSError:
            continue
        for entry in entries:
            if valid_id(entry.name) and (entry / MARKER).is_file():
                out.append({"provider": provider, "id": entry.name,
                            "has_credentials": credentials(provider, entry.name) is not None,
                            "updated_at": meta(provider, entry.name).get("updated_at")})
    return out


def status(provider: str, account_id: str) -> dict[str, Any]:
    """The `account_profiles` answer for a global account: the hub verified
    the login, so this reports what was pushed instead of probing a CLI."""
    info = meta(provider, account_id)
    logged_in = credentials(provider, account_id) is not None
    out: dict[str, Any] = {"ok": True, "logged_in": logged_in, "global": True}
    for src, dst in (("email", "email"), ("organization", "organization"),
                     ("plan", "subscription_type"), ("display_name", "display_name")):
        if info.get(src):
            out[dst] = info[src]
    out["account_key"] = info.get("account_key") if logged_in else None
    return out


# ── Migration: legacy profile history → the shared home ──────────────────────

def _merge_tree(source: Path, target: Path, label: str, counts: dict[str, int]) -> None:
    """Hard-link (copy across devices) every file of `source` missing from
    `target`. A memory file present on both sides with other content is kept
    beside it under a suffixed name; an index (MEMORY.md) gains the lines it
    lacks. Never overwrites, never deletes: the legacy home stays intact."""
    for dirpath, dirnames, filenames in os.walk(source, followlinks=False):
        rel = Path(dirpath).relative_to(source)
        dest_dir = target / rel
        try:
            dest_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            counts["errors"] += 1
            continue
        for name in filenames:
            src, dst = Path(dirpath) / name, dest_dir / name
            if os.path.islink(src):
                continue
            if os.path.lexists(dst):
                try:
                    same = src.stat().st_ino == dst.stat().st_ino or src.read_bytes() == dst.read_bytes()
                except OSError:
                    same = False
                if same:
                    counts["same"] += 1
                elif name == "MEMORY.md":
                    text = dst.read_text(errors="replace")
                    have = text.splitlines()
                    extra = [l for l in src.read_text(errors="replace").splitlines() if l.strip() and l not in have]
                    if extra:
                        with open(dst, "a") as f:
                            f.write(("\n" if text and not text.endswith("\n") else "") + "\n".join(extra) + "\n")
                    counts["merged"] += 1
                elif "memory" in rel.parts:
                    alt = dest_dir / f"{Path(name).stem}.from-{label}{Path(name).suffix}"
                    if not os.path.lexists(alt):
                        shutil.copy2(src, alt)
                    counts["renamed"] += 1
                else:
                    counts["conflicts"] += 1
                continue
            try:
                os.link(src, dst)
            except OSError as e:
                if e.errno not in (errno.EXDEV, errno.EPERM, errno.EMLINK):
                    counts["errors"] += 1
                    continue
                shutil.copy2(src, dst)
            counts["linked"] += 1


def merge_history(provider: str, profile: str) -> dict[str, Any]:
    """Make a legacy Claude profile's conversations resumable from the shared
    home (§14.115 migration). Idempotent."""
    if provider != "claude":
        return {"ok": True, "skipped": "only Claude profiles keep private history"}
    if not valid_id(profile):
        raise ValueError("invalid profile")
    source_root = _root() / "accounts" / "claude" / profile
    if (source_root / MARKER).is_file():
        return {"ok": True, "skipped": "already a global account"}
    home = default_home("claude")
    counts = {"linked": 0, "same": 0, "merged": 0, "renamed": 0, "conflicts": 0, "errors": 0}
    for name in CLAUDE_HISTORY:
        src = source_root / name
        if not src.exists() or os.path.islink(src):
            continue
        if src.is_dir():
            _merge_tree(src, home / name, profile[:6], counts)
        elif name == "history.jsonl":
            dst = home / name
            have = set(dst.read_text(errors="replace").splitlines()) if dst.exists() else set()
            extra = [l for l in src.read_text(errors="replace").splitlines() if l and l not in have]
            if extra:
                with open(dst, "a") as f:
                    f.write("\n".join(extra) + "\n")
            counts["merged"] += 1
    return {"ok": counts["errors"] == 0, **counts}


def transcript_exists(native_id: str) -> bool:
    """Whether the shared home holds a conversation (migration check)."""
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", native_id or ""):
        return False
    projects = default_home("claude") / "projects"
    try:
        return any(projects.glob(f"*/{native_id}.jsonl"))
    except OSError:
        return False
