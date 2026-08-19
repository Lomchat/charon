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

    async def send_input(self, content):
        self.inputs.append(content)


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


class TestPeerMcp(unittest.TestCase):
    def test_initialize_and_tool_catalog(self):
        init = peer_mcp._handle({
            "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"},
        }, "source", "/tmp/agent.sock")
        self.assertEqual(init["result"]["serverInfo"]["name"], "charon-peer")
        listed = peer_mcp._handle({"id": 2, "method": "tools/list"},
                                  "source", "/tmp/agent.sock")
        self.assertEqual([x["name"] for x in listed["result"]["tools"]],
                         ["list_sessions", "send_message"])

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
        })


if __name__ == "__main__":
    unittest.main()
