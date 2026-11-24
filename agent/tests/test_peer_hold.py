"""A peer request is answered when the target has REALLY finished (§14.93):
background tasks and the answers it awaits from its own peers included. The
reply is its last answer; a failure reaches the source's model too."""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path

if sys.version_info < (3, 10):
    raise unittest.SkipTest("charon_agent.server requires Python >= 3.10")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import server as server_mod  # noqa: E402
from charon_agent.server import Server  # noqa: E402


class _Fake:
    def __init__(self, sid, handle, status="active"):
        self.session_id = sid
        self.handle = handle
        self.kind = "claude"
        self.status = status
        self.inputs = []

    async def send_input(self, content, **kw):
        self.inputs.append((content, kw))

    def to_persist(self):
        return {"session_id": self.session_id}


class _Sink:
    def __init__(self, out):
        self.out = out

    def send_json(self, payload):
        self.out.append(payload)


def _server(tmp, *fakes):
    base = Path(tmp)
    server = Server(socket_path=base / "agent.sock", state_path=base / "state.json")
    wires = {}
    for fake in fakes:
        server.sessions[fake.session_id] = fake
        wires[fake.session_id] = []
        server.subscribers[fake.session_id] = {_Sink(wires[fake.session_id])}
    return server, wires


def _turn(server, sid, texts, *, tag=None, error=None):
    """One turn of `sid`: status, text blocks split by tool calls, stop."""
    extra = {"_peer_request_id": tag} if tag else {}
    server.sessions[sid].status = "thinking"
    server._emit({"event": "status", "session_id": sid, "status": "thinking", **extra})
    for i, text in enumerate(texts):
        if i:
            server._emit({"event": "tool_use", "session_id": sid, "name": "Bash", **extra})
        server._emit({"event": "assistant_text", "session_id": sid, "delta": text, **extra})
    if error:
        server._emit({"event": "error", "session_id": sid, "msg": error, **extra})
    server._emit({"event": "stop", "session_id": sid, "subtype": "success",
                  **({"is_error": True} if error else {}), **extra})
    server.sessions[sid].status = "active"
    server._emit({"event": "status", "session_id": sid, "status": "active"})


class PeerHoldTestCase(unittest.TestCase):
    def test_background_work_holds_the_reply_until_the_turn_that_reports_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, tgt = _Fake("s", "src"), _Fake("t", "tgt")
            server, wires = _server(tmp, src, tgt)

            async def run():
                mid = (await server.dispatch("peer_send", {
                    "source_session_id": "s", "handle": "tgt", "message": "build it"}, None))["message_id"]
                server._emit({"event": "bg_task", "session_id": "t", "kind": "started",
                              "task_id": "b1", "_peer_request_id": mid})
                _turn(server, "t", ["Looking.", "Build started in the background."], tag=mid)
                await asyncio.sleep(0.05)
                held = dict(server.peer_messages[mid])
                held_inputs = list(src.inputs)
                # The task ends and wakes the model: an untagged turn of its own.
                server._emit({"event": "bg_task", "session_id": "t", "kind": "finished",
                              "task_id": "b1", "status": "completed"})
                _turn(server, "t", ["Checking.", "Build OK: 12 tests passed."])
                await asyncio.sleep(0.05)
                return mid, held, held_inputs

            mid, held, held_inputs = asyncio.run(run())
            self.assertEqual(held["status"], "processing")
            self.assertTrue(held["held"])
            self.assertEqual(held["pending"], {"background_tasks": 1})
            self.assertEqual(held["draft"], "Build started in the background.")
            self.assertEqual(held_inputs, [])
            row = server.peer_messages[mid]
            self.assertEqual(row["status"], "replied")
            self.assertEqual(row["reply"], "Build OK: 12 tests passed.")
            self.assertEqual(len(src.inputs), 1)
            self.assertIn("Build OK: 12 tests passed.", src.inputs[0][0])
            self.assertNotIn("t", server.peer_target_active)
            # Both of the target's turns answered the request: no human finish.
            stops = [p for p in wires["t"] if p.get("event") == "stop"]
            self.assertEqual([p["peer_request_id"] for p in stops], [mid, mid])
            pending = [p.get("pending") for p in wires["s"] if p.get("event") == "peer_message_status"]
            self.assertIn({"background_tasks": 1}, pending)

    def test_work_running_before_the_request_does_not_hold_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, tgt = _Fake("s", "src"), _Fake("t", "tgt")
            server, _wires = _server(tmp, src, tgt)

            async def run():
                # A dev server the user had it start earlier.
                server._emit({"event": "bg_task", "session_id": "t", "kind": "started", "task_id": "dev"})
                mid = (await server.dispatch("peer_send", {
                    "source_session_id": "s", "handle": "tgt", "message": "which port?"}, None))["message_id"]
                _turn(server, "t", ["Port 3000."], tag=mid)
                await asyncio.sleep(0.05)
                return mid

            mid = asyncio.run(run())
            self.assertEqual(server.peer_messages[mid]["status"], "replied")
            self.assertEqual(len(src.inputs), 1)

    def test_a_target_waiting_on_its_own_sub_session_answers_after_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, tgt, sub = _Fake("s", "src"), _Fake("t", "tgt"), _Fake("g", "sub")
            server, _wires = _server(tmp, src, tgt, sub)

            async def run():
                mid = (await server.dispatch("peer_send", {
                    "source_session_id": "s", "handle": "tgt", "message": "find x"}, None))["message_id"]
                inner = (await server.dispatch("peer_send", {
                    "source_session_id": "t", "handle": "sub", "message": "compute x"}, None))["message_id"]
                _turn(server, "t", ["Asked @sub, waiting for it."], tag=mid)
                await asyncio.sleep(0.05)
                held = server.peer_messages[mid].get("pending")
                _turn(server, "g", ["x = 42"], tag=inner)
                await asyncio.sleep(0.05)
                # @sub's answer went into @tgt, which reports in a turn of its own.
                injected = list(tgt.inputs)
                _turn(server, "t", ["Final: x = 42."])
                await asyncio.sleep(0.05)
                return mid, held, injected

            mid, held, injected = asyncio.run(run())
            self.assertEqual(held, {"waiting_on": ["@sub"]})
            self.assertTrue(any("x = 42" in content for content, _ in injected))
            self.assertEqual(server.peer_messages[mid]["reply"], "Final: x = 42.")
            self.assertEqual(len(src.inputs), 1)
            self.assertIn("Final: x = 42.", src.inputs[0][0])

    def test_a_hold_with_no_new_turn_settles_on_its_latest_answer(self):
        settle = server_mod._PEER_SETTLE_S
        server_mod._PEER_SETTLE_S = 0.05
        try:
            with tempfile.TemporaryDirectory() as tmp:
                src, tgt = _Fake("s", "src"), _Fake("t", "tgt")
                server, _wires = _server(tmp, src, tgt)

                async def run():
                    mid = (await server.dispatch("peer_send", {
                        "source_session_id": "s", "handle": "tgt", "message": "serve"}, None))["message_id"]
                    server._emit({"event": "bg_task", "session_id": "t", "kind": "started",
                                  "task_id": "srv", "_peer_request_id": mid})
                    _turn(server, "t", ["Server up on :3000."], tag=mid)
                    await asyncio.sleep(0.2)
                    still_held = server.peer_messages[mid]["status"]
                    server._emit({"event": "bg_task", "session_id": "t", "kind": "finished",
                                  "task_id": "srv", "status": "killed"})
                    await asyncio.sleep(0.2)
                    return mid, still_held

                mid, still_held = asyncio.run(run())
                self.assertEqual(still_held, "processing")
                row = server.peer_messages[mid]
                self.assertEqual(row["status"], "replied")
                self.assertEqual(row["reply"], "Server up on :3000.")
                self.assertEqual(row["release"], "settled")
                self.assertEqual(len(src.inputs), 1)
        finally:
            server_mod._PEER_SETTLE_S = settle

    def test_a_failed_request_reaches_the_source_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, tgt = _Fake("s", "src"), _Fake("t", "tgt")
            server, _wires = _server(tmp, src, tgt)

            async def run():
                mid = (await server.dispatch("peer_send", {
                    "source_session_id": "s", "handle": "tgt", "message": "go"}, None))["message_id"]
                _turn(server, "t", ["Halfway there."], tag=mid, error="API Error: 529 overloaded")
                await asyncio.sleep(0.05)
                return mid

            mid = asyncio.run(run())
            row = server.peer_messages[mid]
            self.assertEqual(row["status"], "failed")
            self.assertEqual(row["reply_injection"], "done")
            self.assertEqual(len(src.inputs), 1)
            envelope = src.inputs[0][0]
            self.assertIn('status="failed"', envelope)
            self.assertIn("529 overloaded", envelope)
            self.assertIn("Halfway there.", envelope)


if __name__ == "__main__":
    unittest.main()
