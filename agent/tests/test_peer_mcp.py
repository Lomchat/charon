"""Provider-neutral Charon peer bus and its stdio MCP adapter."""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import peer_mcp  # noqa: E402
from charon_agent.protocol import ERR_SESSION_DEAD, RpcError  # noqa: E402
from charon_agent.server import Server  # noqa: E402


class FakeSession:
    def __init__(self, sid, handle, kind="claude", status="active"):
        self.session_id = sid
        self.handle = handle
        self.kind = kind
        self.status = status
        self.name = handle.title()
        self.cwd = "/srv/project"
        self.inputs = []
        self.input_peer_ids = []

    async def send_input(self, content, *, peer_request_id=None):
        self.inputs.append(content)
        self.input_peer_ids.append(peer_request_id)

    def to_persist(self):
        return {"session_id": self.session_id, "cwd": self.cwd, "status": self.status}


class TestPeerBus(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = Server(
            socket_path=Path(self.tmp.name) / "agent.sock",
            state_path=Path(self.tmp.name) / "state.json",
        )
        self.source = FakeSession("source", "frontend", "claude")
        self.target = FakeSession("target", "api", "codex")
        self.server.sessions = {"source": self.source, "target": self.target}

    async def asyncTearDown(self):
        for task in self.server.peer_timeout_tasks.values():
            task.cancel()
        self.tmp.cleanup()

    async def test_lists_both_providers_with_availability(self):
        result = await self.server._handle_meta_rpc(
            "peer_list", {"source_session_id": "source"}, None)
        self.assertEqual(result["sessions"][0]["handle"], "api")
        self.assertEqual(result["sessions"][0]["provider"], "codex")
        self.assertTrue(result["sessions"][0]["available"])

    async def test_delivery_is_labeled_and_durable(self):
        result = await self.server._handle_meta_rpc("peer_send", {
            "source_session_id": "source", "handle": "@api", "message": "Run the tests",
        }, None)
        self.assertTrue(result["ok"])
        self.assertIn('from="@frontend"', self.target.inputs[0])
        self.assertIn("Run the tests", self.target.inputs[0])
        event = self.server.rings["target"][-1]
        self.assertEqual(event["event"], "external_message")
        self.assertEqual(event["from"], "frontend")
        self.assertEqual(event["from_provider"], "claude")
        self.assertEqual(event["source_session_id"], "source")
        self.assertEqual(event["message_id"], result["message_id"])
        self.assertEqual(event["conversation_id"], result["conversation_id"])
        self.assertEqual(self.target.input_peer_ids, [result["message_id"]])

    async def test_target_final_answer_is_correlated_and_injected_once(self):
        result = await self.server._handle_meta_rpc("peer_send", {
            "source_session_id": "source", "handle": "@api", "message": "bonjour",
        }, None)
        mid = result["message_id"]
        self.server._emit({
            "event": "status", "session_id": "target", "status": "thinking",
            "_peer_request_id": mid,
        })
        self.server._emit({
            "event": "assistant_text", "session_id": "target", "delta": "Bonjour ",
            "_peer_request_id": mid,
        })
        self.server._emit({
            "event": "assistant_text", "session_id": "target", "delta": "@frontend",
            "_peer_request_id": mid,
        })
        self.server._emit({
            "event": "stop", "session_id": "target", "subtype": "",
            "_peer_request_id": mid,
        })
        await asyncio.sleep(0.05)
        row = self.server.peer_messages[mid]
        self.assertEqual(row["status"], "replied")
        self.assertEqual(row["reply"], "Bonjour @frontend")
        replies = [e for e in self.server.rings["source"]
                   if e.get("event") == "external_message"]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["reply_to"], mid)
        self.assertEqual(replies[0]["conversation_id"], result["conversation_id"])
        self.assertEqual(len(self.source.inputs), 1)
        self.assertIn("<charon-peer-reply", self.source.inputs[0])
        self.assertIsNone(self.source.input_peer_ids[0])

        # Replaying/duplicating the terminal frame cannot inject twice.
        self.server._emit({
            "event": "stop", "session_id": "target", "subtype": "",
            "_peer_request_id": mid,
        })
        await asyncio.sleep(0.01)
        self.assertEqual(len(self.source.inputs), 1)

    async def test_status_conversation_and_inbox_are_participant_scoped(self):
        result = await self.server._handle_meta_rpc("peer_send", {
            "source_session_id": "source", "handle": "api", "message": "work",
        }, None)
        status = await self.server._handle_meta_rpc("peer_status", {
            "source_session_id": "source", "message_id": result["message_id"],
        }, None)
        self.assertEqual(status["message"]["status"], "accepted")
        conv = await self.server._handle_meta_rpc("peer_conversation", {
            "source_session_id": "target", "conversation_id": result["conversation_id"],
        }, None)
        self.assertEqual(len(conv["messages"]), 1)
        inbox = await self.server._handle_meta_rpc("peer_inbox", {
            "source_session_id": "source",
        }, None)
        self.assertEqual(inbox["messages"][0]["message_id"], result["message_id"])

    async def test_delivery_to_claude_does_not_depend_on_a_prompt_hook(self):
        # UserPromptSubmit used to mirror native Claude peer envelopes, but a
        # stuck SDK callback could veto every ordinary prompt. The Charon bus
        # owns delivery and persistence before the target provider processes
        # the envelope, so a Claude target needs no prompt hook at all.
        self.target.kind = "claude"
        result = await self.server._handle_meta_rpc("peer_send", {
            "source_session_id": "source", "handle": "api", "message": "bonjour",
        }, None)
        self.assertTrue(result["ok"])
        self.assertEqual(len(self.target.inputs), 1)
        self.assertIn("<charon-peer-message", self.target.inputs[0])
        event = self.server.rings["target"][-1]
        self.assertEqual(event["event"], "external_message")
        self.assertEqual(event["text"], "bonjour")
        self.assertEqual(event["from"], "frontend")

    async def test_sleeping_target_is_rejected(self):
        self.target.status = "sleeping"
        with self.assertRaises(RpcError) as caught:
            await self.server._handle_meta_rpc("peer_send", {
                "source_session_id": "source", "handle": "api", "message": "hello",
            }, None)
        self.assertEqual(caught.exception.code, ERR_SESSION_DEAD)
        self.assertEqual(self.target.inputs, [])

    async def test_target_accepts_only_one_correlated_request_at_a_time(self):
        await self.server._handle_meta_rpc("peer_send", {
            "source_session_id": "source", "handle": "api", "message": "first",
        }, None)
        with self.assertRaises(RpcError) as caught:
            await self.server._handle_meta_rpc("peer_send", {
                "source_session_id": "source", "handle": "api", "message": "second",
            }, None)
        self.assertEqual(caught.exception.code, ERR_SESSION_DEAD)
        self.assertEqual(len(self.target.inputs), 1)

    async def test_target_cannot_manually_echo_reply_to_request_source(self):
        await self.server._handle_meta_rpc("peer_send", {
            "source_session_id": "source", "handle": "api", "message": "question",
        }, None)
        with self.assertRaises(RpcError) as caught:
            await self.server._handle_meta_rpc("peer_send", {
                "source_session_id": "target", "handle": "frontend",
                "message": "manual duplicate reply",
            }, None)
        self.assertIn("automatically", str(caught.exception))
        self.assertEqual(self.source.inputs, [])

    async def test_peer_reply_limit_is_utf8_bytes_not_characters(self):
        result = await self.server._handle_meta_rpc("peer_send", {
            "source_session_id": "source", "handle": "api", "message": "unicode",
        }, None)
        mid = result["message_id"]
        self.server._emit({
            "event": "assistant_text", "session_id": "target", "delta": "🚀" * 9000,
            "_peer_request_id": mid,
        })
        self.server._emit({
            "event": "stop", "session_id": "target", "subtype": "",
            "_peer_request_id": mid,
        })
        await asyncio.sleep(0.05)
        reply = self.server.peer_messages[mid]["reply"]
        self.assertLessEqual(len(reply.encode("utf-8")), 16_384)
        self.assertTrue(reply.endswith("🚀"))

    async def test_completed_ledger_is_pruned_but_live_routes_survive(self):
        for index in range(205):
            mid = f"old-{index}"
            self.server.peer_messages[mid] = {
                "message_id": mid, "source_session_id": "source",
                "target_session_id": "target", "status": "failed",
                "created_at": float(index), "updated_at": float(index),
            }
        self.server.peer_messages["live"] = {
            "message_id": "live", "source_session_id": "source",
            "target_session_id": "target", "status": "processing",
            "created_at": 0.0, "updated_at": 0.0,
        }
        self.server.peer_target_active["target"] = "live"
        persisted = self.server._peer_messages_for_state()
        self.assertEqual(len(persisted), 200)
        self.assertIn("live", self.server.peer_messages)
        self.assertTrue(any(row["message_id"] == "live" for row in persisted))


class TestPeerMcp(unittest.TestCase):
    def test_initialize_and_tool_catalog(self):
        init = peer_mcp._handle({
            "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"},
        }, "source", "/tmp/agent.sock")
        self.assertEqual(init["result"]["serverInfo"]["name"], "charon-peer")
        listed = peer_mcp._handle({"id": 2, "method": "tools/list"},
                                  "source", "/tmp/agent.sock")
        self.assertEqual([x["name"] for x in listed["result"]["tools"]],
                         ["list_sessions", "send_message", "get_message_status",
                          "get_conversation", "list_inbox"])

    def test_send_tool_calls_daemon_with_source_identity(self):
        with mock.patch.object(peer_mcp, "_agent_call", return_value={"ok": True}) as call:
            result = peer_mcp._handle({
                "id": 3, "method": "tools/call", "params": {
                    "name": "send_message",
                    "arguments": {"handle": "api", "message": "hello"},
                },
            }, "source", "/tmp/agent.sock")
        self.assertFalse(result["result"].get("isError", False))
        call.assert_called_once_with("/tmp/agent.sock", "peer_send", {
            "source_session_id": "source", "handle": "api", "message": "hello",
            "conversation_id": None,
        })

    def test_inbox_tool_calls_daemon_with_source_identity(self):
        with mock.patch.object(peer_mcp, "_agent_call", return_value={"ok": True}) as call:
            result = peer_mcp._handle({
                "id": 4, "method": "tools/call", "params": {
                    "name": "list_inbox", "arguments": {},
                },
            }, "source", "/tmp/agent.sock")
        self.assertFalse(result["result"].get("isError", False))
        call.assert_called_once_with("/tmp/agent.sock", "peer_inbox", {
            "source_session_id": "source",
        })


if __name__ == "__main__":
    unittest.main()
