"""Back-pressured subscribe replay (agent >= 0.103.0).

Before: `subscribe` queued the whole `read_since()` result synchronously into
the client's send queue, so a replay above SEND_QUEUE_MAX_EVENTS (10 000) or
SEND_QUEUE_MAX_BYTES (32 MiB) dropped the client before a line was written —
and the hub's unchanged cursor repeated the drop on every reconnect.

These tests drive the REAL Server/Client over a real Unix socket (no SDK, a
fake session object) and pin the contract:
  - a replay past both old caps is delivered whole, in seq order, with no
    overflow disconnect;
  - the wire order stays replay_begin, items, replay_end, status, ANSWER, then
    live — live events emitted while the replay drains are held and follow the
    answer, in order, exactly once;
  - other clients are served meanwhile (per-client awaiting only);
  - a stuck client still trips the overflow guard on LIVE traffic, and an
    overflowing hold falls back to the same disconnect;
  - two subscribes of one session on one connection never interleave, and one
    waiting for the lock of a closed client never re-adds it;
  - replays (and hold releases) of DIFFERENT sessions on one connection share
    the room fairly instead of queueing behind one whole burst;
  - a half-closing one-shot client still gets the whole burst and the whole
    hold (§14.75).
"""
import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

if sys.version_info < (3, 10):
    raise unittest.SkipTest("charon_agent.server requires Python >= 3.10")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import event_log as event_log_mod  # noqa: E402
from charon_agent import server as server_mod  # noqa: E402
from charon_agent.server import RPC_READER_LIMIT, Server  # noqa: E402

SID = "a" * 32
OTHER = "b" * 32
# ~1.5 KB per line: 25 000 lines ≈ 37 MB, past BOTH old caps.
PAD = "x" * 1400


class _Recording(server_mod.Client):
    """The server-side Client of each connection, in accept order."""

    instances: list = []

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        type(self).instances.append(self)


class _Peer:
    """A raw JSON-lines client over the agent socket."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self._nid = 0

    async def request(self, method: str, params: dict) -> int:
        self._nid += 1
        self.writer.write((json.dumps(
            {"id": self._nid, "method": method, "params": params}) + "\n").encode())
        await self.writer.drain()
        return self._nid

    async def frame(self, timeout: float = 30.0):
        line = await asyncio.wait_for(self.reader.readline(), timeout)
        if not line:
            return None  # EOF
        return json.loads(line)

    async def frames(self, n: int, timeout: float = 60.0) -> list:
        out = []
        for _ in range(n):
            f = await self.frame(timeout)
            if f is None:
                break
            out.append(f)
        return out

    async def until_answer(self, req_id: int, timeout: float = 60.0) -> list:
        """Every frame up to and including the answer to `req_id`."""
        out = []
        while True:
            f = await self.frame(timeout)
            if f is None:
                raise AssertionError(f"EOF before the answer to {req_id} ({len(out)} frames)")
            out.append(f)
            if f.get("id") == req_id:
                return out

    async def silent(self, timeout: float = 0.2) -> bool:
        try:
            await asyncio.wait_for(self.reader.readline(), timeout)
        except asyncio.TimeoutError:
            return True
        return False

    def close(self) -> None:
        try:
            self.writer.close()
        except Exception:
            pass


def _write_log(server: Server, sid: str, n: int, pad: str = PAD) -> int:
    """A durable log of `n` events (seq 1..n); returns its size in bytes."""
    server.events_dir.mkdir(parents=True, exist_ok=True)
    path = server.events_dir / f"{sid}.jsonl"
    with path.open("w", encoding="utf-8") as f:
        for i in range(1, n + 1):
            f.write(json.dumps({"seq": i, "ts": 1000.0 + i, "event": "assistant_text",
                                "session_id": sid, "delta": pad},
                               separators=(",", ":")) + "\n")
    return path.stat().st_size


def _live(server: Server, sid: str, tag: str) -> None:
    server._emit({"event": "assistant_text", "session_id": sid, "delta": tag})


class SubscribeBackpressureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # IsolatedAsyncioTestCase runs a DEBUG loop: slow-callback warnings
        # for every big synchronous read_since, and several times slower.
        asyncio.get_running_loop().set_debug(False)
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.server = Server(socket_path=base / "agent.sock", state_path=base / "state.json")
        self.server.sessions[SID] = types.SimpleNamespace(status="active")
        self.server.sessions[OTHER] = types.SimpleNamespace(status="active")
        _Recording.instances = []
        self._patch = patch.object(server_mod, "Client", _Recording)
        self._patch.start()
        self.srv = await asyncio.start_unix_server(
            self.server._handle_client, path=str(self.server.socket_path),
            limit=RPC_READER_LIMIT)
        self.peers: list[_Peer] = []

    async def asyncTearDown(self):
        for p in self.peers:
            p.close()
        self.srv.close()
        try:
            await asyncio.wait_for(self.srv.wait_closed(), 5)
        except asyncio.TimeoutError:
            pass
        # Let every connection's cleanup run before the loop goes away.
        for _ in range(20):
            await asyncio.sleep(0.01)
        self._patch.stop()
        self._tmp.cleanup()

    async def connect(self) -> tuple[_Peer, server_mod.Client]:
        before = len(_Recording.instances)
        # Default reader limit: the peer's StreamReader stops reading the
        # socket past 2 × limit, so a peer that does not read really stalls.
        reader, writer = await asyncio.open_unix_connection(str(self.server.socket_path))
        peer = _Peer(reader, writer)
        self.peers.append(peer)
        for _ in range(500):
            if len(_Recording.instances) > before:
                return peer, _Recording.instances[before]
            await asyncio.sleep(0.01)
        self.fail("the server never accepted the connection")

    async def parked(self, client: server_mod.Client, sid: str = SID) -> None:
        """Wait until `client`'s replay of `sid` is parked on back-pressure:
        hold open, queue above the low marks and no longer moving (its peer
        is not reading)."""
        last, stable = None, 0
        for _ in range(1000):
            await asyncio.sleep(0.01)
            q = client._send_q.qsize()
            if sid in client._holds and not client._below_low_water() and q == last:
                stable += 1
                if stable >= 5:
                    return
            else:
                stable = 0
            last = q
        self.fail("the replay never parked on back-pressure")

    def assert_replay(self, frames: list, sid: str, first: int, last: int) -> None:
        n = last - first + 1
        self.assertEqual(frames[0], {"event": "replay_begin", "session_id": sid, "count": n})
        seqs = [f.get("seq") for f in frames[1:n + 1]]
        self.assertEqual(seqs, list(range(first, last + 1)))
        self.assertTrue(all(f["event"] == "assistant_text" and f["session_id"] == sid
                            for f in frames[1:n + 1]))
        self.assertEqual(frames[n + 1], {"event": "replay_end", "session_id": sid})
        self.assertEqual(frames[n + 2], {"event": "status", "session_id": sid, "status": "active", "compacting": False})

    # ── the bug: a burst past both caps ──────────────────────────────────────
    async def test_a_replay_past_both_caps_is_delivered_whole_then_the_held_live_events(self):
        size = _write_log(self.server, SID, 25_000)
        # The fixture really is past BOTH caps that used to drop the client.
        self.assertGreater(25_000, server_mod.SEND_QUEUE_MAX_EVENTS)
        self.assertGreater(size, server_mod.SEND_QUEUE_MAX_BYTES)

        a, a_srv = await self.connect()
        rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        await self.parked(a_srv)
        self.assertFalse(a_srv.closed)
        # The queue never got near the overflow guard.
        self.assertLessEqual(a_srv._send_q.qsize(), server_mod.REPLAY_HIGH_WATER_EVENTS)

        # Live events while the replay drains: held for this client.
        for i in range(100):
            _live(self.server, SID, f"live-{i}")
        self.assertEqual(len(a_srv._holds[SID]), 100)

        frames = await a.until_answer(rid)
        self.assertEqual(len(frames), 25_000 + 4)
        self.assert_replay(frames, SID, 1, 25_000)
        self.assertEqual(frames[-1]["result"], {
            "ok": True, "replay_count": 25_000, "status": "active",
            "current_seq": 25_000, "earliest_seq": 1, "gap": False, "internal_gaps": []})

        held = await a.frames(100)
        self.assertEqual([f["seq"] for f in held], list(range(25_001, 25_101)))
        self.assertEqual([f["delta"] for f in held], [f"live-{i}" for i in range(100)])
        # After the hold: live events go straight through, behind it.
        for i in range(100, 105):
            _live(self.server, SID, f"live-{i}")
        direct = await a.frames(5)
        self.assertEqual([f["seq"] for f in direct], list(range(25_101, 25_106)))
        self.assertTrue(await a.silent(), "a live event was delivered twice")
        self.assertFalse(a_srv.closed)
        self.assertNotIn(SID, a_srv._holds)
        self.assertEqual((a_srv._hold_events, a_srv._hold_bytes), (0, 0))
        self.assertFalse(a_srv._replay_locks[SID].locked())

    async def test_live_events_racing_a_reading_client_arrive_once_in_order_after_the_answer(self):
        _write_log(self.server, SID, 12_000, pad="y" * 200)
        a, a_srv = await self.connect()
        rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        for _ in range(500):  # the subscribe has read the log
            if a_srv in self.server.subscribers.get(SID, ()):
                break
            await asyncio.sleep(0.001)
        held_at_emit = []

        async def emitter():
            for i in range(300):
                _live(self.server, SID, f"race-{i}")
                held_at_emit.append(SID in a_srv._holds)
                await asyncio.sleep(0)

        task = asyncio.create_task(emitter())
        frames = await a.until_answer(rid)
        await task
        self.assert_replay(frames, SID, 1, 12_000)
        answer = frames[-1]["result"]
        self.assertEqual(answer["replay_count"], 12_000)
        self.assertEqual(answer["current_seq"], 12_000)
        # The race really happened: some live events were emitted while the
        # replay was draining (held), whatever the rest did.
        self.assertTrue(any(held_at_emit))
        rest = await a.frames(300)
        self.assertTrue(await a.silent())
        self.assertEqual([f["seq"] for f in rest], list(range(12_001, 12_301)))
        self.assertEqual([f["delta"] for f in rest], [f"race-{i}" for i in range(300)])
        self.assertFalse(a_srv.closed)

    # ── per-client awaiting only ─────────────────────────────────────────────
    async def test_a_second_client_is_served_while_the_first_replay_is_parked(self):
        _write_log(self.server, SID, 5_000)
        a, a_srv = await self.connect()
        a_rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        await self.parked(a_srv)

        b, b_srv = await self.connect()
        b_rid = await b.request("subscribe", {"session_id": SID, "after_seq": 0})
        b_frames = await b.until_answer(b_rid, timeout=10)
        self.assert_replay(b_frames, SID, 1, 5_000)

        for i in range(10):
            _live(self.server, SID, f"live-{i}")
        b_live = await b.frames(10, timeout=10)
        self.assertEqual([f["seq"] for f in b_live], list(range(5_001, 5_011)))
        # A is still parked, its live events held, nothing dropped.
        self.assertFalse(a_srv.closed)
        self.assertEqual(len(a_srv._holds[SID]), 10)
        self.assertNotIn(SID, b_srv._holds)

        a_frames = await a.until_answer(a_rid)
        self.assert_replay(a_frames, SID, 1, 5_000)
        a_live = await a.frames(10)
        self.assertEqual([f["seq"] for f in a_live], list(range(5_001, 5_011)))
        self.assertTrue(await a.silent())

    # ── the overflow guard still protects against a stuck client ─────────────
    async def test_a_stuck_client_still_hits_the_overflow_guard_on_live_traffic(self):
        _write_log(self.server, SID, 10, pad="z")
        c, c_srv = await self.connect()
        rid = await c.request("subscribe", {"session_id": SID, "after_seq": 10})
        frames = await c.until_answer(rid)
        self.assertEqual(frames[0], {"event": "status", "session_id": SID, "status": "active", "compacting": False})
        self.assertEqual(frames[-1]["result"]["replay_count"], 0)
        # A reading client on the same session is not affected.
        d, d_srv = await self.connect()
        d_rid = await d.request("subscribe", {"session_id": SID, "after_seq": 10})
        await d.until_answer(d_rid)

        # C stops reading. Live traffic piles up in its queue until the guard.
        emitted = 0
        while not c_srv.closed and emitted < 40_000:
            _live(self.server, SID, "s" * 64)
            emitted += 1
            if emitted % 500 == 0:
                await asyncio.sleep(0)  # let both writers run
                got = await d.frames(500, timeout=10)  # D keeps up
                self.assertEqual(len(got), 500)
        self.assertTrue(c_srv.closed, "a stuck client was never disconnected")
        self.assertGreater(emitted, server_mod.SEND_QUEUE_MAX_EVENTS)
        self.assertFalse(d_srv.closed)
        # C reads what was written before the drop, then EOF.
        got = 0
        while (await c.frame(10)) is not None:
            got += 1
        self.assertLess(got, emitted)

    async def test_an_overflowing_hold_falls_back_to_the_disconnect(self):
        _write_log(self.server, SID, 5_000)
        a, a_srv = await self.connect()
        rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        await self.parked(a_srv)
        with patch.object(server_mod, "REPLAY_HOLD_MAX_EVENTS", 50):
            for i in range(51):
                _live(self.server, SID, f"live-{i}")
        self.assertTrue(a_srv.closed)
        # The peer reads what was already written, then EOF: no replay_end,
        # no answer (the hub resumes from its durable cursor).
        frames = []
        while True:
            f = await a.frame(10)
            if f is None:
                break
            frames.append(f)
        self.assertNotIn(rid, [f.get("id") for f in frames])
        self.assertNotIn("replay_end", [f.get("event") for f in frames])
        # The connection is cleaned up: no subscriber, no task left behind.
        for _ in range(200):
            if a_srv not in self.server.subscribers.get(SID, set()) and not a_srv._inflight:
                break
            await asyncio.sleep(0.01)
        self.assertNotIn(a_srv, self.server.subscribers.get(SID, set()))
        self.assertFalse(a_srv._inflight)
        self.assertNotIn(SID, a_srv._holds)
        self.assertEqual((a_srv._hold_events, a_srv._hold_bytes), (0, 0))

    async def test_a_parked_replay_whose_peer_never_reads_is_woken_by_the_cleanup(self):
        _write_log(self.server, SID, 5_000)
        a, a_srv = await self.connect()
        await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        await self.parked(a_srv)
        _live(self.server, SID, "held")
        # EOF from the peer, which still never reads: after the (shortened)
        # §14.75 grace the cleanup closes the client; the parked replay must
        # wake up and leave nothing behind (no task holding the burst).
        with patch.object(server_mod, "EOF_FLUSH_GRACE_S", 0.2):
            a.writer.write_eof()
            for _ in range(300):
                if a_srv.closed and not a_srv._inflight:
                    break
                await asyncio.sleep(0.01)
        self.assertTrue(a_srv.closed)
        self.assertFalse(a_srv._inflight, "a parked replay outlived its connection")
        self.assertNotIn(SID, a_srv._holds)
        self.assertEqual((a_srv._hold_events, a_srv._hold_bytes), (0, 0))
        self.assertFalse(a_srv._replay_locks[SID].locked())
        self.assertNotIn(a_srv, self.server.subscribers.get(SID, set()))

    async def test_a_large_hold_is_released_back_pressured(self):
        # A hold bigger than the queue cap: queued at once it would trip the
        # overflow guard; released through the same marks it never does.
        _write_log(self.server, SID, 5_000)
        with patch.object(server_mod, "SEND_QUEUE_MAX_EVENTS", 3_000):
            a, a_srv = await self.connect()
            rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
            await self.parked(a_srv)
            for i in range(6_000):
                _live(self.server, SID, f"h{i}")
            self.assertEqual(len(a_srv._holds[SID]), 6_000)
            frames = await a.until_answer(rid)
            self.assert_replay(frames, SID, 1, 5_000)
            held = await a.frames(6_000)
            self.assertEqual([f["seq"] for f in held], list(range(5_001, 11_001)))
            self.assertTrue(await a.silent())
            self.assertFalse(a_srv.closed)

    async def test_held_events_follow_the_answer_even_when_the_answer_path_suspends(self):
        # The release is tied to the answer, not to task scheduling: an await
        # between the handler's return and the answer must not let the held
        # live events overtake it.
        _write_log(self.server, SID, 3, pad="s")
        a, a_srv = await self.connect()

        async def slow_answer(obj):
            await asyncio.sleep(0.2)
            a_srv.send_json(obj)

        a_srv._send_locked = slow_answer
        rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        head = await a.frames(3 + 3)
        self.assertEqual(head[-1]["event"], "status")
        _live(self.server, SID, "l1")
        _live(self.server, SID, "l2")
        rest = await a.frames(3)
        self.assertEqual(rest[0].get("id"), rid, "a held live event overtook the answer")
        self.assertEqual([f["seq"] for f in rest[1:]], [4, 5])

    # ── ordering on one connection ───────────────────────────────────────────
    async def test_two_subscribes_of_one_session_on_one_connection_never_interleave(self):
        _write_log(self.server, SID, 5_000)
        a, a_srv = await self.connect()
        r1 = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        await self.parked(a_srv)
        # The second one (empty from its own cursor) waits for the first:
        # an empty answer inside the first burst would make the hub close
        # that window early (§14.31).
        r2 = await a.request("subscribe", {"session_id": SID, "after_seq": 5_000})
        for i in range(3):
            _live(self.server, SID, f"live-{i}")
        first = await a.until_answer(r1)
        self.assert_replay(first, SID, 1, 5_000)
        self.assertEqual(first[-1]["result"]["current_seq"], 5_000)
        second = await a.until_answer(r2)
        # The first one's held live events, then the second subscribe — which
        # replays them again from its own cursor (the hub dedups by identity,
        # exactly as two back-to-back synchronous subscribes did).
        self.assertEqual([f["seq"] for f in second[:3]], [5_001, 5_002, 5_003])
        self.assert_replay(second[3:], SID, 5_001, 5_003)
        self.assertEqual(second[-1]["id"], r2)
        self.assertEqual(second[-1]["result"]["current_seq"], 5_003)
        self.assertEqual(len(second), 3 + 3 + 4)
        _live(self.server, SID, "after")
        self.assertEqual((await a.frame())["seq"], 5_004)
        self.assertTrue(await a.silent())

    async def test_other_sessions_on_the_same_connection_keep_their_order_while_one_replay_is_parked(self):
        _write_log(self.server, SID, 5_000)
        _write_log(self.server, OTHER, 2, pad="o")
        a, a_srv = await self.connect()
        r1 = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        await self.parked(a_srv)
        r2 = await a.request("subscribe", {"session_id": OTHER, "after_seq": 0})
        for _ in range(100):  # OTHER's subscribe has at least read its log
            if a_srv in self.server.subscribers.get(OTHER, ()):
                break
            await asyncio.sleep(0.01)
        self.assertIn(a_srv, self.server.subscribers.get(OTHER, ()))
        _live(self.server, OTHER, "other-live")
        # Answers may land in either order: read until both, plus the live one.
        frames, seen = [], set()
        while not ({r1, r2} <= seen and any(f.get("delta") == "other-live" for f in frames)):
            f = await a.frame()
            self.assertIsNotNone(f, "EOF")
            frames.append(f)
            if "id" in f:
                seen.add(f["id"])
        self.assertTrue(await a.silent())
        # SID's burst is whole and in order; OTHER's frames keep their own
        # order (begin, 2 items, end, status, answer, live) wherever they land.
        sid_frames = [f for f in frames if f.get("session_id") == SID or f.get("id") == r1]
        self.assert_replay(sid_frames, SID, 1, 5_000)
        other = [f for f in frames if f.get("session_id") == OTHER or f.get("id") == r2]
        self.assertEqual([f.get("event") or f.get("id") for f in other],
                         ["replay_begin", "assistant_text", "assistant_text", "replay_end",
                          "status", r2, "assistant_text"])
        self.assertEqual(other[-1]["delta"], "other-live")

    async def test_replays_of_other_sessions_share_the_room_with_a_parked_one(self):
        # Back-pressured writers of ONE connection share the room round by
        # round: two moderate bursts (and their hold releases) interleave with
        # SID's large one — and with each other — instead of each waiting for
        # a whole burst. Else their answers (gap/internal_gaps) can miss the
        # hub's 60 s timer and their held live events stay frozen meanwhile.
        # THREE writers on purpose: with two, merely letting the writer that
        # got nothing go first next round already alternates; with three, one
        # of them starves unless every round is SHARED.
        third = "d" * 32
        self.server.sessions[third] = types.SimpleNamespace(status="active")
        _write_log(self.server, SID, 20_000)
        _write_log(self.server, OTHER, 3_000, pad="o" * 200)
        _write_log(self.server, third, 3_000, pad="t" * 200)
        a, a_srv = await self.connect()
        r1 = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        await self.parked(a_srv)
        rids = {OTHER: await a.request("subscribe", {"session_id": OTHER, "after_seq": 0}),
                third: await a.request("subscribe", {"session_id": third, "after_seq": 0})}
        for _ in range(200):  # both read their logs and parked behind SID
            if OTHER in a_srv._holds and third in a_srv._holds and len(a_srv._room_waiters) == 3:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(len(a_srv._room_waiters), 3)
        for i in range(20):
            for sid in (SID, OTHER, third):
                _live(self.server, sid, f"live-{sid[0]}-{i}")

        frames, live = [], 0
        while live < 60:
            f = await a.frame()
            self.assertIsNotNone(f, "EOF")
            frames.append(f)
            live += str(f.get("delta", "")).startswith("live-")
        self.assertTrue(await a.silent())
        self.assertFalse(a_srv.closed)

        # Each session keeps its own order: burst, answer, then its held events.
        mine = [f for f in frames if f.get("session_id") == SID or f.get("id") == r1]
        self.assert_replay(mine, SID, 1, 20_000)
        self.assertEqual(mine[20_003]["id"], r1)
        self.assertEqual([f["seq"] for f in mine[20_004:]], list(range(20_001, 20_021)))
        sid_end = next(i for i, f in enumerate(frames)
                       if f.get("event") == "replay_end" and f["session_id"] == SID)
        for sid, rid in rids.items():
            theirs = [f for f in frames if f.get("session_id") == sid or f.get("id") == rid]
            self.assertEqual(len(theirs), 3_000 + 4 + 20)
            self.assert_replay(theirs, sid, 1, 3_000)
            self.assertEqual(theirs[3_003]["id"], rid)
            self.assertEqual([f["seq"] for f in theirs[3_004:]], list(range(3_001, 3_021)))
            # Fair: its burst, answer AND held events all land inside SID's
            # burst, SID having taken about as much room as it meanwhile (plus
            # the fill SID already had when it arrived).
            last = next(i for i, f in enumerate(frames) if f.get("delta") == f"live-{sid[0]}-19")
            self.assertLess(last, sid_end, f"{sid[0]} waited for SID's whole burst")
            sid_before = sum(1 for f in frames[:last] if f.get("session_id") == SID)
            self.assertLess(sid_before, server_mod.REPLAY_HIGH_WATER_EVENTS + 1.5 * len(theirs),
                            f"{sid[0]} got less than an equal share of the room")
        # Nothing left behind.
        self.assertEqual(a_srv._holds, {})
        self.assertEqual((a_srv._hold_events, a_srv._hold_bytes), (0, 0))
        self.assertFalse(a_srv._room_waiters)
        self.assertEqual(a_srv._room_granted, 0)

    async def test_a_subscribe_waiting_for_the_lock_of_a_closed_client_is_not_re_added(self):
        # Second subscribe of SID waits on the first one's lock; the
        # connection's cleanup runs meanwhile. Once the lock frees, the waiting
        # subscribe must NOT put the dead client back into `subscribers`
        # (every later _emit of SID would iterate it for the daemon's life).
        _write_log(self.server, SID, 5_000)
        a, a_srv = await self.connect()
        await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        await self.parked(a_srv)
        await a.request("subscribe", {"session_id": SID, "after_seq": 5_000})
        for _ in range(100):
            if len(a_srv._inflight) == 2:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(len(a_srv._inflight), 2)
        self.assertTrue(a_srv._replay_locks[SID].locked())
        with patch.object(server_mod, "EOF_FLUSH_GRACE_S", 0.2):
            a.writer.write_eof()  # the peer still never reads
            for _ in range(300):
                if a_srv.closed and not a_srv._inflight:
                    break
                await asyncio.sleep(0.01)
        for _ in range(10):  # anything the last task scheduled has run
            await asyncio.sleep(0)
        self.assertTrue(a_srv.closed)
        self.assertFalse(a_srv._inflight)
        self.assertNotIn(a_srv, self.server.subscribers.get(SID, set()))
        self.assertNotIn(SID, a_srv.subscribed)
        self.assertEqual(a_srv._holds, {})
        self.assertEqual((a_srv._hold_events, a_srv._hold_bytes), (0, 0))
        self.assertFalse(a_srv._replay_locks[SID].locked())
        self.assertFalse(a_srv._room_waiters)
        self.assertEqual(a_srv._room_granted, 0)

    # ── the small/legacy paths keep the synchronous shape ───────────────────
    async def test_small_and_empty_replays_keep_the_wire_shape(self):
        _write_log(self.server, SID, 3, pad="s")
        a, a_srv = await self.connect()
        rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        frames = await a.until_answer(rid)
        self.assertEqual(len(frames), 3 + 4)
        self.assert_replay(frames, SID, 1, 3)
        _live(self.server, SID, "live")
        self.assertEqual((await a.frame())["seq"], 4)

        # Empty: no markers, status then the answer.
        rid = await a.request("subscribe", {"session_id": SID, "after_seq": 4})
        frames = await a.until_answer(rid)
        self.assertEqual(frames[0], {"event": "status", "session_id": SID, "status": "active", "compacting": False})
        self.assertEqual(frames[1]["result"]["replay_count"], 0)
        self.assertEqual(len(frames), 2)

        # Ring tail (hubs < 0.4.0): the in-memory ring holds seq 4 only.
        rid = await a.request("subscribe", {"session_id": SID, "replay": 300})
        frames = await a.until_answer(rid)
        self.assertEqual(frames[0]["count"], 1)
        self.assertEqual(frames[1]["seq"], 4)
        self.assertEqual(frames[-1]["result"]["replay_count"], 1)
        self.assertTrue(await a.silent())
        self.assertFalse(a_srv.closed)
        self.assertEqual(a_srv._holds, {})

    async def test_an_unknown_session_errors_and_leaves_nothing_held(self):
        a, a_srv = await self.connect()
        missing = "c" * 32
        rid = await a.request("subscribe", {"session_id": missing, "after_seq": 0})
        frames = await a.until_answer(rid)
        self.assertEqual(frames[-1]["error"]["code"], server_mod.ERR_SESSION_NOT_FOUND)
        for _ in range(50):
            if not a_srv._inflight:
                break
            await asyncio.sleep(0.01)
        self.assertNotIn(missing, a_srv._holds)
        self.assertFalse(a_srv._replay_locks[missing].locked())
        # Once it exists, the same connection subscribes it normally.
        self.server.sessions[missing] = types.SimpleNamespace(status="sleeping")
        rid = await a.request("subscribe", {"session_id": missing, "after_seq": 0})
        frames = await a.until_answer(rid)
        self.assertEqual(frames[0]["status"], "sleeping")
        self.assertTrue(frames[-1]["result"]["ok"])

    # ── §14.75: half-close ────────────────────────────────────────────────────
    async def test_a_half_closing_client_still_gets_a_burst_past_the_event_cap(self):
        _write_log(self.server, SID, 12_000, pad="h" * 100)
        a, _ = await self.connect()
        rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
        a.writer.write_eof()
        frames = []
        while True:
            f = await a.frame(30)
            if f is None:
                break
            frames.append(f)
        self.assertEqual(len(frames), 12_000 + 4)
        self.assert_replay(frames, SID, 1, 12_000)
        self.assertEqual(frames[-1]["id"], rid)
        self.assertEqual(frames[-1]["result"]["replay_count"], 12_000)

    async def test_a_half_closing_client_still_gets_a_hold_past_the_high_water_mark(self):
        # The hold release starts AFTER the EOF flush took its snapshot of the
        # in-flight requests, and parks on back-pressure: the flush must wait
        # for it too, else the queue can run empty (join() resolves) while the
        # release is parked, and the cleanup drops the rest of the hold.
        _write_log(self.server, SID, 2_000)
        with patch.multiple(server_mod, REPLAY_HIGH_WATER_EVENTS=20, REPLAY_LOW_WATER_EVENTS=5):
            a, a_srv = await self.connect()
            rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
            await self.parked(a_srv)
            for i in range(300):  # held: 15 × the (patched) high-water mark
                _live(self.server, SID, f"held-{i}")
            self.assertEqual(len(a_srv._holds[SID]), 300)
            a.writer.write_eof()
            frames = []
            while True:
                f = await a.frame(30)
                if f is None:
                    break
                frames.append(f)
        self.assertEqual(len(frames), 2_000 + 4 + 300)
        self.assert_replay(frames, SID, 1, 2_000)
        self.assertEqual(frames[2_003]["id"], rid)
        self.assertEqual([f["seq"] for f in frames[2_004:]], list(range(2_001, 2_301)))
        self.assertEqual([f["delta"] for f in frames[2_004:]], [f"held-{i}" for i in range(300)])


    # ── final step review, finding 2 (agent >= 0.103.1) ───────────────────
    # A parked replay used to keep its whole parsed backlog alive for the
    # drain (2.8-5.7x the log), one per parked subscribe, and a peer that
    # neither read nor closed, with no live traffic, was never dropped: the
    # overflow guard only ever sees a back-pressured queue.

    def _log_fds(self) -> int:
        """Open descriptors of this process on the session event logs."""
        n = 0
        for fd in os.listdir("/proc/self/fd"):
            try:
                if str(self.server.events_dir) in os.readlink(f"/proc/self/fd/{fd}"):
                    n += 1
            except OSError:
                pass
        return n

    async def test_parked_replays_do_not_hold_their_backlogs(self):
        import tracemalloc
        sids = [SID, OTHER, "c" * 32]
        self.server.sessions[sids[2]] = types.SimpleNamespace(status="active")
        total = sum(_write_log(self.server, sid, 10_000, pad="y" * 1000) for sid in sids)
        self.assertGreater(total, 30_000_000)
        tracemalloc.start()
        try:
            a, a_srv = await self.connect()
            for sid in sids:
                await a.request("subscribe", {"session_id": sid, "after_seq": 0})
            for sid in sids:
                await self.parked(a_srv, sid)
            self.assertEqual(len(a_srv._room_waiters) + a_srv._room_granted, 3)
            current, _peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        # The queue (≤ the HIGH marks) and three lazy scans; the parsed logs
        # were > 40 MB.
        self.assertLess(current, 16 * 1024 * 1024)
        self.assertFalse(a_srv.closed)
        # The peer reads now: every burst still arrives whole and in order.
        got: dict[str, list[int]] = {sid: [] for sid in sids}
        answers = 0
        while answers < 3:
            f = await a.frame(30)
            self.assertIsNotNone(f)
            if "id" in f:
                answers += 1
            elif f.get("event") == "assistant_text":
                got[f["session_id"]].append(f["seq"])
        for sid in sids:
            self.assertEqual(got[sid], list(range(1, 10_001)))
        if os.path.isdir("/proc/self/fd"):
            self.assertEqual(self._log_fds(), 0, "a finished replay kept its log open")

    async def test_a_stalled_peer_with_parked_replays_and_no_live_traffic_is_dropped(self):
        _write_log(self.server, SID, 5_000)
        _write_log(self.server, OTHER, 5_000)
        with patch.object(server_mod, "REPLAY_STALL_TIMEOUT_S", 0.3):
            a, a_srv = await self.connect()
            await a.request("subscribe", {"session_id": SID, "after_seq": 0})
            await a.request("subscribe", {"session_id": OTHER, "after_seq": 0})
            await self.parked(a_srv, SID)
            await self.parked(a_srv, OTHER)
            if os.path.isdir("/proc/self/fd"):
                self.assertGreater(self._log_fds(), 0)
            # No EOF, no read, no live event: only the stall guard can act.
            for _ in range(500):
                if a_srv.closed and not a_srv._inflight:
                    break
                await asyncio.sleep(0.01)
        self.assertTrue(a_srv.closed, "a stalled peer was never dropped")
        self.assertFalse(a_srv._inflight, "a parked replay outlived its connection")
        for sid in (SID, OTHER):
            self.assertNotIn(sid, a_srv._holds)
            self.assertFalse(a_srv._replay_locks[sid].locked())
        self.assertEqual((a_srv._hold_events, a_srv._hold_bytes), (0, 0))
        self.assertFalse(a_srv._room_waiters)
        if os.path.isdir("/proc/self/fd"):
            self.assertEqual(self._log_fds(), 0, "a dropped replay kept its log open")
        # The transport was aborted (not a close waiting on the unread buffer):
        # the server-side cleanup ran.
        for _ in range(300):
            if a_srv not in self.server.subscribers.get(SID, set()):
                break
            await asyncio.sleep(0.01)
        self.assertNotIn(a_srv, self.server.subscribers.get(SID, set()))
        self.assertNotIn(a_srv, self.server.subscribers.get(OTHER, set()))

    async def test_a_slow_peer_that_keeps_reading_is_never_dropped(self):
        _write_log(self.server, SID, 1_500)
        with patch.multiple(server_mod, REPLAY_HIGH_WATER_EVENTS=50, REPLAY_LOW_WATER_EVENTS=10,
                            REPLAY_STALL_TIMEOUT_S=0.6):
            a, a_srv = await self.connect()
            rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
            await self.parked(a_srv)
            frames = []
            while not frames or frames[-1].get("id") != rid:
                for _ in range(100):
                    f = await a.frame(10)
                    self.assertIsNotNone(f, "dropped while reading")
                    frames.append(f)
                    if f.get("id") == rid:
                        break
                await asyncio.sleep(0.1)                     # well under the stall timeout
        self.assertFalse(a_srv.closed)
        self.assert_replay(frames, SID, 1, 1_500)
        self.assertEqual(frames[-1]["result"]["replay_count"], 1_500)

    async def test_the_replay_is_the_log_as_it_was_at_the_subscribe(self):
        # Rotation and appends while the burst drains change nothing in it:
        # the files were opened (and measured) with the read.
        _write_log(self.server, SID, 3_000)
        with patch.object(event_log_mod, "MAX_FILE_BYTES", 4_000):
            a, a_srv = await self.connect()
            rid = await a.request("subscribe", {"session_id": SID, "after_seq": 0})
            await self.parked(a_srv)
            for i in range(20):                              # each append rotates the log
                _live(self.server, SID, "x" * 5_000)
            frames = await a.until_answer(rid)
        self.assert_replay(frames, SID, 1, 3_000)
        self.assertEqual(frames[-1]["result"]["current_seq"], 3_000)
        held = await a.frames(20)
        self.assertEqual([f["seq"] for f in held], list(range(3_001, 3_021)))

    async def test_an_unreadable_log_replays_nothing_and_reports_the_range_as_a_hole(self):
        _write_log(self.server, SID, 30)
        a, _ = await self.connect()
        with patch.object(event_log_mod.EventLog, "open_replay", side_effect=OSError("EIO")):
            rid = await a.request("subscribe", {"session_id": SID, "after_seq": 10})
            frames = await a.until_answer(rid)
        self.assertEqual(frames[0], {"event": "status", "session_id": SID, "status": "active", "compacting": False})
        self.assertEqual(frames[-1]["result"]["replay_count"], 0)
        self.assertEqual(frames[-1]["result"]["internal_gaps"], [[11, 30]])

    async def test_an_out_of_order_log_is_replayed_sorted_like_the_eager_read(self):
        self.server.events_dir.mkdir(parents=True, exist_ok=True)
        with (self.server.events_dir / f"{SID}.jsonl").open("w", encoding="utf-8") as f:
            for i in (1, 2, 3, 7, 8, 4, 5, 6, 9, 10):
                f.write(json.dumps({"seq": i, "ts": 1.0, "event": "assistant_text",
                                    "session_id": SID, "delta": "d"}) + "\n")
        a, _ = await self.connect()
        rid = await a.request("subscribe", {"session_id": SID, "after_seq": 2})
        frames = await a.until_answer(rid)
        self.assert_replay(frames, SID, 3, 10)
        self.assertEqual(frames[-1]["result"]["replay_count"], 8)
        self.assertEqual(frames[-1]["result"]["internal_gaps"], [])


class _FakeWriter:
    """Transport stand-in: records written lines; drain() waits on `gate`."""

    def __init__(self, open_: bool = True):
        self.lines: list[bytes] = []
        self.gate = asyncio.Event()
        if open_:
            self.gate.set()

    def write(self, data: bytes) -> None:
        self.lines.append(data)

    async def drain(self) -> None:
        await self.gate.wait()

    def close(self) -> None:
        pass

    def tags(self) -> list:
        return [json.loads(line)["w"] for line in self.lines]


class FairRoomHandOffTests(unittest.IsolatedAsyncioTestCase):
    """The room hand-off between one client's back-pressured writers, driven
    step by step against a fake transport (deterministic scheduling)."""

    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)

    def client(self, writer: _FakeWriter) -> server_mod.Client:
        c = server_mod.Client(None, None, writer)
        self.addAsyncCleanup(self._close, c)
        return c

    @staticmethod
    async def _close(c: server_mod.Client) -> None:
        c._set_closed()
        c._writer_task.cancel()
        try:
            await c._writer_task
        except asyncio.CancelledError:
            pass

    @staticmethod
    def frames(tag: str, n: int, size: int = 10) -> list:
        return [{"w": tag, "i": i, "pad": "x" * size} for i in range(n)]

    async def test_every_parked_writer_progresses_in_every_round(self):
        # A round's room is SHARED: each parked writer queues its share, so
        # none waits whole rounds for the others (a small hold release must
        # not wait n−1 full rounds behind bursts).
        w = _FakeWriter()
        c = self.client(w)
        high = 9
        with patch.multiple(server_mod, REPLAY_HIGH_WATER_EVENTS=high, REPLAY_LOW_WATER_EVENTS=0):
            tasks = [asyncio.create_task(c.send_replay_frames(self.frames(t, 15)))
                     for t in "abc"]
            self.assertEqual(await asyncio.wait_for(asyncio.gather(*tasks), 5), [True] * 3)
            for _ in range(50):
                if len(w.lines) == 45:
                    break
                await asyncio.sleep(0)
        order = w.tags()
        self.assertEqual(order[:high], ["a"] * high)  # a alone: the fast path
        first_done = min(max(i for i, x in enumerate(order) if x == t) for t in "abc")
        runs, run = [], 1
        for prev, cur in zip(order[high:first_done], order[high + 1:first_done + 1]):
            if cur == prev:
                run += 1
            else:
                runs.append(run)
                run = 1
        runs.append(run)
        self.assertLessEqual(max(runs), high // 3, "".join(order))
        self.assertEqual((c._room_granted, len(c._room_waiters)), (0, 0))

    async def test_writers_whose_single_lines_fill_the_room_take_turns(self):
        # Every line is bigger than the whole room: one writer is served per
        # round (a writer may always queue one line). Without the rotation the
        # same writer would run first — and alone — every round.
        w = _FakeWriter()
        c = self.client(w)
        with patch.multiple(server_mod, REPLAY_HIGH_WATER_BYTES=1_000, REPLAY_LOW_WATER_BYTES=500):
            tasks = [asyncio.create_task(c.send_replay_frames(self.frames(t, 8, size=1_200)))
                     for t in "abc"]
            self.assertEqual(await asyncio.wait_for(asyncio.gather(*tasks), 5), [True] * 3)
            for _ in range(50):
                if len(w.lines) == 24:
                    break
                await asyncio.sleep(0)
        order = w.tags()
        self.assertEqual(sorted(order), sorted("abc" * 8))
        for t in "abc":
            self.assertEqual([json.loads(l)["i"] for l in w.lines if json.loads(l)["w"] == t],
                             list(range(8)))
        # Taking turns: all three finish together, and until the first one
        # does, every three consecutive lines come from the three writers.
        last = {t: max(i for i, x in enumerate(order) if x == t) for t in "abc"}
        self.assertGreaterEqual(min(last.values()), len(order) - 3, "".join(order))
        for i in range(min(last.values()) - 1):
            self.assertEqual(set(order[i:i + 3]), set("abc"), "".join(order))
        self.assertEqual((c._room_granted, len(c._room_waiters)), (0, 0))

    async def test_a_writer_cancelled_after_its_grant_does_not_stall_the_parked_ones(self):
        w = _FakeWriter(open_=False)
        c = self.client(w)
        with patch.multiple(server_mod, REPLAY_HIGH_WATER_EVENTS=4, REPLAY_LOW_WATER_EVENTS=1):
            a = asyncio.create_task(c.send_replay_frames(self.frames("a", 10)))
            for _ in range(5):
                await asyncio.sleep(0)
            # A filled the queue up to HIGH and parked; the writer holds one
            # line, blocked in drain().
            self.assertEqual(len(c._room_waiters), 1)
            self.assertEqual(c._send_q.qsize(), 3)
            w.gate.set()
            b = asyncio.create_task(c.send_replay_frames(self.frames("b", 3)))
            await asyncio.sleep(0)
            # The writer drained the queue and granted A a round; B arrived
            # meanwhile and parked behind that pending grant.
            self.assertEqual(c._send_q.qsize(), 0)
            self.assertEqual(c._room_granted, 1)
            self.assertEqual(len(c._room_waiters), 1)
            a.cancel()  # before A resumed: it will queue nothing more
            self.assertTrue(await asyncio.wait_for(b, 2), "B stalled behind a cancelled grant")
            for _ in range(50):
                if len(w.lines) == 7:
                    break
                await asyncio.sleep(0)
        self.assertTrue(a.cancelled())
        self.assertEqual(w.tags(), ["a"] * 4 + ["b"] * 3)
        self.assertEqual((c._room_granted, len(c._room_waiters)), (0, 0))



class _PacedWriter(_FakeWriter):
    """A consumer that reads ONE line per token (`pace` hands them out)."""

    def __init__(self):
        super().__init__()
        self.tokens: asyncio.Queue = asyncio.Queue()

    async def drain(self) -> None:
        await self.tokens.get()

    async def pace(self, every: float) -> None:
        while True:
            self.tokens.put_nowait(None)
            await asyncio.sleep(every)


class ReplayStallGuardTests(unittest.IsolatedAsyncioTestCase):
    """The stall guard of a parked back-pressured writer (agent >= 0.103.1):
    no line written for REPLAY_STALL_TIMEOUT_S ⇒ drop; a consumer that keeps
    reading — however slowly — is never dropped."""

    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)

    def client(self, writer: _FakeWriter) -> server_mod.Client:
        c = server_mod.Client(None, None, writer)
        self.addAsyncCleanup(FairRoomHandOffTests._close, c)
        return c

    async def test_a_consumer_reading_nothing_is_dropped_and_the_parked_writer_stops(self):
        w = _PacedWriter()                                   # no token: drain() never returns
        c = self.client(w)
        with patch.multiple(server_mod, REPLAY_HIGH_WATER_EVENTS=10, REPLAY_LOW_WATER_EVENTS=2,
                            REPLAY_STALL_TIMEOUT_S=0.2):
            ok = await asyncio.wait_for(
                c.send_replay_frames(FairRoomHandOffTests.frames("a", 50)), 5)
        self.assertFalse(ok)
        self.assertTrue(c.closed)
        self.assertEqual((c._room_granted, len(c._room_waiters)), (0, 0))

    async def test_a_consumer_slower_than_the_timeout_per_park_but_reading_is_never_dropped(self):
        # Each park needs 12 lines written (HIGH 14 → LOW 2) at one per 50 ms:
        # 0.6 s, twice the stall timeout — but a line leaves every 50 ms.
        w = _PacedWriter()
        c = self.client(w)
        with patch.multiple(server_mod, REPLAY_HIGH_WATER_EVENTS=14, REPLAY_LOW_WATER_EVENTS=2,
                            REPLAY_STALL_TIMEOUT_S=0.3):
            pacer = asyncio.create_task(w.pace(0.05))
            try:
                ok = await asyncio.wait_for(
                    c.send_replay_frames(FairRoomHandOffTests.frames("a", 40)), 10)
            finally:
                pacer.cancel()
        self.assertTrue(ok)
        self.assertFalse(c.closed)

if __name__ == "__main__":
    unittest.main()
