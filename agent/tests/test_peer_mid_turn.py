"""A peer message sent to a BUSY session goes in at once, and its reply is
exactly what the target wrote after reading it (§14.93)."""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path

if sys.version_info < (3, 10):
    raise unittest.SkipTest("charon_agent.server requires Python >= 3.10")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.server import Server  # noqa: E402
from charon_agent.session import AgentSession  # noqa: E402


class _Fake:
    def __init__(self, sid, handle, status):
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


class PeerMidTurnTestCase(unittest.TestCase):
    def test_busy_target_takes_the_message_and_returns_only_its_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            server = Server(socket_path=base / "agent.sock", state_path=base / "state.json")
            server.sessions["s"] = _Fake("s", "src", "thinking")
            server.sessions["t"] = _Fake("t", "tgt", "thinking")
            wire = []
            server.subscribers["t"] = {_Sink(wire)}

            async def run():
                res = await server.dispatch(
                    "peer_send", {"source_session_id": "s", "handle": "tgt", "message": "hi"}, None)
                mid = res["message_id"]
                # The turn it interrupted (untagged), then the same turn before
                # the provider read the message (pending): neither is the reply.
                server._emit({"event": "assistant_text", "session_id": "t", "delta": "for the human "})
                server._emit({"event": "assistant_text", "session_id": "t", "delta": "still human ",
                              "_peer_request_pending": mid})
                server._emit({"event": "assistant_text", "session_id": "t", "delta": "peer answer",
                              "_peer_request_id": mid})
                server._emit({"event": "stop", "session_id": "t", "subtype": "success",
                              "_peer_request_id": mid, "_peer_shared": True})
                await asyncio.sleep(0.05)
                return mid

            mid = asyncio.run(run())
            self.assertEqual(len(server.sessions["t"].inputs), 1)
            self.assertEqual(server.sessions["t"].inputs[0][1]["peer_request_id"], mid)
            row = server.peer_messages[mid]
            self.assertEqual(row["status"], "replied")
            self.assertEqual(row["reply"], "peer answer")
            stop = next(p for p in wire if p.get("event") == "stop")
            # The shared turn's finish stays the human's: the hub notifies it.
            self.assertIsNone(stop["peer_request_id"])
            self.assertFalse([k for p in wire for k in p if k.startswith("_peer")])

    def test_claude_correlates_to_the_turn_that_reads_the_message(self):
        events = []
        s = AgentSession("t", cwd="/tmp", name=None, permission_mode="default",
                         claude_session_id=None, emit=events.append, on_state_change=lambda: None)

        def text(delta):
            s._emit("assistant_text", delta=delta)

        def finish():
            s._emit("stop", subtype="success")
            s._end_turn()
            s._peer_note_result()

        async def run():
            # 1. Read at the turn's next API request: shares that turn.
            s._begin_turn()
            s._peer_turn_done.clear()
            s._peer_pending_id = "m1"
            text("before")
            s._peer_note_request_start()
            text("after")
            finish()
            self.assertTrue(s._peer_turn_done.is_set())
            # 2. Sent during the last answer: the CLI runs it as the next turn.
            s._begin_turn()
            s._peer_turn_done.clear()
            s._peer_pending_id = "m2"
            text("tail")
            finish()
            self.assertFalse(s._peer_turn_done.is_set())
            s._peer_note_request_start()
            s._begin_turn()
            text("answer")
            finish()
            self.assertTrue(s._peer_turn_done.is_set())

        asyncio.run(run())
        rows = [(e["event"], e.get("delta"), e.get("_peer_request_id"),
                 e.get("_peer_request_pending"), e.get("_peer_shared"))
                for e in events if e["event"] in ("assistant_text", "stop")]
        self.assertEqual(rows, [
            ("assistant_text", "before", None, "m1", None),
            ("assistant_text", "after", "m1", None, None),
            ("stop", None, "m1", None, True),
            ("assistant_text", "tail", None, "m2", None),
            ("stop", None, None, "m2", None),
            ("assistant_text", "answer", "m2", None, None),
            ("stop", None, "m2", None, None),
        ])


if __name__ == "__main__":
    unittest.main()
