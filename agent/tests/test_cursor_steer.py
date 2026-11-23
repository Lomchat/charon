"""A message sent while a Cursor run works joins that run (`run.steer`), and
never reaches the agent twice (§14.93)."""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.cursor_session import CursorSession  # noqa: E402


class FeatureUnavailableError(Exception):
    pass


class NetworkError(Exception):
    pass


class _Run:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.steered = []

    async def steer(self, text):
        self.steered.append(text)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class CursorSteerTestCase(unittest.TestCase):
    def _session(self, events):
        s = CursorSession("c", cwd="/tmp", name=None, permission_mode="default",
                          claude_session_id=None, emit=events.append, on_state_change=lambda: None)
        s.status = "thinking"
        return s

    def test_steer_outcomes(self):
        events = []
        s = self._session(events)

        async def run():
            queued = lambda: s._stdin_queue.qsize()  # noqa: E731
            s._run = _Run("complete_delivered", "revert_to_followup")
            await s.send_input("joins the run")
            self.assertEqual(queued(), 0)
            await s.send_input("too late for it")
            self.assertEqual(queued(), 1)
            s._stdin_queue.get_nowait()

            # Unknown outcome: raised, never queued (it may have arrived).
            s._run = _Run(NetworkError("reset"))
            with self.assertRaises(RuntimeError):
                await s.send_input("maybe delivered")
            self.assertEqual(queued(), 0)

            # No steering on this account: queued, and not tried again.
            s._run = _Run(FeatureUnavailableError("no"))
            await s.send_input("a")
            await s.send_input("b")
            self.assertEqual(s._run.steered, ["a"])
            self.assertEqual(queued(), 2)

        asyncio.run(run())

    def test_peer_steered_in_shares_the_run_and_a_peer_run_takes_nothing(self):
        events = []
        s = self._session(events)

        async def run():
            s._run = _Run("complete_delivered")
            await s.send_input("hi", peer_request_id="m1")
            s._emit("assistant_text", delta="reply")
            s._emit("stop")
            # A run a peer request owns: a human message waits for its own turn.
            await s.send_input("human")
            self.assertEqual(s._run.steered, ["hi"])
            self.assertEqual(s._stdin_queue.qsize(), 1)

        asyncio.run(run())
        stop = next(e for e in events if e["event"] == "stop")
        self.assertEqual((stop["_peer_request_id"], stop.get("_peer_shared")), ("m1", True))

    def test_a_steer_is_read_at_once_until_the_run_says_when(self):
        events = []
        s = self._session(events)
        taken = lambda: [e["client_message_ids"] for e in events if e["event"] == "inputs_taken"]  # noqa: E731

        async def run():
            s._run = _Run("complete_delivered", "complete_delivered")
            await s.send_input("first", client_message_id="c1")
            self.assertEqual(taken(), [["c1"]])   # no echo known: read now
            s._on_delta({"type": "user-message-appended", "userMessage": {"text": "first"}})
            await s.send_input("second", client_message_id="c2")
            self.assertEqual(taken(), [["c1"]])   # the run will say
            s._on_delta({"type": "user-message-appended", "userMessage": {"text": "an other"}})
            self.assertEqual(taken(), [["c1"]])
            s._on_delta({"type": "user-message-appended", "userMessage": {"text": "second"}})
            self.assertEqual(taken(), [["c1"], ["c2"]])
            self.assertEqual(s._close_turn_inputs(), ["c1", "c2"])

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
