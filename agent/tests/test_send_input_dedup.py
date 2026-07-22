"""Fault-injection tests for the send_input idempotency key (Codex 13.3).

Drives Server.dispatch directly with a fake session — no SDK, no socket.
Covers the exact scenarios the counter-review required:
  - two CONCURRENT calls with the same client_message_id → exactly one
    execution, the other answers {duplicate: true};
  - a REFUSED first attempt releases the id → a retry with the same id
    executes (failed attempts must stay retryable);
  - ids are per-session (same id on another session executes).
"""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path

# server.py transitively imports session.py, which uses 3.10+ syntax (PEP 604
# unions at runtime). Recognized environmental prerequisite → skip, exactly
# like the daemon integration test (CI runs 3.10 and 3.13 where this executes).
if sys.version_info < (3, 10):
    raise unittest.SkipTest("charon_agent.server requires Python >= 3.10")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.server import Server  # noqa: E402


class _FakeSession:
    """Just enough of AgentSession for the send_input dispatch path."""

    def __init__(self, delay: float = 0.0, fail_times: int = 0,
                 fail_after_delay: bool = False) -> None:
        self.status = "active"
        self.calls: list[str] = []
        self._delay = delay
        self._fail_times = fail_times
        self._fail_after_delay = fail_after_delay

    async def send_input(self, content: str) -> None:
        if self._fail_times > 0 and not self._fail_after_delay:
            self._fail_times -= 1
            raise RuntimeError("injected send_input failure")
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._fail_times > 0 and self._fail_after_delay:
            self._fail_times -= 1
            raise RuntimeError("injected slow send_input failure")
        self.calls.append(content)


class SendInputDedupTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.server = Server(socket_path=base / "agent.sock", state_path=base / "state.json")

    def tearDown(self):
        self._tmp.cleanup()

    def _dispatch(self, params):
        return self.server.dispatch("send_input", params, None)

    def test_concurrent_same_id_executes_once(self):
        async def run():
            fake = _FakeSession(delay=0.05)
            self.server.sessions["s1"] = fake
            p = {"session_id": "s1", "content": "hello", "client_message_id": "cm1"}
            r1, r2 = await asyncio.gather(self._dispatch(dict(p)), self._dispatch(dict(p)))
            return fake.calls, r1, r2

        calls, r1, r2 = asyncio.run(run())
        self.assertEqual(calls, ["hello"], "the prompt must execute exactly once")
        dups = [r for r in (r1, r2) if r.get("duplicate")]
        self.assertEqual(len(dups), 1, "exactly one call must be answered as duplicate")

    def test_lost_response_then_retry_is_duplicate(self):
        async def run():
            fake = _FakeSession()
            self.server.sessions["s1"] = fake
            p = {"session_id": "s1", "content": "hi", "client_message_id": "cm2"}
            r1 = await self._dispatch(dict(p))
            # Hub timed out, response lost → retry with the SAME id.
            r2 = await self._dispatch(dict(p))
            return fake.calls, r1, r2

        calls, r1, r2 = asyncio.run(run())
        self.assertEqual(calls, ["hi"])
        self.assertNotIn("duplicate", r1)
        self.assertTrue(r2.get("duplicate"))

    def test_failed_attempt_releases_the_id(self):
        async def run():
            fake = _FakeSession(fail_times=1)
            self.server.sessions["s1"] = fake
            p = {"session_id": "s1", "content": "retry-me", "client_message_id": "cm3"}
            with self.assertRaises(RuntimeError):
                await self._dispatch(dict(p))
            # The refused attempt must NOT poison the id: the retry executes.
            r2 = await self._dispatch(dict(p))
            return fake.calls, r2

        calls, r2 = asyncio.run(run())
        self.assertEqual(calls, ["retry-me"])
        self.assertNotIn("duplicate", r2)

    def test_inflight_failure_is_shared_no_phantom_accept(self):
        """Codex 16.4: B arrives while A is still in flight; A then FAILS.
        Neither call may report success — else the hub believes a prompt
        landed that never executed — and a third retry must really run."""
        async def run():
            fake = _FakeSession(delay=0.05, fail_times=1, fail_after_delay=True)
            self.server.sessions["s1"] = fake
            p = {"session_id": "s1", "content": "risky", "client_message_id": "cm4"}
            r1, r2 = await asyncio.gather(
                self._dispatch(dict(p)), self._dispatch(dict(p)),
                return_exceptions=True,
            )
            # Both A and B must fail (shared outcome, no phantom accept).
            failures = [r for r in (r1, r2) if isinstance(r, Exception)]
            # A clean third retry executes for real.
            r3 = await self._dispatch(dict(p))
            return fake.calls, failures, r3

        calls, failures, r3 = asyncio.run(run())
        self.assertEqual(len(failures), 2,
                         "duplicate must share the in-flight FAILURE, not fake success")
        self.assertEqual(calls, ["risky"], "the retry after failure executes once")
        self.assertNotIn("duplicate", r3)

    def test_ids_are_scoped_per_session(self):
        async def run():
            a, b = _FakeSession(), _FakeSession()
            self.server.sessions["sa"] = a
            self.server.sessions["sb"] = b
            await self._dispatch({"session_id": "sa", "content": "x", "client_message_id": "shared"})
            r = await self._dispatch({"session_id": "sb", "content": "x", "client_message_id": "shared"})
            return a.calls, b.calls, r

        ca, cb, r = asyncio.run(run())
        self.assertEqual(ca, ["x"])
        self.assertEqual(cb, ["x"], "same id on another session must execute")
        self.assertNotIn("duplicate", r)


if __name__ == "__main__":
    unittest.main()
