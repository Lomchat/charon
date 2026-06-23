"""Harness smoke test for the Python agent (stdlib unittest, no deps).

Run all agent tests with:  python3 -m unittest discover -s agent/tests -v
The agent package is stdlib-only, so the tests are too.
"""
import os
import sys
import unittest

# Make `charon_agent` importable (agent/ is the package root).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestHarness(unittest.TestCase):
    def test_imports(self):
        import charon_agent  # noqa: F401
        from charon_agent import event_log, state, protocol  # noqa: F401
        self.assertTrue(True)


if __name__ == "__main__":
    unittest.main()
