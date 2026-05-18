"""Format des messages JSON-RPC line-delimited entre Charon et l'agent.

Trois types de messages :

- Request  (Charon → Agent)  : {"id": <int>, "method": str, "params": {...}}
- Response (Agent → Charon)  : {"id": <int>, "result": {...}}
                            ou {"id": <int>, "error": {"code": int, "message": str}}
- Event    (Agent → Charon)  : {"event": str, "session_id": str, ...}

Un Event n'a pas d'"id" — c'est ce qui le distingue d'une Response.
"""
from __future__ import annotations

from typing import Any


# ── Erreurs JSON-RPC ─────────────────────────────────────────────────────────
class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# Codes (calqués sur JSON-RPC 2.0 mais étendus pour notre cas)
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


# ── Liste des méthodes (référence) ───────────────────────────────────────────
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
    "set_permission_mode",
    "respond_permission",
    "respond_question",
    "respond_exit_plan",
    "sleep_session",
    "kill_session",
}
