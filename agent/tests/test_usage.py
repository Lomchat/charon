"""Tests for charon_agent.usage — the `Retry-After` parser.

The hub backs off against this value EXACTLY (CLAUDE.md §14.72): the endpoint
is throttled per source IP and hands out lockouts up to ~an hour, so a wrong
reading here means either hammering a closed door (and re-caching the error as
the widget's state, the original bug) or hiding working gauges for far too long.

stdlib unittest only. Run with:
    python3.10 agent/tests/test_usage.py
"""
import datetime
import email.utils
import os
import sys
import unittest

# Make `charon_agent` importable (agent/ is the package root).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.usage import _retry_after_seconds  # noqa: E402


class FakeHeaders:
    """Minimal stand-in for http.client.HTTPMessage (only .get is used)."""

    def __init__(self, mapping):
        self._m = mapping

    def get(self, key, default=None):
        return self._m.get(key, default)


class TestRetryAfterSeconds(unittest.TestCase):
    def test_none_headers(self):
        self.assertIsNone(_retry_after_seconds(None))

    def test_header_absent(self):
        self.assertIsNone(_retry_after_seconds(FakeHeaders({})))

    def test_delta_seconds(self):
        # The shape the endpoint actually sends (observed: 0, 380, 1025, 3079).
        self.assertEqual(_retry_after_seconds(FakeHeaders({"Retry-After": "3079"})), 3079.0)
        self.assertEqual(_retry_after_seconds(FakeHeaders({"Retry-After": "380"})), 380.0)

    def test_zero_is_zero_not_none(self):
        # `Retry-After: 0` is the short burst bucket. It must parse as 0 (the
        # hub then falls through to its own escalating guess) and NOT as None
        # in a way that loses the distinction from "no header at all".
        self.assertEqual(_retry_after_seconds(FakeHeaders({"Retry-After": "0"})), 0.0)

    def test_whitespace_and_float(self):
        self.assertEqual(_retry_after_seconds(FakeHeaders({"Retry-After": "  42 "})), 42.0)
        self.assertEqual(_retry_after_seconds(FakeHeaders({"Retry-After": "1.5"})), 1.5)

    def test_negative_clamped_to_zero(self):
        self.assertEqual(_retry_after_seconds(FakeHeaders({"Retry-After": "-5"})), 0.0)

    def test_http_date_future(self):
        # RFC 7231 also allows an HTTP-date. Should come back as a positive
        # delta, roughly the offset we put in.
        when = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=120)
        raw = email.utils.format_datetime(when)
        got = _retry_after_seconds(FakeHeaders({"Retry-After": raw}))
        self.assertIsNotNone(got)
        self.assertGreater(got, 100.0)
        self.assertLess(got, 140.0)

    def test_http_date_in_the_past_clamped(self):
        when = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=600)
        raw = email.utils.format_datetime(when)
        self.assertEqual(_retry_after_seconds(FakeHeaders({"Retry-After": raw})), 0.0)

    def test_garbage_is_none(self):
        # Never raise out of a header parse — the caller is an error path.
        for bad in ["", "soon", "!!", "Thu, 99 Xxx"]:
            self.assertIsNone(
                _retry_after_seconds(FakeHeaders({"Retry-After": bad})), f"input={bad!r}"
            )


if __name__ == "__main__":
    unittest.main()
