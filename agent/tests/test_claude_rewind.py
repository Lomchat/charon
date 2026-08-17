"""Claude rewind swaps the live writer onto a native transcript fork."""
import asyncio
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.server import Server  # noqa: E402


class _Session:
    kind = "claude"

    def __init__(self):
        self.claude_session_id = "old-native-id"
        self.cwd = "/srv/project"
        self.name = "review me"
        self.status = "active"
        self._stdin_queue = asyncio.Queue()
        self._stopped = asyncio.Event()
        self._stopped.set()
        self._ready_evt = asyncio.Event()
        self._session_id_emitted = True
        self._main_task = object()
        self._client = object()
        self._client_ctx = object()
        self._cli_title_value = "old"
        self._error_msg = "old error"
        self.events = []
        self.stops = []
        self.starts = 0
        self.saves = 0

    async def stop(self, *, mark="sleeping"):
        self.stops.append(mark)

    async def start(self):
        self.starts += 1

    async def _save_state(self):
        self.saves += 1

    def _emit(self, event, **fields):
        self.events.append((event, fields))


class ClaudeRewindTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="charon-rewind-")
        root = Path(self.tmp.name)
        self.server = Server(socket_path=root / "agent.sock", state_path=root / "state.json")
        self.server.schedule_save = lambda: None

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def test_branches_at_the_kept_message_then_restarts_same_session(self):
        calls = []
        sdk = types.ModuleType("claude_agent_sdk")

        def fork_session(session_id, **kwargs):
            calls.append((session_id, kwargs))
            return {"session_id": "rewound-native-id"}

        sdk.fork_session = fork_session
        session = _Session()
        with patch.dict(sys.modules, {"claude_agent_sdk": sdk}):
            result = await self.server._rewind_claude_session(session, "kept-message-uuid")

        self.assertEqual(calls, [("old-native-id", {
            "directory": "/srv/project",
            "up_to_message_id": "kept-message-uuid",
            "title": "review me",
        })])
        self.assertEqual(session.stops, ["sleeping"])
        self.assertEqual(session.starts, 1)
        self.assertEqual(session.claude_session_id, "rewound-native-id")
        self.assertEqual(session.status, "starting")
        self.assertEqual(session.events, [
            ("session_id", {"claude_session_id": "rewound-native-id"}),
        ])
        self.assertEqual(result["strategy"], "fork")

    async def test_rewind_before_first_prompt_starts_fresh(self):
        session = _Session()
        result = await self.server._rewind_claude_session(session, None)

        self.assertIsNone(session.claude_session_id)
        self.assertEqual(session.events, [])
        self.assertEqual(session.starts, 1)
        self.assertEqual(result["strategy"], "fresh")
        self.assertIsNone(result["claude_session_id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
