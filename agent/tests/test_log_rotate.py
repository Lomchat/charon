"""Tests for charon_agent.log_rotate — bounding agent.log.

stdlib unittest only (the agent package is stdlib-only). Run with:
    python3.10 agent/tests/test_log_rotate.py

The invariant that matters is not "the file got smaller", it is that the
rotation is compatible with the ONE writer that exists: systemd holding an
O_APPEND fd it will never reopen (`StandardOutput=append:`). So the tests
below keep such an fd open ACROSS the rotation and check that the daemon's
next line lands at offset 0 of the live file rather than in a renamed inode
(what `mv` would give) or behind a multi-megabyte sparse hole (what truncating
a plain O_WRONLY fd would give).
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Make `charon_agent` importable (agent/ is the package root).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.log_rotate import rotate_if_needed  # noqa: E402


class LogRotateTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.log = Path(self._tmp.name) / "agent.log"

    def tearDown(self):
        self._tmp.cleanup()

    def test_below_the_cap_nothing_moves(self):
        self.log.write_text("hello\n")
        self.assertFalse(rotate_if_needed(self.log, max_bytes=1024))
        self.assertEqual(self.log.read_text(), "hello\n")
        self.assertFalse(self.log.with_name("agent.log.1").exists())

    def test_missing_file_is_not_an_error(self):
        self.assertFalse(rotate_if_needed(self.log, max_bytes=1))

    def test_over_the_cap_keeps_one_generation_and_truncates(self):
        self.log.write_text("x" * 5000)
        self.assertTrue(rotate_if_needed(self.log, max_bytes=1000))
        self.assertEqual(self.log.stat().st_size, 0)
        self.assertEqual(self.log.with_name("agent.log.1").read_text(), "x" * 5000)

    def test_a_second_rotation_replaces_the_previous_generation(self):
        self.log.write_text("first" * 500)
        rotate_if_needed(self.log, max_bytes=100)
        self.log.write_text("second" * 500)
        rotate_if_needed(self.log, max_bytes=100)
        self.assertEqual(self.log.with_name("agent.log.1").read_text(), "second" * 500)

    def test_an_open_append_fd_keeps_writing_into_the_live_file(self):
        # THE reason rotation is copy+truncate and not rename: systemd opened
        # this fd at unit start and will not reopen it.
        self.log.write_text("old" * 4000)
        with open(self.log, "a") as writer:  # O_APPEND, as systemd does
            self.assertTrue(rotate_if_needed(self.log, max_bytes=1000))
            writer.write("after rotation\n")
            writer.flush()
            # No sparse hole: the line is at offset 0 of the live file…
            self.assertEqual(self.log.read_text(), "after rotation\n")
            self.assertEqual(self.log.stat().st_size, len("after rotation\n"))
        # …and the previous generation still holds the old content.
        self.assertTrue(self.log.with_name("agent.log.1").read_text().startswith("old"))

    def test_the_pair_stays_bounded(self):
        for _ in range(5):
            with open(self.log, "a") as fh:
                fh.write("y" * 3000)
            rotate_if_needed(self.log, max_bytes=1000)
        total = self.log.stat().st_size + self.log.with_name("agent.log.1").stat().st_size
        self.assertLessEqual(total, 2 * 3000)


if __name__ == "__main__":
    unittest.main()
