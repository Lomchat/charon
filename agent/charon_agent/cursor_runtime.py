"""Cursor runtime discovery, state paths, and browser-auth bridge (§14.103).

The optional SDK must never block other backends. Browser login uses the
wheel's bundled Node runtime, resolved through `resolve_bridge_path()`.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

CURSOR_AVAILABLE = False
CURSOR_IMPORT_ERROR = ""
CURSOR_SDK_VERSION = ""

try:  # pragma: no cover - depends on the venv of the box
    import cursor_sdk as _cursor_sdk  # type: ignore

    CURSOR_AVAILABLE = True
    try:
        from importlib.metadata import version as _pkg_version

        CURSOR_SDK_VERSION = _pkg_version("cursor-sdk")
    except Exception:
        CURSOR_SDK_VERSION = str(getattr(_cursor_sdk, "__version__", "") or "")
except Exception as e:  # pragma: no cover
    _cursor_sdk = None  # type: ignore
    CURSOR_IMPORT_ERROR = f"{type(e).__name__}: {e}"


class CursorRuntimeError(RuntimeError):
    """The Cursor runtime is not usable on this box."""


def require_sdk() -> Any:
    if not CURSOR_AVAILABLE or _cursor_sdk is None:
        raise CursorRuntimeError(f"cursor-sdk unavailable: {CURSOR_IMPORT_ERROR}")
    return _cursor_sdk


def _bridge_dir() -> Path:
    """Directory holding the vendored `node` + `@cursor/sdk` tree."""
    require_sdk()
    from cursor_sdk._vendor import resolve_bridge_path  # type: ignore

    launcher = Path(resolve_bridge_path())
    # `<bridge>/bin/cursor-sdk-bridge` — the tree root is its grandparent.
    return launcher.parent.parent


def node_binary() -> Path:
    node = _bridge_dir() / "bin" / "node"
    if not node.is_file():
        raise CursorRuntimeError(
            "the cursor-sdk wheel on this box has no bundled Node runtime "
            "(source checkout or a platform-independent wheel); "
            "Cursor sign-in needs it"
        )
    return node


def sdk_entry() -> Path:
    entry = _bridge_dir() / "node_modules" / "@cursor" / "sdk" / "dist" / "esm" / "index.js"
    if not entry.is_file():
        raise CursorRuntimeError("the bundled @cursor/sdk JavaScript entry is missing")
    return entry


def auth_path() -> Path:
    """Where the minted login key lives. Shared host-wide, like ~/.claude and
    ~/.codex: a second hub instance (§14.70) signs in once for the box."""
    return Path(os.path.expanduser("~/.cursor/sdk/auth.json"))


def state_root() -> Path:
    """Instance-scoped checkpoint root; credentials remain host-wide (§14.70)."""
    from .__main__ import _default_state_dir

    root = _default_state_dir() / "cursor-state"
    root.mkdir(parents=True, exist_ok=True)
    return root


# Agents created before the store rule changed live in a JSONL store under the
# instance dir; the SDK's own default store is SQLite under
# `~/.cursor/projects/<slug>/sdk-agent-store/`. The two formats are not
# convertible without reimplementing a private schema, so old agents are not
# migrated — they are READ where they are.
LEGACY_STORE_TYPE = "jsonl"
_LEGACY_INDEX = "agents.ndjson"
# The index is one line per agent; a corrupt or enormous file must not stall a
# resume, so the read is bounded and every parse failure is skipped.
_LEGACY_INDEX_MAX_BYTES = 4 * 1024 * 1024


def legacy_store_root() -> Path:
    """The pre-0.95.3 private store. NOT created — its absence is the norm."""
    home = os.environ.get("CHARON_AGENT_HOME") or str(Path.home() / ".charon")
    return Path(home) / "cursor-state"


def legacy_store_agent_ids() -> set[str]:
    """Agent ids that exist ONLY in the old private store.

    Read from the store's own `agents.ndjson` index rather than guessed: it is
    the one authority on what that store holds, and an id absent from it must
    never be resumed with a store override (that would hide a perfectly good
    agent living in the default store).
    """
    index = legacy_store_root() / _LEGACY_INDEX
    try:
        if index.stat().st_size > _LEGACY_INDEX_MAX_BYTES:
            return set()
        raw = index.read_text("utf-8", "replace")
    except Exception:
        return set()
    out: set[str] = set()
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        agent_id = row.get("agentId") if isinstance(row, dict) else None
        if isinstance(agent_id, str) and agent_id:
            out.add(agent_id)
    return out


def legacy_store_rows() -> "list[dict[str, Any]]":
    """The old private store's index, as rows.

    Read directly rather than through the SDK: `ListAgents` carries no store on
    the wire, so an agent in there is invisible to every listing RPC. Without
    this the import tab could never offer a pre-0.95.3 conversation back after
    its Charon row was deleted.
    """
    index = legacy_store_root() / _LEGACY_INDEX
    try:
        if index.stat().st_size > _LEGACY_INDEX_MAX_BYTES:
            return []
        raw = index.read_text("utf-8", "replace")
    except Exception:
        return []
    rows: "dict[str, dict[str, Any]]" = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if not isinstance(row, dict):
            continue
        agent_id = row.get("agentId")
        if isinstance(agent_id, str) and agent_id:
            # Append-only: a later line supersedes an earlier one for the same id.
            rows[agent_id] = row
    return list(rows.values())


def legacy_store_config(sdk: Any, agent_id: str | None) -> Any | None:
    """The store override to resume ONE pre-existing agent, or None.

    ⚠ Only ever for an id the legacy index actually lists. Applied broadly it
    would re-create the bug it exists to survive: `ListAgents` and
    `ArchiveAgent` carry no store on the wire (§14.103), so anything written
    there is invisible to the import tab and to archive.
    """
    if not agent_id or agent_id not in legacy_store_agent_ids():
        return None
    return sdk.LocalAgentStoreConfig(
        type=LEGACY_STORE_TYPE, root_dir=str(legacy_store_root()),
    )


_LEGACY_MESSAGES_BODY = r"""
  const agentId = process.env.CHARON_CURSOR_LEGACY_AGENT_ID;
  const cwd = process.env.CHARON_CURSOR_LEGACY_CWD;
  const root = process.env.CHARON_CURSOR_LEGACY_STORE;
  const limit = Number(process.env.CHARON_CURSOR_LEGACY_LIMIT || '2000');
  if (!agentId || !cwd || !root) throw new Error('legacy message scope missing');
  const store = new sdk.JsonlLocalAgentStore(root);
  const agent = await sdk.Agent.resume(agentId, { local: { cwd, store } });
  try {
    const full = await agent.platform.checkpointStore.getFullConversation(agentId);
    const turns = Array.from(full.turns || []).slice(-limit);
    const messages = turns.map((turn, index) => ({
      type: 'user', uuid: `${agentId}:${index}`, agent_id: agentId,
      message: { turn: turn.turn },
    }));
    emit({ type: 'messages', messages });
  } finally {
    await agent.close();
  }
"""


async def legacy_store_messages(
    agent_id: str, cwd: str, limit: int,
) -> list[Any]:
    """Read one pre-0.95.3 transcript through its actual JSONL store.

    ``ResumeAgent`` can carry this store, but the Python instance method
    ``list_messages`` calls the static ``ListAgentMessages`` RPC. That proto has
    no store field, so the bridge silently reads the default SQLite store. A
    short-lived public JS agent resolves its full conversation from that store;
    parsing the JSONL checkpoint format in Charon would be private and brittle.
    """
    if agent_id not in legacy_store_agent_ids():
        return []
    lines = await run_node_helper(_LEGACY_MESSAGES_BODY, env={
        "CHARON_CURSOR_LEGACY_AGENT_ID": agent_id,
        "CHARON_CURSOR_LEGACY_CWD": cwd,
        "CHARON_CURSOR_LEGACY_STORE": str(legacy_store_root()),
        "CHARON_CURSOR_LEGACY_LIMIT": str(limit),
    })
    for line in lines:
        if line.get("type") == "messages" and isinstance(line.get("messages"), list):
            return line["messages"]
        if line.get("type") == "error":
            raise CursorRuntimeError(str(line.get("message") or "legacy history read failed"))
    raise CursorRuntimeError("legacy history helper returned no messages result")


def workspace_ref(cwd: str | None) -> str:
    """The workspace a Cursor call is scoped to — and therefore WHICH agent
    store it reads.

    ⚠ Charon must NOT override `LocalAgentOptions.store`. Only `CreateAgent`
    and `ResumeAgent` carry an `AgentOptions` (and thus a store) on the wire;
    `ListAgentsOptions` and `AgentOperationOptions` have no such field at all,
    so archiving and the import list can only ever read the SDK's OWN default
    store — `<home>/<workspace>/sdk-agent-store/<md5(workspace)>`. Pointing
    sessions at a private store therefore wrote conversations nothing else
    could see: an empty import tab and "Agent not found" on archive.
    (`launch_bridge(state_root=…)` is unrelated bookkeeping — the bridge only
    records it in its address file, hashing it differently.)

    So the store is left to the SDK and the CWD is what selects it. Passing the
    same cwd on every call is the whole contract; a call with none lands in a
    different workspace's store and sees nothing."""
    return cwd if isinstance(cwd, str) and cwd else os.path.expanduser("~")


def effective_api_key() -> str | None:
    """The credential a session will actually run under.

    `stored_api_key()` is the login flow's own artefact, but the SDK ALSO
    honours `CURSOR_API_KEY` (its documented BYO-key path, and the only way to
    run this backend on a box signed in by other means). Refusing to start when
    only the env var is set would reject a perfectly configured host.
    """
    stored = stored_api_key()
    if stored:
        return stored
    env = (os.environ.get("CURSOR_API_KEY") or "").strip()
    return env or None


def stored_api_key() -> str | None:
    """The key `Cursor.auth.login()` minted and stored, when it is still usable.

    ⚠ Why Charon reads this file at all. The Node SDK resolves credentials as
    explicit key → `CURSOR_API_KEY` → this stored key. The PYTHON client does
    not: `Agent.create` raises `missing_api_key` before the bridge is ever
    asked, so the stored login would be invisible and every session would
    demand an API key from a human — exactly what the link flow exists to
    avoid. Reading it here keeps the promise: the user clicks a link, the SDK
    mints and stores the key, and the agent hands it back to the SDK.

    Expiry is checked because a lapsed key produces an authentication failure
    mid-turn, which reads as a broken session rather than "sign in again".
    """
    import json
    import time

    path = auth_path()
    try:
        raw = json.loads(path.read_text("utf-8"))
    except Exception:
        return None
    if not isinstance(raw, dict):
        return None
    key = raw.get("apiKey")
    if not isinstance(key, str) or not key:
        return None
    expires = raw.get("apiKeyExpiresAtMs")
    if isinstance(expires, (int, float)) and expires > 0 and expires <= time.time() * 1000:
        return None
    return key


def _script(body: str) -> str:
    """Wrap a snippet with the SDK import and a JSON-line protocol.

    Every line the helper prints on stdout is one JSON object; the caller reads
    them as they come. Failures are reported as a line, not an exit code, so a
    partial run still says why.
    """
    return (
        "const emit = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); };\n"
        "import(process.argv[1]).then(async (sdk) => {\n"
        f"{body}\n"
        "}).catch((e) => {\n"
        "  emit({ type: 'error', message: String((e && e.message) || e) });\n"
        "  process.exit(1);\n"
        "});\n"
    )


async def run_node_helper(
    body: str,
    *,
    timeout: float | None = 30.0,
    env: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Run a short helper to completion and return every JSON line it printed.

    For the long-lived login poll use `spawn_node_helper` instead — this one
    waits for the process to exit.
    """
    proc = await spawn_node_helper(body, env=env)
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        raise CursorRuntimeError("cursor Node helper timed out")
    lines: list[dict[str, Any]] = []
    for raw in (stdout or b"").decode("utf-8", "replace").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except Exception:
            continue
        if isinstance(parsed, dict):
            lines.append(parsed)
    if not lines and proc.returncode not in (0, None):
        detail = (stderr or b"").decode("utf-8", "replace").strip()[-400:]
        raise CursorRuntimeError(f"cursor Node helper failed: {detail or proc.returncode}")
    return lines


async def spawn_node_helper(
    body: str,
    *,
    env: dict[str, str] | None = None,
) -> asyncio.subprocess.Process:
    """Start a helper and hand back the process, its stdout line-readable."""
    node = node_binary()
    entry = sdk_entry()
    child_env = dict(os.environ)
    # The SDK opens a browser when it thinks one is reachable. On a VPS there
    # is none, and Charon surfaces the URL in its own modal, so make the
    # decision explicit rather than relying on SSH detection.
    child_env["NO_OPEN_BROWSER"] = "1"
    if env:
        child_env.update(env)
    return await asyncio.create_subprocess_exec(
        str(node),
        "--input-type=module",
        "-e",
        _script(body),
        str(entry),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=child_env,
    )
