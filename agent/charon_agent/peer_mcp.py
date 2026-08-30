"""Tiny stdio MCP server exposing Charon's provider-neutral peer bus.

The Claude and Codex SDKs both know how to launch stdio MCP servers.  This
process deliberately contains no provider code: it calls the already-running
Charon daemon over its Unix socket, which owns the live session registry and
therefore is the only place that can route a handle safely.
"""
from __future__ import annotations

import json
import socket
import sys
from typing import Any


PEER_MODEL_INSTRUCTIONS = (
    "This is the authoritative channel for Charon @handles on this VPS. When "
    "the user mentions an @handle or asks you to contact another Charon session, "
    "you MUST call list_sessions and then send_message; do not use provider-native "
    "collaboration tools and never claim a handle is unavailable without listing. "
    "send_message confirms acceptance, not a reply. Use get_message_status, "
    "get_conversation or list_inbox when asked whether a peer answered. Charon "
    "automatically returns the target turn's final answer, so an incoming peer "
    "request should be answered normally; do not send a redundant acknowledgement. "
    "Only contact the peer again for a genuine follow-up and avoid autonomous loops."
)
_INSTRUCTIONS = PEER_MODEL_INSTRUCTIONS

_TOOLS = [
    {
        "name": "list_sessions",
        "description": (
            "List Charon sessions on this VPS, including their stable @handle, "
            "provider and whether they can currently receive a message."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
    },
    {
        "name": "send_message",
        "description": (
            "Send a message to another live Charon session by stable handle. "
            "Pass the handle with or without @. The target sees who sent it."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "handle": {"type": "string", "description": "Target session handle, e.g. api or @api"},
                "message": {"type": "string", "description": "Message or task for the target session"},
                "conversation_id": {
                    "type": "string",
                    "description": "Optional existing conversation id for an explicit follow-up",
                },
            },
            "required": ["handle", "message"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False},
    },
    {
        "name": "get_message_status",
        "description": (
            "Get the authoritative state of one sent or received peer message: "
            "accepted, processing, replied, failed or timed_out."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"message_id": {"type": "string"}},
            "required": ["message_id"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
    },
    {
        "name": "get_conversation",
        "description": "Get the correlated messages and replies in one Charon peer conversation.",
        "inputSchema": {
            "type": "object",
            "properties": {"conversation_id": {"type": "string"}},
            "required": ["conversation_id"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
    },
    {
        "name": "list_inbox",
        "description": (
            "List recent peer requests and replies involving this session. Use this "
            "instead of guessing whether another session has answered."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True},
    },
]


def _agent_call(socket_path: str, method: str, params: dict[str, Any]) -> Any:
    request = {"id": 1, "method": method, "params": params}
    raw = (json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(30.0)
        sock.connect(socket_path)
        sock.sendall(raw)
        chunks = bytearray()
        while b"\n" not in chunks:
            part = sock.recv(65536)
            if not part:
                raise RuntimeError("Charon daemon closed the peer connection")
            chunks.extend(part)
            if len(chunks) > 1_048_576:
                raise RuntimeError("Charon peer response is too large")
    response = json.loads(bytes(chunks).split(b"\n", 1)[0])
    error = response.get("error") if isinstance(response, dict) else None
    if isinstance(error, dict):
        raise RuntimeError(str(error.get("message") or "Charon peer request failed"))
    return response.get("result") if isinstance(response, dict) else None


def _result_text(value: Any, *, is_error: bool = False) -> dict[str, Any]:
    text = json.dumps(value, ensure_ascii=False, indent=2, default=str)
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if is_error:
        result["isError"] = True
    return result


def _handle(request: dict[str, Any], source_session_id: str, socket_path: str) -> dict[str, Any] | None:
    request_id = request.get("id")
    method = request.get("method")
    # MCP notifications never receive a response.
    if request_id is None:
        return None
    if method == "initialize":
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": params.get("protocolVersion") or "2025-06-18",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "charon-peer", "version": "1.0.0"},
                "instructions": _INSTRUCTIONS,
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": _TOOLS}}
    if method == "tools/call":
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        name = params.get("name")
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        try:
            if name == "list_sessions":
                value = _agent_call(socket_path, "peer_list", {"source_session_id": source_session_id})
            elif name == "send_message":
                value = _agent_call(socket_path, "peer_send", {
                    "source_session_id": source_session_id,
                    "handle": args.get("handle"),
                    "message": args.get("message"),
                    "conversation_id": args.get("conversation_id"),
                })
            elif name == "get_message_status":
                value = _agent_call(socket_path, "peer_status", {
                    "source_session_id": source_session_id,
                    "message_id": args.get("message_id"),
                })
            elif name == "get_conversation":
                value = _agent_call(socket_path, "peer_conversation", {
                    "source_session_id": source_session_id,
                    "conversation_id": args.get("conversation_id"),
                })
            elif name == "list_inbox":
                value = _agent_call(socket_path, "peer_inbox", {
                    "source_session_id": source_session_id,
                })
            else:
                raise RuntimeError(f"unknown peer tool: {name}")
            result = _result_text(value)
        except Exception as exc:
            result = _result_text({"ok": False, "error": str(exc)}, is_error=True)
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32601, "message": f"method not found: {method}"},
    }


def run(source_session_id: str, socket_path: str) -> int:
    """Serve MCP JSON-RPC on stdin/stdout until the provider closes it."""
    for line in sys.stdin:
        try:
            raw = json.loads(line)
            if not isinstance(raw, dict):
                raise ValueError("request must be an object")
            response = _handle(raw, source_session_id, socket_path)
        except Exception as exc:
            response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"parse error: {exc}"},
            }
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0
