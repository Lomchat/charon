"""Two daemons on one state.json — the failure this file exists to prevent.

Observed 2026-08-20 on the self-hosting box: a leftover daemon (started by
hand, reparented to init) and the systemd one both bound ~/.charon/agent.sock,
because startup unlinked whatever socket it found without asking whether
anybody was still listening.  Both restored the SAME sessions from the SAME
state.json; the loser's Codex app-server kept each thread's native writer
lock, so every resume the hub asked for answered "already has an active
writer" and three sessions were stuck in `error` with 3.6 GB of orphan CLIs
next to them (CLAUDE.md §14.97).

Covered here:
  - a socket FILE nobody listens on is stale → startup may take it;
  - a socket somebody answers on is OWNED → startup refuses (and leaves it
    alone: the refusal must not disconnect the live daemon's clients);
  - a socket that accepts but never answers still counts as owned;
  - `resume_session` stops a still-live previous run instead of starting a
    second one over it.
"""
import asyncio
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path

if sys.version_info < (3, 10):
    raise unittest.SkipTest("charon_agent.server requires Python >= 3.10")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.server import AlreadyRunning, Server  # noqa: E402


class _FakeSession:
    """Enough of a session for the resume_session dispatch path."""

    def __init__(self) -> None:
        self.status = "sleeping"
        self.handle = None
        self.stopped_with: list[str] = []
        self.started = 0
        self._stopped = asyncio.Event()
        self._ready_evt = asyncio.Event()
        self._session_id_emitted = True
        self._main_task = None

    async def stop(self, *, mark: str = "sleeping") -> None:
        self.stopped_with.append(mark)
        if self._main_task is not None:
            self._main_task.cancel()
            self._main_task = None

    async def start(self) -> None:
        self.started += 1
        self.status = "active"


class SingleInstanceTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.server = Server(
            socket_path=self.base / "agent.sock",
            state_path=self.base / "state.json",
        )

    def tearDown(self):
        self._tmp.cleanup()

    # ── the probe ────────────────────────────────────────────────────────────
    def test_socket_file_with_no_listener_is_stale(self):
        # Bind the raw socket, then abandon it exactly as a killed daemon does.
        # asyncio.start_unix_server cannot model this portably: Python 3.13
        # removes its socket path on close by default (cleanup_socket=True).
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            stale.bind(str(self.server.socket_path))
        finally:
            stale.close()

        self.assertTrue(self.server.socket_path.exists())
        self.assertIsNone(asyncio.run(self.server._socket_owner_pid()))

    def test_live_owner_is_named_by_its_pid(self):
        async def go():
            async def handler(reader, writer):
                await reader.readline()
                writer.write(json.dumps(
                    {"id": 0, "result": {"pid": 4242}}).encode() + b"\n")
                await writer.drain()
                writer.close()

            srv = await asyncio.start_unix_server(
                handler, path=str(self.server.socket_path))
            try:
                return await self.server._socket_owner_pid()
            finally:
                # close() only — 3.12's wait_closed() also waits on every
                # connection handler, and these fakes deliberately leave one
                # hanging (that IS the scenario under test).
                srv.close()

        self.assertEqual(asyncio.run(go()), 4242)

    def test_accepting_but_mute_still_counts_as_alive(self):
        async def go():
            async def mute(reader, writer):
                await reader.read()      # accept, answer nothing, wait for EOF
                writer.close()

            srv = await asyncio.start_unix_server(
                mute, path=str(self.server.socket_path))
            try:
                # Accepts the connection, answers nothing: a wedged daemon is
                # still an owner — stealing its socket is never the fix.
                return await self.server._socket_owner_pid()
            finally:
                # close() only — 3.12's wait_closed() also waits on every
                # connection handler, and these fakes deliberately leave one
                # hanging (that IS the scenario under test).
                srv.close()

        self.assertEqual(asyncio.run(go()), 0)

    # ── the refusal ──────────────────────────────────────────────────────────
    def test_serve_refuses_and_leaves_the_live_socket_alone(self):
        async def go():
            async def handler(reader, writer):
                await reader.readline()
                writer.write(b'{"id":0,"result":{"pid":31337}}\n')
                await writer.drain()
                writer.close()

            srv = await asyncio.start_unix_server(
                handler, path=str(self.server.socket_path))
            try:
                with self.assertRaises(AlreadyRunning) as caught:
                    await self.server.serve()
                # The owner is named, so the operator knows what to kill.
                self.assertIn("31337", str(caught.exception))
                # And it is still reachable: a refusal that unlinked the path
                # would cut the live daemon off every future hub connection.
                self.assertTrue(self.server.socket_path.exists())
                _, probe = await asyncio.open_unix_connection(
                    str(self.server.socket_path))
                probe.close()
                await asyncio.wait_for(probe.wait_closed(), timeout=5)
            finally:
                # close() only — 3.12's wait_closed() also waits on every
                # connection handler, and these fakes deliberately leave one
                # hanging (that IS the scenario under test).
                srv.close()

        asyncio.run(go())

    # ── resume must not start a second run over a live one ───────────────────
    def test_resume_stops_a_still_running_previous_run(self):
        async def go():
            s = _FakeSession()
            s._main_task = asyncio.create_task(asyncio.sleep(30))
            self.server.sessions["sid"] = s
            res = await self.server.dispatch(
                "resume_session", {"session_id": "sid"}, None)
            self.assertTrue(res["ok"])
            self.assertEqual(s.stopped_with, ["sleeping"])  # torn down first
            self.assertEqual(s.started, 1)                  # then restarted
            return s

        s = asyncio.run(go())
        self.assertEqual(s.started, 1)

    def test_resume_of_a_finished_run_does_not_stop_anything(self):
        async def go():
            s = _FakeSession()
            done = asyncio.create_task(asyncio.sleep(0))
            await done
            s._main_task = done
            self.server.sessions["sid"] = s
            await self.server.dispatch("resume_session", {"session_id": "sid"}, None)
            return s

        s = asyncio.run(go())
        self.assertEqual(s.stopped_with, [])   # nothing was alive to stop
        self.assertEqual(s.started, 1)

    def test_resume_of_a_running_session_stays_a_noop(self):
        async def go():
            s = _FakeSession()
            s.status = "thinking"
            s._main_task = asyncio.create_task(asyncio.sleep(30))
            self.server.sessions["sid"] = s
            res = await self.server.dispatch(
                "resume_session", {"session_id": "sid"}, None)
            s._main_task.cancel()
            return res, s

        res, s = asyncio.run(go())
        self.assertTrue(res.get("noop"))
        self.assertEqual(s.stopped_with, [])
        self.assertEqual(s.started, 0)


if __name__ == "__main__":
    unittest.main()
