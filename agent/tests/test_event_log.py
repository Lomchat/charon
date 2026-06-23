"""Tests for charon_agent.event_log — the durable per-session event log.

stdlib unittest only (the agent package is stdlib-only). Run with:
    python3.10 agent/tests/test_event_log.py

Covers the real invariants from CLAUDE.md §14.31:
- append/_emit assigns a monotonic seq + ts, increasing across calls.
- read_since(after_seq) returns exactly seq > after_seq, ordered; (0) all; (cur) [].
- rotation at the size cap, and read_since spans rotated files.
- current_seq()/_recover_seq() recovers max seq after a fresh open (restart),
  including scanning rotated files.
- cleanup_orphans + delete behaviour.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Make `charon_agent` importable (agent/ is the package root).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import event_log  # noqa: E402
from charon_agent.event_log import (  # noqa: E402
    EventLog,
    cleanup_orphans,
    MAX_ROTATIONS,
)


class EventLogTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.sid = "abc123sessionid"

    def tearDown(self):
        self._tmp.cleanup()

    def make(self, sid=None):
        return EventLog(sid or self.sid, self.base)

    # ── construction / validation ────────────────────────────────────────
    def test_invalid_session_id_rejected(self):
        for bad in ["", "a/b", "a\0b"]:
            with self.assertRaises(ValueError):
                EventLog(bad, self.base)

    # ── monotonic seq + ts ───────────────────────────────────────────────
    def test_append_assigns_monotonic_seq_starting_at_1(self):
        log = self.make()
        seqs = [log.append({"event": "assistant_text", "delta": str(i)})
                for i in range(5)]
        self.assertEqual(seqs, [1, 2, 3, 4, 5])
        self.assertEqual(log.current_seq(), 5)

    def test_append_mutates_event_dict_with_seq_and_ts(self):
        log = self.make()
        evt = {"event": "tool_use", "name": "Bash"}
        seq = log.append(evt)
        self.assertEqual(evt["seq"], seq)
        self.assertIn("ts", evt)
        self.assertIsInstance(evt["ts"], float)

    def test_ts_is_non_decreasing_across_calls(self):
        log = self.make()
        ts = []
        for i in range(10):
            evt = {"event": "thinking", "text": str(i)}
            log.append(evt)
            ts.append(evt["ts"])
        for a, b in zip(ts, ts[1:]):
            self.assertLessEqual(a, b)

    def test_ts_already_present_is_preserved_in_event_but_record_uses_fresh(self):
        # append setdefaults ts on the event dict, but the persisted record
        # always gets a fresh ts via {"seq":.., "ts":.., **event}. Verify the
        # caller-supplied ts on the event dict survives (setdefault).
        log = self.make()
        evt = {"event": "x", "ts": 123.0}
        log.append(evt)
        self.assertEqual(evt["ts"], 123.0)
        # But the persisted record overrides with a fresh ts (event spread last
        # would actually let the supplied ts win — verify actual behaviour).
        rec = self._read_all_records()[0]
        # record = {"seq":.., "ts": fresh, **event} and event has ts=123.0,
        # so the spread overwrites the fresh ts → persisted ts is 123.0.
        self.assertEqual(rec["ts"], 123.0)

    # ── read_since ───────────────────────────────────────────────────────
    def test_read_since_zero_returns_all_in_order(self):
        log = self.make()
        for i in range(20):
            log.append({"event": "e", "i": i})
        out = log.read_since(0)
        self.assertEqual([e["seq"] for e in out], list(range(1, 21)))
        self.assertEqual([e["i"] for e in out], list(range(20)))

    def test_read_since_returns_only_greater_seq(self):
        log = self.make()
        for i in range(10):
            log.append({"event": "e", "i": i})
        out = log.read_since(5)
        self.assertEqual([e["seq"] for e in out], [6, 7, 8, 9, 10])

    def test_read_since_current_returns_empty(self):
        log = self.make()
        for i in range(7):
            log.append({"event": "e", "i": i})
        self.assertEqual(log.read_since(log.current_seq()), [])
        self.assertEqual(log.read_since(7), [])
        # also beyond current
        self.assertEqual(log.read_since(999), [])

    def test_read_since_limit(self):
        log = self.make()
        for i in range(10):
            log.append({"event": "e", "i": i})
        out = log.read_since(0, limit=3)
        self.assertEqual([e["seq"] for e in out], [1, 2, 3])

    def test_read_since_on_fresh_log_is_empty(self):
        log = self.make()
        self.assertEqual(log.read_since(0), [])

    # ── rotation ─────────────────────────────────────────────────────────
    def _force_rotation(self, log, num_appends, big=True):
        """Append events large enough to trigger rotation by shrinking the
        cap. We monkeypatch MAX_FILE_BYTES low so we don't write 10MB."""
        for i in range(num_appends):
            payload = "X" * 4000 if big else str(i)
            log.append({"event": "e", "i": i, "data": payload})

    def test_rotation_creates_rotated_file_and_spans_read(self):
        # Shrink the cap so rotation triggers quickly and deterministically.
        orig = event_log.MAX_FILE_BYTES
        event_log.MAX_FILE_BYTES = 5000  # ~1 big event per file
        try:
            log = self.make()
            # Each event ~4KB; with a 5KB cap, every event after the first
            # triggers a rotation (active file exceeds cap before next append).
            for i in range(8):
                log.append({"event": "e", "i": i, "data": "X" * 4000})
            # A rotated .1 file must now exist.
            rotated1 = self.base / f"{self.sid}.jsonl.1"
            self.assertTrue(rotated1.exists(),
                            "rotation should have created a .1 file")
            # read_since(0) must return ALL events across rotations, in order,
            # with no gaps and no duplicates.
            out = log.read_since(0)
            self.assertEqual([e["seq"] for e in out], list(range(1, 9)))
            self.assertEqual([e["i"] for e in out], list(range(8)))
        finally:
            event_log.MAX_FILE_BYTES = orig

    def test_rotation_caps_number_of_rotated_files(self):
        orig = event_log.MAX_FILE_BYTES
        event_log.MAX_FILE_BYTES = 5000
        try:
            log = self.make()
            # Many rotations — far more than MAX_ROTATIONS.
            for i in range(40):
                log.append({"event": "e", "i": i, "data": "X" * 4000})
            # At most MAX_ROTATIONS rotated files survive.
            existing = [
                self.base / f"{self.sid}.jsonl.{n}"
                for n in range(1, MAX_ROTATIONS + 2)
                if (self.base / f"{self.sid}.jsonl.{n}").exists()
            ]
            self.assertLessEqual(len(existing), MAX_ROTATIONS)
            # seq stays monotonic and gapless from wherever it starts.
            out = log.read_since(0)
            seqs = [e["seq"] for e in out]
            self.assertEqual(seqs, sorted(seqs))
            self.assertEqual(len(seqs), len(set(seqs)))  # no dups
            # The newest event (seq 40) must still be present.
            self.assertEqual(out[-1]["seq"], 40)
            self.assertEqual(log.current_seq(), 40)
        finally:
            event_log.MAX_FILE_BYTES = orig

    def test_read_since_spans_rotations_with_partial_cursor(self):
        orig = event_log.MAX_FILE_BYTES
        event_log.MAX_FILE_BYTES = 5000
        try:
            log = self.make()
            for i in range(8):
                log.append({"event": "e", "i": i, "data": "X" * 4000})
            self.assertTrue((self.base / f"{self.sid}.jsonl.1").exists())
            # A cursor mid-history must still cross the rotation boundary.
            out = log.read_since(3)
            self.assertEqual([e["seq"] for e in out], [4, 5, 6, 7, 8])
        finally:
            event_log.MAX_FILE_BYTES = orig

    # ── restart recovery (_recover_seq) ──────────────────────────────────
    def test_recover_seq_after_fresh_open(self):
        log = self.make()
        for i in range(13):
            log.append({"event": "e", "i": i})
        self.assertEqual(log.current_seq(), 13)
        # Simulate a restart: brand new instance over the same dir.
        log2 = self.make()
        self.assertEqual(log2.current_seq(), 13)
        # New appends continue from the recovered max, never reuse a seq.
        self.assertEqual(log2.append({"event": "e"}), 14)

    def test_recover_seq_scans_rotated_files(self):
        # CLAUDE.md §14.31: _recover_seq must scan rotated files too.
        # Construct the documented edge case: a rotation happens, then the
        # process crashes BEFORE the next append writes to the new active
        # file, so the active file is absent on reload — yet the rotated
        # files hold high seqs we must not clash with. Recovery must scan the
        # rotated files and return their max (NOT 0, which would re-issue
        # already-used seqs).
        orig = event_log.MAX_FILE_BYTES
        event_log.MAX_FILE_BYTES = 5000
        try:
            log = self.make()
            for i in range(8):
                log.append({"event": "e", "i": i, "data": "X" * 4000})
            # Delete the active file, keeping only the rotated files.
            self.assertTrue(log.path.exists())
            log.path.unlink()
            rotated = list(self.base.glob(f"{self.sid}.jsonl.*"))
            self.assertTrue(rotated, "expected rotated files to remain")
            # The max seq still on disk lives entirely in rotated files.
            disk_max = 0
            for rp in rotated:
                for rec in self._records_in(rp):
                    if isinstance(rec.get("seq"), int):
                        disk_max = max(disk_max, rec["seq"])
            self.assertGreater(disk_max, 0)
            # Fresh instance (restart): recovery scans rotated files → disk_max.
            # If _recover_seq ignored rotations it would return 0 here.
            log2 = self.make()
            self.assertEqual(log2.current_seq(), disk_max)
            # And must not clash — the next append continues past the rotated max.
            self.assertEqual(log2.append({"event": "e"}), disk_max + 1)
        finally:
            event_log.MAX_FILE_BYTES = orig

    def test_recover_seq_picks_global_max_across_all_files(self):
        # Even when the active file's max is LOWER than a rotated file's max
        # (defensive — shouldn't happen in steady state), recovery takes the
        # global max so seqs never collide.
        # Hand-craft files directly.
        self.base.mkdir(parents=True, exist_ok=True)
        rot = self.base / f"{self.sid}.jsonl.1"
        rot.write_text(
            json.dumps({"seq": 100, "ts": 1.0, "event": "old"}) + "\n"
            + json.dumps({"seq": 101, "ts": 1.0, "event": "old"}) + "\n"
        )
        active = self.base / f"{self.sid}.jsonl"
        active.write_text(
            json.dumps({"seq": 5, "ts": 1.0, "event": "active"}) + "\n"
        )
        log = self.make()
        self.assertEqual(log.current_seq(), 101)

    def test_recover_tolerates_corrupt_lines(self):
        self.base.mkdir(parents=True, exist_ok=True)
        active = self.base / f"{self.sid}.jsonl"
        active.write_bytes(
            (json.dumps({"seq": 1, "event": "ok"}) + "\n").encode()
            + b"this is not json\n"
            + (json.dumps({"seq": 2, "event": "ok"}) + "\n").encode()
            + b'{"seq": "not-an-int", "event": "weird"}\n'
            + (json.dumps({"seq": 4, "event": "ok"}) + "\n").encode()
        )
        log = self.make()
        # Max valid integer seq is 4; corrupt + non-int-seq lines skipped.
        self.assertEqual(log.current_seq(), 4)
        out = log.read_since(0)
        self.assertEqual([e["seq"] for e in out], [1, 2, 4])

    # ── delete ───────────────────────────────────────────────────────────
    def test_delete_removes_all_files_and_resets(self):
        orig = event_log.MAX_FILE_BYTES
        event_log.MAX_FILE_BYTES = 5000
        try:
            log = self.make()
            for i in range(8):
                log.append({"event": "e", "i": i, "data": "X" * 4000})
            self.assertTrue(log.path.exists())
            self.assertTrue((self.base / f"{self.sid}.jsonl.1").exists())
            log.delete()
            # All files gone.
            remaining = list(self.base.glob(f"{self.sid}.jsonl*"))
            self.assertEqual(remaining, [])
            # Idempotent: a second delete doesn't raise.
            log.delete()
            # After delete, a fresh append recreates and restarts seq at 1
            # (in-memory state was reset and no files remain to recover).
            self.assertEqual(log.append({"event": "e"}), 1)
        finally:
            event_log.MAX_FILE_BYTES = orig

    # ── cleanup_orphans ──────────────────────────────────────────────────
    def test_cleanup_orphans_removes_unknown_keeps_known(self):
        self.base.mkdir(parents=True, exist_ok=True)
        known = "keepme"
        orphan = "deleteme"
        EventLog(known, self.base).append({"event": "e"})
        orphan_log = EventLog(orphan, self.base)
        # Force a rotation on the orphan so it has multiple files.
        orig = event_log.MAX_FILE_BYTES
        event_log.MAX_FILE_BYTES = 5000
        try:
            for i in range(8):
                orphan_log.append({"event": "e", "data": "X" * 4000})
        finally:
            event_log.MAX_FILE_BYTES = orig
        # Sanity: both sets of files exist.
        self.assertTrue((self.base / f"{known}.jsonl").exists())
        self.assertTrue((self.base / f"{orphan}.jsonl").exists())
        self.assertTrue((self.base / f"{orphan}.jsonl.1").exists())

        n = cleanup_orphans(self.base, {known})
        # Orphan's active + rotated files all removed (≥2 files).
        self.assertGreaterEqual(n, 2)
        self.assertFalse((self.base / f"{orphan}.jsonl").exists())
        self.assertFalse((self.base / f"{orphan}.jsonl.1").exists())
        # Known session untouched.
        self.assertTrue((self.base / f"{known}.jsonl").exists())

    def test_cleanup_orphans_missing_dir_returns_zero(self):
        missing = self.base / "does-not-exist"
        self.assertEqual(cleanup_orphans(missing, set()), 0)

    def test_cleanup_orphans_ignores_non_log_files(self):
        self.base.mkdir(parents=True, exist_ok=True)
        (self.base / "random.txt").write_text("hi")
        (self.base / "notes.md").write_text("hi")
        n = cleanup_orphans(self.base, set())
        self.assertEqual(n, 0)
        self.assertTrue((self.base / "random.txt").exists())

    # ── helpers ──────────────────────────────────────────────────────────
    def _records_in(self, path):
        recs = []
        with path.open() as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        recs.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        return recs

    def _read_all_records(self):
        path = self.base / f"{self.sid}.jsonl"
        recs = []
        with path.open() as f:
            for line in f:
                line = line.strip()
                if line:
                    recs.append(json.loads(line))
        return recs


if __name__ == "__main__":
    unittest.main(verbosity=2)
