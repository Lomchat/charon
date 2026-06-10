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
