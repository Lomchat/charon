"""Per-process account homes. Never mutate the daemon's environment."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from . import global_accounts

DEFAULT = "default"


def profile_id(value: Any = None) -> str:
    if value is None or value == DEFAULT:
        return DEFAULT
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{16}", value):
        raise ValueError("invalid account profile")
    return value


def config_dir(provider: str, value: Any = None) -> Path:
    pid = profile_id(value)
    if provider not in ("claude", "codex"):
        raise ValueError("account profiles require Claude or Codex")
    if pid != DEFAULT and provider == "codex" and global_accounts.is_global(provider, pid):
        # A global Codex account keeps the default home: its threads stay
        # where they are and its token reaches each app-server in memory.
        pid = DEFAULT
    if pid == DEFAULT:
        var = "CLAUDE_CONFIG_DIR" if provider == "claude" else "CODEX_HOME"
        return Path(os.environ.get(var) or str(Path.home() / f".{provider}"))
    root = Path(os.environ.get("CHARON_AGENT_HOME") or str(Path.home() / ".charon"))
    return root / "accounts" / provider / pid


# A profile is a second LOGIN, not a second installation: these entries of the
# default home are linked in, so settings, plugins, skills and instructions stay
# one copy. Credentials, `.claude.json` (account + per-project CLI state) and
# history (`projects/`, Codex `sessions/`) stay private to the profile.
SHARED_ENTRIES = {
    "claude": ("settings.json", "settings.local.json", "CLAUDE.md", "skills",
               "agents", "commands", "plugins", "output-styles"),
    "codex": ("config.toml", "AGENTS.md", "AGENTS.override.md", "prompts",
              "skills", "rules"),
}


def link_shared(provider: str, directory: Path) -> None:
    """Link each existing default entry the profile does not have yet.

    Never replaces anything already there: a real file is the user's choice to
    diverge for this account. Re-run on every use, so an entry created later in
    the default home reaches existing profiles too.
    """
    source = config_dir(provider, DEFAULT)
    try:
        if source.resolve() == directory.resolve():
            return
    except OSError:
        return
    for name in SHARED_ENTRIES.get(provider, ()):
        target = directory / name
        if os.path.lexists(target) or not (source / name).exists():
            continue
        try:
            target.symlink_to(source / name)
        except OSError:
            pass


def profile_env(provider: str, value: Any = None) -> dict[str, str]:
    pid = profile_id(value)
    if pid == DEFAULT:
        return {}
    if global_accounts.is_global(provider, pid):
        return _global_env(provider, pid)
    directory = config_dir(provider, pid)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    link_shared(provider, directory)
    if provider == "claude":
        # Host-managed auth skips the profile's on-disk OAuth credentials.
        return {"CLAUDE_CONFIG_DIR": str(directory), "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "", "ANTHROPIC_API_KEY": "",
                "ANTHROPIC_AUTH_TOKEN": "", "CLAUDE_CODE_OAUTH_TOKEN": "",
                "ANTHROPIC_BASE_URL": "", "CLAUDE_CODE_USE_BEDROCK": "",
                "CLAUDE_CODE_USE_VERTEX": "", "CLAUDE_CODE_USE_FOUNDRY": ""}
    return {"CODEX_HOME": str(directory), "OPENAI_API_KEY": "",
            "CODEX_API_KEY": ""}


def _global_env(provider: str, pid: str) -> dict[str, str]:
    """Env of a hub-owned account (global_accounts): the same auth pinning as
    a profile, but the home shares history with the default one."""
    if provider == "claude":
        directory = global_accounts.prepare_claude(pid)
        return {"CLAUDE_CONFIG_DIR": str(directory), "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "", "ANTHROPIC_API_KEY": "",
                "ANTHROPIC_AUTH_TOKEN": "", "CLAUDE_CODE_OAUTH_TOKEN": "",
                "ANTHROPIC_BASE_URL": "", "CLAUDE_CODE_USE_BEDROCK": "",
                "CLAUDE_CODE_USE_VERTEX": "", "CLAUDE_CODE_USE_FOUNDRY": ""}
    if provider == "codex":
        return {"CODEX_HOME": str(global_accounts.default_home("codex")), "OPENAI_API_KEY": "", "CODEX_API_KEY": ""}
    return {}


def signature(provider: str, value: Any = None) -> str:
    """Opaque generation used to discard events from a previous login."""
    pid = profile_id(value)
    if pid != DEFAULT and global_accounts.is_global(provider, pid):
        h = hashlib.sha256(b"global")
        h.update(json.dumps(global_accounts.credentials(provider, pid), sort_keys=True).encode())
        h.update(json.dumps(global_accounts.meta(provider, pid), sort_keys=True).encode())
        return h.hexdigest()
    directory = config_dir(provider, value)
    names = (".credentials.json",) if provider == "claude" else ("auth.json",)
    h = hashlib.sha256()
    for name in names:
        try:
            h.update((directory / name).read_bytes())
        except OSError:
            h.update(b"missing")
    if provider == "claude":
        h.update(json.dumps(_claude_account(value), sort_keys=True).encode())
    return h.hexdigest()


def _claude_account(value: Any, keys: tuple[str, ...] = ('accountUuid', 'organizationUuid', 'emailAddress')) -> dict[str, Any]:
    path = Path.home() / '.claude.json' if profile_id(value) == DEFAULT and not os.environ.get('CLAUDE_CONFIG_DIR') else config_dir('claude', value) / '.claude.json'
    try:
        account = json.loads(path.read_text()).get('oauthAccount') or {}
        return {key: account[key] for key in keys if isinstance(account.get(key), str)}
    except (OSError, ValueError, TypeError, AttributeError):
        return {}


def _claude_display_name(pid: str, email: str) -> str | None:
    """The account's own public name (`oauthAccount.displayName`, else
    `fullName`), only when that file describes the login the CLI verified."""
    account = _claude_account(pid, ('emailAddress', 'displayName', 'fullName'))
    if account.get('emailAddress', '').casefold() != email.casefold():
        return None
    name = (account.get('displayName') or account.get('fullName') or '').strip()
    return name or None


def _with_display_name(provider: str, pid: str, result: dict[str, Any]) -> dict[str, Any]:
    result.pop("display_name", None)
    email = result.get("email")
    if provider == "claude" and result.get("logged_in") and isinstance(email, str) and email:
        name = _claude_display_name(pid, email)
        if name:
            result["display_name"] = name
    return result


def _identity(provider: str, pid: str, email: str, organization: Any) -> str:
    """Prefer stable native account ids, with verified CLI identity as fallback."""
    identity = [provider, email.casefold(), organization]
    if provider == 'claude':
        account = _claude_account(pid)
        if (account.get('emailAddress', '').casefold() == email.casefold()
                and account.get('accountUuid') and account.get('organizationUuid')):
            identity = [provider, account['accountUuid'], account['organizationUuid']]
    else:
        try:
            account = json.loads((config_dir(provider, pid) / 'auth.json').read_text())
            native_id = (account.get('tokens') or {}).get('account_id')
            if isinstance(native_id, str) and native_id:
                identity = [provider, native_id, email.casefold()]
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    return hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest()


_cache: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
_locks: dict[tuple[str, str], asyncio.Lock] = {}


async def status(provider: str, value: Any = None, *, force: bool = False) -> dict[str, Any]:
    pid = profile_id(value)
    key = (provider, pid)
    async with _locks.setdefault(key, asyncio.Lock()):
        sig = signature(provider, pid)
        if pid != DEFAULT and global_accounts.is_global(provider, pid):
            result = global_accounts.status(provider, pid)
            result.update({"provider": provider, "account_profile": pid, "generation": sig,
                           "config_dir": str(config_dir(provider, pid))})
            _cache[key] = (sig, dict(result))
            return result
        cached = _cache.get(key)
        if not force and cached and cached[0] == sig:
            # The public name is outside the generation (renaming an account is
            # not a new login): re-read it, a cheap local file.
            return _with_display_name(provider, pid, dict(cached[1]))
        if provider == "codex":
            from .codex_login import auth_status
            result = dict(await auth_status(pid))
        elif provider == "claude":
            env = {**os.environ, **profile_env(provider, pid)}
            env["PATH"] = f"{Path.home()}/.local/bin:{Path.home()}/.claude/bin:" + env.get("PATH", "")
            proc = None
            try:
                proc = await asyncio.create_subprocess_exec(
                    "claude", "auth", "status", "--json", env=env,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                stdout, _ = await asyncio.wait_for(proc.communicate(), 15)
                data = json.loads(stdout)
                result = {"ok": True, "logged_in": data.get("loggedIn") is True}
                for source, target in (("email", "email"), ("orgName", "organization"),
                                       ("subscriptionType", "subscription_type"), ("authMethod", "auth_method")):
                    if isinstance(data.get(source), str):
                        result[target] = data[source]
            except Exception:
                result = {"ok": False, "error": "Could not read Claude account"}
            finally:
                if proc and proc.returncode is None:
                    proc.kill()
                    await proc.wait()
        else:
            raise ValueError("account profiles require Claude or Codex")
        result.update({"provider": provider, "account_profile": pid, "generation": sig,
                       "config_dir": str(config_dir(provider, pid))})
        email = result.get("email")
        if result.get("logged_in") and email:
            result["account_key"] = _identity(provider, pid, email, result.get('organization'))
            _with_display_name(provider, pid, result)
        else:
            result["account_key"] = None
        if result.get("ok"):
            _cache[key] = (sig, dict(result))
        return result


def cached_account_key(provider: str, value: Any = None) -> str | None:
    """Last verified identity, without probing: for a session whose start-time
    probe failed, so its live gauges are not dropped as another account's."""
    try:
        cached = _cache.get((provider, profile_id(value)))
    except ValueError:
        return None
    key = cached[1].get("account_key") if cached else None
    return key if isinstance(key, str) else None


def sdk_call(profile: Any, function: str, *args: Any, **kwargs: Any) -> Any:
    """SDK transcript helpers resolve a process-global config dir: isolate them.

    BLOCKING (an isolated profile spawns an interpreter): call it through
    `asyncio.to_thread`, never on the event loop."""
    if profile_id(profile) == DEFAULT:
        import claude_agent_sdk
        return getattr(claude_agent_sdk, function)(*args, **kwargs)
    import subprocess
    script = """import dataclasses,json,sys,claude_agent_sdk as sdk
request=json.loads(sys.stdin.read())
def serial(v):
 if dataclasses.is_dataclass(v): return dataclasses.asdict(v)
 if hasattr(v,'model_dump'): return v.model_dump(mode='json')
 if hasattr(v,'__dict__'): return vars(v)
 return str(v)
try:
 result=getattr(sdk,request['function'])(*request['args'],**request['kwargs'])
 print(json.dumps({'ok':True,'value':result},default=serial))
except Exception as e:
 print(json.dumps({'ok':False,'error':str(e),'type':type(e).__name__}))
"""
    env = {**os.environ, **profile_env("claude", profile)}
    completed = subprocess.run([sys.executable, "-c", script], input=json.dumps(
        {"function": function, "args": args, "kwargs": kwargs}), text=True,
        capture_output=True, env=env, timeout=30, check=True)
    result = json.loads(completed.stdout)
    if not result.get("ok"):
        if result.get("type") == "FileNotFoundError":
            raise FileNotFoundError(result["error"])
        raise ValueError(result.get("error", "SDK transcript operation failed"))
    return result["value"]
