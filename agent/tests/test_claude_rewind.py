"""Rewind/compact are DECLARED per backend, and the resume path resets the queue.

`_rewind_claude_session` swaps the live writer onto a native transcript fork —
a Claude mechanism. What the dispatch must NOT do is fall through to it for a
backend that never declared a rewind: it clears `claude_session_id`, which for
every backend but Claude is the ONLY resume handle there is.
"""
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
from charon_agent.protocol import ERR_INVALID_PARAMS, RpcError  # noqa: E402


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


class RewindPolicyTest(unittest.IsolatedAsyncioTestCase):
    """A backend that declares no rewind/compact gets -32602, not Claude's."""

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="charon-policy-")
        root = Path(self.tmp.name)
        self.server = Server(socket_path=root / "agent.sock", state_path=root / "state.json")
        self.server.schedule_save = lambda: None
        self.session = _Session()
        self.session.kind = "cursor"
        self.session.send_inputs = []

        async def send_input(content, **_kw):
            self.session.send_inputs.append(content)
        self.session.send_input = send_input
        self.server.sessions["sid"] = self.session

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def test_rewind_is_refused_instead_of_destroying_the_handle(self):
        with self.assertRaises(RpcError) as ctx:
            await self.server._handle_session_rpc(
                "rollback_session", {"session_id": "sid"}, None)
        self.assertEqual(ctx.exception.code, ERR_INVALID_PARAMS)
        # THE point: the resume handle is untouched.
        self.assertEqual(self.session.claude_session_id, "old-native-id")
        self.assertEqual(self.session.starts, 0)

    async def test_compact_is_refused_instead_of_prompting_the_model(self):
        with self.assertRaises(RpcError) as ctx:
            await self.server._handle_session_rpc(
                "compact_session", {"session_id": "sid"}, None)
        self.assertEqual(ctx.exception.code, ERR_INVALID_PARAMS)
        # `/compact` would have reached the model as a literal prompt.
        self.assertEqual(self.session.send_inputs, [])


class ResumeQueueResetTest(unittest.IsolatedAsyncioTestCase):
    """`resume_session` must hand the new run loop an EMPTY queue.

    `stop()` pushes an EOF sentinel; when the loop has already exited (a failed
    start, or a stop that timed out and cancelled the task) that sentinel STAYS.
    The next loop then emits ready/active and immediately reads it — a session
    that reports itself alive and never executes another turn, with no error
    anywhere.
    """

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="charon-resume-")
        root = Path(self.tmp.name)
        self.server = Server(socket_path=root / "agent.sock", state_path=root / "state.json")
        self.server.schedule_save = lambda: None

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def test_a_leftover_eof_sentinel_never_reaches_the_new_loop(self):
        session = _Session()
        session.status = "sleeping"
        session._main_task = None
        session._stdin_queue.put_nowait(None)          # the stale sentinel
        session._stdin_queue.put_nowait({"content": "x"})  # and stale input
        self.server.sessions["sid"] = session

        result = await self.server._handle_session_rpc(
            "resume_session", {"session_id": "sid"}, None)

        self.assertTrue(result["ok"])
        self.assertEqual(session.starts, 1)
        self.assertTrue(session._stdin_queue.empty())


if __name__ == "__main__":
    unittest.main(verbosity=2)
