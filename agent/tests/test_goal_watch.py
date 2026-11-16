"""Claude `/goal` read back from the transcript (§14.119): the CLI's own
goal_status records, folded incrementally — a set, a "not yet", a verdict, a
clear — and a replaced file read as a new epoch, never merged."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from charon_agent.goal_watch import GoalReader  # noqa: E402


def _line(att: dict, ts: str = "2026-11-16T08:00:00.000Z") -> str:
    return json.dumps({"type": "attachment", "timestamp": ts, "attachment": {"type": "goal_status", **att}}) + "\n"


class GoalWatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "s.jsonl"
        self.path.write_text("")
        self.reader = GoalReader()
        self.reader.reset(self.path)

    def tearDown(self) -> None:
        self.dir.cleanup()

    def append(self, text: str) -> None:
        with open(self.path, "a") as f:
            f.write(text)

    def test_set_not_yet_met_then_clear(self) -> None:
        cond = "tests pass"
        self.append(_line({"met": False, "sentinel": True, "condition": cond}))
        self.assertTrue(self.reader.scan())
        self.assertEqual(self.reader.goal["status"], "active")
        self.assertEqual(self.reader.goal["iterations"], 0)

        # An unrelated line and a half-written one: nothing changes yet.
        self.append(json.dumps({"type": "assistant", "message": {}}) + "\n")
        self.append(_line({"met": False, "condition": cond, "reason": "2 failing"})[:30])
        self.assertFalse(self.reader.scan())
        self.append(_line({"met": False, "condition": cond, "reason": "2 failing"})[30:])
        self.assertTrue(self.reader.scan())
        self.assertEqual((self.reader.goal["status"], self.reader.goal["iterations"], self.reader.goal["reason"]),
                         ("active", 1, "2 failing"))

        self.append(_line({"met": True, "condition": cond, "reason": "all green", "iterations": 2,
                           "durationMs": 9000, "tokens": 1234}))
        self.reader.scan()
        self.assertEqual(self.reader.goal["status"], "met")
        self.assertEqual((self.reader.goal["iterations"], self.reader.goal["tokens_used"]), (2, 1234))

        self.append(_line({"met": False, "sentinel": True, "condition": "other"}))
        self.append(_line({"met": True, "sentinel": True, "condition": "other"}))
        self.reader.scan()
        self.assertIsNone(self.reader.goal)

    def test_impossible_and_replaced_file(self) -> None:
        self.append(_line({"met": False, "sentinel": True, "condition": "x"}))
        self.append(_line({"met": False, "failed": True, "condition": "x", "reason": "no such API"}))
        self.reader.scan()
        self.assertEqual(self.reader.goal["status"], "failed")
        # Replaced (new inode, e.g. a rewrite): read again from the start.
        os.unlink(self.path)
        self.path.write_text(_line({"met": False, "sentinel": True, "condition": "y"}))
        self.assertTrue(self.reader.scan())
        self.assertEqual((self.reader.goal["objective"], self.reader.goal["status"]), ("y", "active"))


if __name__ == "__main__":
    unittest.main()
