"""Tests for charon_agent.state — tolerant load + atomic save of state.json.

stdlib unittest only (the agent package is stdlib-only). Run with:
    python3.10 agent/tests/test_state.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Make `charon_agent` importable (agent/ is the package root).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import state  # noqa: E402
from charon_agent.state import STATE_VERSION, load_state, save_state  # noqa: E402


class StateTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="charon-state-test-")
        self.dir = Path(self._tmp.name)
        self.path = self.dir / "state.json"

    def tearDown(self):
        self._tmp.cleanup()


class TestLoadMissing(StateTestBase):
    def test_missing_file_returns_default(self):
        # File does not exist on disk.
        self.assertFalse(self.path.exists())
        data = load_state(self.path)
        self.assertIsInstance(data, dict)
        self.assertEqual(data["version"], STATE_VERSION)
        self.assertEqual(data["sessions"], [])

    def test_missing_file_does_not_create_it(self):
        # Pure read: loading a missing file must not write anything.
        load_state(self.path)
        self.assertFalse(self.path.exists())

    def test_missing_in_nonexistent_dir(self):
        # Parent dir doesn't exist either — still must not crash.
        deep = self.dir / "no" / "such" / "dir" / "state.json"
        data = load_state(deep)
        self.assertEqual(data, {"version": STATE_VERSION, "sessions": []})
        self.assertFalse(deep.exists())


class TestLoadCorrupt(StateTestBase):
    """The documented 'tolerant load' — never crash on bad input."""

    def test_empty_file(self):
        self.path.write_text("")
        data = load_state(self.path)
        self.assertEqual(data, {"version": STATE_VERSION, "sessions": []})

    def test_garbage_json(self):
        self.path.write_text("{this is not valid json,,,")
        data = load_state(self.path)
        self.assertEqual(data, {"version": STATE_VERSION, "sessions": []})

    def test_truncated_json(self):
        # A half-written file (e.g. crash mid-write without atomicity).
        self.path.write_text('{"version": 1, "sessions": [{"session_id": "a"')
        data = load_state(self.path)
        self.assertEqual(data, {"version": STATE_VERSION, "sessions": []})

    def test_json_is_a_list_not_dict(self):
        # Valid JSON but wrong top-level type → default.
        self.path.write_text(json.dumps([1, 2, 3]))
        data = load_state(self.path)
        self.assertEqual(data, {"version": STATE_VERSION, "sessions": []})

    def test_json_is_a_scalar(self):
        self.path.write_text(json.dumps(42))
        data = load_state(self.path)
        self.assertEqual(data, {"version": STATE_VERSION, "sessions": []})

    def test_json_is_null(self):
        self.path.write_text(json.dumps(None))
        data = load_state(self.path)
        self.assertEqual(data, {"version": STATE_VERSION, "sessions": []})


class TestLoadTolerantFill(StateTestBase):
    """Partial-but-valid dicts get missing fields filled in, not discarded."""

    def test_missing_version_filled(self):
        self.path.write_text(json.dumps({"sessions": []}))
        data = load_state(self.path)
        self.assertEqual(data["version"], STATE_VERSION)
        self.assertEqual(data["sessions"], [])

    def test_missing_sessions_filled(self):
        self.path.write_text(json.dumps({"version": 1}))
        data = load_state(self.path)
        self.assertEqual(data["sessions"], [])

    def test_sessions_wrong_type_replaced(self):
        # sessions present but not a list → coerced to [].
        self.path.write_text(json.dumps({"version": 1, "sessions": "oops"}))
        data = load_state(self.path)
        self.assertEqual(data["sessions"], [])

    def test_sessions_dict_replaced(self):
        self.path.write_text(json.dumps({"version": 1, "sessions": {"a": 1}}))
        data = load_state(self.path)
        self.assertEqual(data["sessions"], [])

    def test_preexisting_version_preserved(self):
        # A different version is NOT clobbered (only filled when absent).
        self.path.write_text(json.dumps({"version": 99, "sessions": []}))
        data = load_state(self.path)
        self.assertEqual(data["version"], 99)

    def test_extra_top_level_keys_preserved(self):
        # Tolerant load keeps unknown keys (forward compat).
        self.path.write_text(
            json.dumps({"version": 1, "sessions": [], "future_key": "kept"})
        )
        data = load_state(self.path)
        self.assertEqual(data["future_key"], "kept")

    def test_valid_sessions_preserved_verbatim(self):
        sessions = [
            {
                "session_id": "abc",
                "claude_session_id": "uuid-1",
                "cwd": "/home/x",
                "name": None,
                "permission_mode": "normal",
                "status": "sleeping",
            }
        ]
        self.path.write_text(json.dumps({"version": 1, "sessions": sessions}))
        data = load_state(self.path)
        self.assertEqual(data["sessions"], sessions)


class TestSaveLoadRoundTrip(StateTestBase):
    def test_round_trip_preserves_data(self):
        sessions = [
            {
                "session_id": "s1",
                "claude_session_id": "u1",
                "cwd": "/a",
                "name": "first",
                "permission_mode": "auto",
                "status": "sleeping",
            },
            {
                "session_id": "s2",
                "claude_session_id": None,
                "cwd": "/b",
                "name": None,
                "permission_mode": "normal",
                "status": "error",
            },
        ]
        save_state(self.path, sessions)
        loaded = load_state(self.path)
        self.assertEqual(loaded["version"], STATE_VERSION)
        self.assertEqual(loaded["sessions"], sessions)

    def test_save_empty_list(self):
        save_state(self.path, [])
        loaded = load_state(self.path)
        self.assertEqual(loaded["sessions"], [])

    def test_save_wraps_with_version(self):
        # The on-disk format must be the v1 envelope, not a bare list.
        save_state(self.path, [{"session_id": "x"}])
        raw = json.loads(self.path.read_text())
        self.assertIsInstance(raw, dict)
        self.assertEqual(raw["version"], STATE_VERSION)
        self.assertEqual(raw["sessions"], [{"session_id": "x"}])

    def test_save_creates_parent_dirs(self):
        nested = self.dir / "deep" / "nest" / "state.json"
        save_state(nested, [{"session_id": "z"}])
        self.assertTrue(nested.exists())
        self.assertEqual(load_state(nested)["sessions"], [{"session_id": "z"}])

    def test_status_field_persisted_verbatim(self):
        # state.py encodes NO status policy of its own — it persists whatever
        # the caller stored. (killed/sleeping/active filtering lives in
        # server.py, not here.) Verify each status value survives untouched.
        for st in ("sleeping", "error", "active", "killed", "starting"):
            with self.subTest(status=st):
                save_state(self.path, [{"session_id": "s", "status": st}])
                loaded = load_state(self.path)
                self.assertEqual(loaded["sessions"][0]["status"], st)

    def test_unicode_and_special_chars(self):
        sessions = [{"session_id": "é-✓", "name": "ligne1\nligne2\t\"quote\""}]
        save_state(self.path, sessions)
        loaded = load_state(self.path)
        self.assertEqual(loaded["sessions"], sessions)


class TestAtomicSave(StateTestBase):
    def test_overwrite_preserves_old_on_garbage_input(self):
        # First write good data.
        good = [{"session_id": "good", "status": "sleeping"}]
        save_state(self.path, good)
        self.assertEqual(load_state(self.path)["sessions"], good)

        # A non-serializable object raises during the tmp write; the original
        # file must remain intact (atomic = never half-written / clobbered).
        class NotJSON:
            pass

        with self.assertRaises(TypeError):
            save_state(self.path, [{"session_id": "bad", "obj": NotJSON()}])

        # Original is still readable & unchanged.
        self.assertEqual(load_state(self.path)["sessions"], good)

    def test_no_tmp_leftovers_on_success(self):
        save_state(self.path, [{"session_id": "a"}])
        leftovers = [p.name for p in self.dir.iterdir()
                     if p.name.startswith(".state.") and p.name.endswith(".tmp")]
        self.assertEqual(leftovers, [], f"tmp files leaked: {leftovers}")

    def test_no_tmp_leftovers_on_failure(self):
        class NotJSON:
            pass

        with self.assertRaises(TypeError):
            save_state(self.path, [{"obj": NotJSON()}])
        leftovers = [p.name for p in self.dir.iterdir()
                     if p.name.startswith(".state.") and p.name.endswith(".tmp")]
        self.assertEqual(leftovers, [], f"tmp files leaked on failure: {leftovers}")

    def test_target_never_partially_written(self):
        # After save, the file on disk must be COMPLETE valid JSON (the rename
        # only happens after the full content is flushed+fsynced to the tmp).
        big = [{"session_id": f"s{i}", "cwd": "/x" * 50} for i in range(500)]
        save_state(self.path, big)
        # Parse the raw bytes directly — if it were truncated this would raise.
        raw = json.loads(self.path.read_text())
        self.assertEqual(len(raw["sessions"]), 500)
        self.assertEqual(raw["sessions"][-1]["session_id"], "s499")

    def test_repeated_saves_replace_cleanly(self):
        for i in range(5):
            save_state(self.path, [{"session_id": f"gen{i}"}])
        loaded = load_state(self.path)
        self.assertEqual(loaded["sessions"], [{"session_id": "gen4"}])
        # Only the final state.json should exist (no accumulating tmp files).
        names = sorted(p.name for p in self.dir.iterdir())
        self.assertEqual(names, ["state.json"])

    def test_uses_distinct_temp_then_rename(self):
        # Sanity: the implementation writes via tempfile.mkstemp + os.replace.
        # Patch os.replace to capture the (src, dst) pair and confirm the
        # destination matches our target while the source is a tmp sibling.
        captured = {}
        orig_replace = os.replace

        def spy(src, dst):
            captured["src"] = src
            captured["dst"] = dst
            return orig_replace(src, dst)

        os.replace = spy
        try:
            save_state(self.path, [{"session_id": "a"}])
        finally:
            os.replace = orig_replace

        self.assertEqual(Path(captured["dst"]), self.path)
        self.assertNotEqual(Path(captured["src"]), self.path)
        self.assertEqual(Path(captured["src"]).parent, self.path.parent)


if __name__ == "__main__":
    unittest.main(verbosity=2)
