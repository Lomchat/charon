"""Format of line-delimited JSON-RPC messages between Charon and the agent.

Three message types:

- Request  (Charon → Agent)  : {"id": <int>, "method": str, "params": {...}}
- Response (Agent → Charon)  : {"id": <int>, "result": {...}}
                            or {"id": <int>, "error": {"code": int, "message": str}}
- Event    (Agent → Charon)  : {"event": str, "session_id": str, ...}

An Event has no "id" — that's what distinguishes it from a Response.
"""
from __future__ import annotations

from typing import Any


# ── JSON-RPC errors ──────────────────────────────────────────────────────────
class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# Codes (modeled on JSON-RPC 2.0 but extended for our case)
ERR_PARSE = -32700
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL = -32603
ERR_SESSION_NOT_FOUND = -32000
ERR_SESSION_DEAD = -32001
ERR_SDK_UNAVAILABLE = -32010


# ── Serialization helpers ────────────────────────────────────────────────────
def make_response(req_id: int, result: Any) -> dict[str, Any]:
    return {"id": req_id, "result": result}


def make_error(req_id: int | None, code: int, message: str) -> dict[str, Any]:
    payload: dict[str, Any] = {"error": {"code": code, "message": message}}
    if req_id is not None:
        payload["id"] = req_id
    return payload


def make_event(event: str, session_id: str | None, **fields: Any) -> dict[str, Any]:
    msg: dict[str, Any] = {"event": event}
    if session_id is not None:
        msg["session_id"] = session_id
    msg.update(fields)
    return msg


# ── List of methods (reference) ──────────────────────────────────────────────
METHODS = {
    "hello",
    "ping",
    "list_sessions",
    # Account usage (the `/usage` equivalent) — reads the OAuth token and GETs
    # api.anthropic.com/api/oauth/usage. Daemon-level (account-scoped), so it's
    # a meta method. Agent >= 0.14.0. See agent/charon_agent/usage.py, §14.58.
    "get_usage",
    # Codex (OpenAI) support (agent >= 0.15.0). Model catalog + account usage
    # for Codex-kind sessions. See agent/charon_agent/codex_session.py.
    "list_codex_models",
    "get_codex_usage",
    # Codex ChatGPT DEVICE-CODE login (agent >= 0.16.0): headless-safe
    # `codex login` — start returns verification_url + user_code, the hub
    # polls status until the user completes on any device. codex_login.py.
    # NB: no braces in these comments — check-protocol-sync.mjs's regex
    # stops at the first closing brace inside the METHODS block.
    "codex_login_start",
    "codex_login_status",
    "codex_login_cancel",
    # Filesystem navigation for the hub's path autocomplete - subdirs of a
    # given path over the persistent pipe. Agent >= 0.17.0, fsnav.py.
    "list_dir",
    # Read-only file tree for the ToolPanel explorer (agent >= 0.25.0,
    # fsnav.py). fs_list is one directory at a time - lazy expansion, so a
    # node_modules never costs anything until it is opened. fs_read returns
    # utf-8 for text and base64 for binaries. Both are contained under a
    # caller-supplied root, which is the session cwd.
    "fs_list",
    "fs_read",
    # Cheap open-editor change token (agent >= 0.28.0). No content transfer.
    "fs_stat",
    # Text write for the in-browser editor (agent >= 0.26.0). Atomic, and
    # gated on an expected sha so a save cannot silently clobber a file a
    # coding agent wrote in the meantime.
    "fs_write",
    # Explorer context menu (agent >= 0.27.0): create, rename, delete. Same
    # containment as the reads, and none of them clobbers silently.
    "fs_mkdir",
    "fs_rename",
    "fs_delete",
    # Search across the tree for the ToolPanel search tab (agent >= 0.29.0):
    # text inside files, or file names, with include/exclude globs. Read-only,
    # bounded in files, matches and wall clock - and it reports every bound it
    # hit, because a silently truncated search reads as an empty one.
    "fs_search",
    # Source control for the hub's git panel (agent >= 0.24.0, git.py). Scoped
    # to the repo containing a path, not to a session - the hub polls
    # git_status while a session is on screen, so it rides the persistent pipe
    # instead of one ssh per poll. Writes are an allow-list: add+commit, push,
    # pull --rebase, per-file discard. No reset, no force push.
    "git_status",
    # A folder OF projects is a normal cwd (/srv, /var/www/html): one call
    # returns every checkout at or below it, since --show-toplevel only walks
    # up (agent >= 0.29.0).
    "git_workspace",
    # Branches (agent >= 0.31.0): list with drift vs upstream AND vs HEAD,
    # switch/create, fetch (what makes `behind` a real number), safe delete.
    "git_branches",
    "git_checkout",
    "git_fetch",
    "git_delete_branch",
    "git_diff",
    "git_commit",
    "git_push",
    "git_pull",
    "git_discard",
    "start_session",
    "resume_session",
    "subscribe",
    "unsubscribe",
    "send_input",
    "interrupt",
    "force_stop",
    "set_permission_mode",
    "set_model",
    "set_effort",
    "respond_permission",
    "respond_question",
    "respond_exit_plan",
    "sleep_session",
    "kill_session",
    # Persistent PTY shells (agent >= 0.7.0). See agent/charon_agent/shell.py.
    # All routing through the same _emit pipeline as sessions, with shell_id
    # as the channel key (in the `session_id` JSON field for protocol reuse).
    "shell_list",
    "shell_start",
    "shell_input",
    "shell_resize",
    "shell_subscribe",
    "shell_unsubscribe",
    "shell_kill",
    # Global, output-free shell lifecycle watch (agent >= 0.8.0). Charon uses
    # it to receive shell_idle ("finished something") + shell_status/exit for
    # ALL shells without subscribing to the high-volume output byte stream.
    "shell_watch",
    "shell_unwatch",
}
