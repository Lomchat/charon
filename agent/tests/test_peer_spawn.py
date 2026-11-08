"""Sub-sessions: peer_spawn / peer_spawn_resolve / peer_interrupt + parent persistence."""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path

if sys.version_info < (3, 10):
    raise unittest.SkipTest("charon_agent.server requires Python >= 3.10")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.server import Server, RpcError, MAX_SUBSESSION_DEPTH, MAX_LIVE_SUBSESSIONS  # noqa: E402


class _Fake:
    def __init__(self, sid, handle, parent=None, status="active"):
        self.session_id = sid
        self.handle = handle
        self.kind = "claude"
        self.status = status
        self.parent_session_id = parent
        self.parent_handle = None
        self.inputs = []
        self.interrupted = 0

    async def send_input(self, content, **kw):
        self.inputs.append((content, kw))

    async def interrupt(self):
        self.interrupted += 1

    def to_persist(self):
        return {"session_id": self.session_id, "parent_session_id": self.parent_session_id}


class _Client:
    pass


class PeerSpawnTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.server = Server(socket_path=base / "agent.sock", state_path=base / "state.json")
        self.events = []
        self.server._emit = lambda ev, *a, **k: self.events.append(ev)
        self.server.sessions["p"] = _Fake("p", "parent")
        self.server.subscribers["p"] = {_Client()}

    def tearDown(self):
        self._tmp.cleanup()

    def _spawn(self, **extra):
        return self.server.dispatch(
            "peer_spawn", {"source_session_id": "p", "task": "do it", **extra}, None)

    def test_spawn_delivers_through_peer_ledger(self):
        async def run():
            task = asyncio.create_task(self._spawn())
            while not self.events:
                await asyncio.sleep(0.01)
            ev = self.events[0]
            self.assertEqual(ev["event"], "peer_spawn_request")
            self.server.sessions["c"] = _Fake("c", "kid", parent="p")
            res = await self.server.dispatch("peer_spawn_resolve", {
                "request_id": ev["request_id"], "ok": True, "session_id": "c",
                "handle": "kid", "provider": "claude", "mode": "normal"}, None)
            self.assertEqual(res, {"ok": True, "known": True})
            return await task

        out = asyncio.run(run())
        self.assertEqual(out["status"], "delivered")
        self.assertEqual(out["handle"], "kid")
        child = self.server.sessions["c"]
        self.assertEqual(len(child.inputs), 1)
        self.assertIn('from="@parent"', child.inputs[0][0])
        self.assertIsNotNone(child.inputs[0][1].get("peer_request_id"))

    def test_unknown_resolve_is_not_an_error(self):
        res = asyncio.run(self.server.dispatch("peer_spawn_resolve", {"request_id": "x", "ok": False}, None))
        self.assertEqual(res, {"ok": True, "known": False})

    def test_no_hub_subscribed_fails_fast(self):
        self.server.subscribers["p"] = set()
        with self.assertRaises(RpcError) as cm:
            asyncio.run(self._spawn())
        self.assertIn("hub is not connected", str(cm.exception))

    def test_hub_refusal_propagates(self):
        async def run():
            task = asyncio.create_task(self._spawn())
            while not self.events:
                await asyncio.sleep(0.01)
            await self.server.dispatch("peer_spawn_resolve", {
                "request_id": self.events[0]["request_id"], "ok": False, "error": "nope"}, None)
            return await task
        with self.assertRaises(RpcError) as cm:
            asyncio.run(run())
        self.assertIn("nope", str(cm.exception))

    def test_depth_limit(self):
        parent = None
        for i in range(MAX_SUBSESSION_DEPTH):
            sid = f"a{i}"
            self.server.sessions[sid] = _Fake(sid, f"h{i}", parent=parent)
            parent = sid
        self.server.sessions[parent].parent_session_id = f"a{MAX_SUBSESSION_DEPTH - 2}"
        self.server.subscribers[parent] = {_Client()}
        # Chain p <- ... : build a chain of exactly MAX depth ancestors for the source.
        src = _Fake("deep", "deep", parent=parent)
        self.server.sessions["deep"] = src
        self.server.subscribers["deep"] = {_Client()}
        with self.assertRaises(RpcError) as cm:
            asyncio.run(self.server.dispatch(
                "peer_spawn", {"source_session_id": "deep", "task": "t"}, None))
        self.assertIn("depth", str(cm.exception))

    def test_children_limit(self):
        for i in range(MAX_LIVE_SUBSESSIONS):
            self.server.sessions[f"k{i}"] = _Fake(f"k{i}", f"kid{i}", parent="p")
        with self.assertRaises(RpcError) as cm:
            asyncio.run(self._spawn())
        self.assertIn("too many", str(cm.exception))

    def test_interrupt_only_own_children(self):
        self.server.sessions["c"] = _Fake("c", "kid", parent="p")
        self.server.sessions["o"] = _Fake("o", "other")
        res = asyncio.run(self.server.dispatch(
            "peer_interrupt", {"source_session_id": "p", "handle": "@kid"}, None))
        self.assertEqual(res, {"ok": True, "handle": "kid"})
        self.assertEqual(self.server.sessions["c"].interrupted, 1)
        with self.assertRaises(RpcError):
            asyncio.run(self.server.dispatch(
                "peer_interrupt", {"source_session_id": "p", "handle": "other"}, None))
        self.assertEqual(self.server.sessions["o"].interrupted, 0)

    def test_peer_list_marks_children(self):
        self.server.sessions["c"] = _Fake("c", "kid", parent="p")
        self.server.sessions["c"].parent_handle = "parent"
        rows = asyncio.run(self.server.dispatch("peer_list", {"source_session_id": "p"}, None))["sessions"]
        self.assertTrue(rows[0]["is_child"])
        self.assertEqual(rows[0]["parent_handle"], "parent")


class ParentPersistenceTestCase(unittest.TestCase):
    def test_parent_fields_survive_state_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = Server(socket_path=Path(tmp) / "a.sock", state_path=Path(tmp) / "s.json")
            row = {"session_id": "c1", "kind": "claude", "cwd": "/tmp", "handle": "kid",
                   "permission_mode": "default", "parent_session_id": "pp",
                   "parent_handle": "dad", "status": "sleeping"}
            server._register_sleeping(row)
            s = server.sessions["c1"]
            self.assertEqual((s.parent_session_id, s.parent_handle), ("pp", "dad"))
            for d in (s.to_info(), s.to_persist()):
                self.assertEqual(d["parent_session_id"], "pp")
                self.assertEqual(d["parent_handle"], "dad")


if __name__ == "__main__":
    unittest.main()
