"""Tests for charon_agent.prompt_cache and its wiring in both session kinds.

A turn is several API requests; the hub's ledger and countdown read the
per-request counters shipped on `usage final:true` as `turn_cache`. A wrong
count does not raise — the header would simply claim a cold turn was warm.

stdlib unittest only. Run with:
    python3 agent/tests/test_prompt_cache.py
"""
import os
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import prompt_cache  # noqa: E402
from charon_agent.codex_session import CodexSession  # noqa: E402
from charon_agent.session import AgentSession  # noqa: E402


def _ev(name, **attrs):
    return type(name, (), attrs)()


class Counters(unittest.TestCase):
    def test_warm_requests_hit_and_a_cold_one_misses_with_its_rewrite(self):
        tc = prompt_cache.new_turn_cache()
        prompt_cache.count_request(tc, read=0, write=193_000, uncached=40, ttl_s=3600, now_ms=1_000)
        prompt_cache.count_request(tc, read=193_000, write=2_600, uncached=40, now_ms=5_000)
        prompt_cache.count_request(tc, read=195_600, write=1_900, uncached=40, now_ms=9_000)
        self.assertEqual(tc["requests"], 3)
        self.assertEqual(tc["hits"], 2)
        self.assertEqual(tc["misses"], 1)
        self.assertEqual(tc["miss_write_tokens"], 193_000)
        self.assertEqual(tc["read_tokens"], 388_600)
        self.assertEqual(tc["ttl_s"], 3600)  # a later request without writes keeps it
        self.assertEqual(tc["last_request_at"], 9_000)
        self.assertEqual(tc["last_prompt_tokens"], 195_600 + 1_900 + 40)

    def test_a_request_below_the_cacheable_minimum_is_neither(self):
        tc = prompt_cache.new_turn_cache()
        prompt_cache.count_request(tc, read=0, write=0, uncached=300)
        self.assertEqual((tc["requests"], tc["hits"], tc["misses"]), (1, 0, 0))

    def test_ttl_comes_from_the_written_breakdown_one_hour_first(self):
        self.assertEqual(prompt_cache.anthropic_ttl_s({"cache_creation": {
            "ephemeral_5m_input_tokens": 10, "ephemeral_1h_input_tokens": 20}}), 3600)
        self.assertEqual(prompt_cache.anthropic_ttl_s({"cache_creation": {
            "ephemeral_5m_input_tokens": 10, "ephemeral_1h_input_tokens": 0}}), 300)
        self.assertIsNone(prompt_cache.anthropic_ttl_s({}))
        self.assertEqual(prompt_cache.anthropic_write_tokens({"cache_creation": {"a": 3, "b": 4}}), 7)

    def test_no_request_no_payload(self):
        self.assertIsNone(prompt_cache.payload(prompt_cache.new_turn_cache()))
        self.assertIsNone(prompt_cache.payload({}))


def _claude_self():
    return types.SimpleNamespace(
        _session_id_emitted=True, claude_session_id="sid", _effective_model=None,
        _usage_in=0, _usage_cache=0, _usage_committed_out=0, _usage_cur_out=0,
        _usage_last_emit=0.0, _generation_characters=0, _generation_last_emit=0.0,
        _generation_last_sent=0, _blocking_turn_error=None, name=None, cwd="/tmp",
        _cli_title_value=None, _turn_cache=prompt_cache.new_turn_cache(),
    )


class ClaudeWiring(unittest.TestCase):
    def test_main_thread_message_starts_count_and_ride_on_the_final_usage(self):
        me = _claude_self()

        def start(usage, parent=None):
            with patch("charon_agent.session.time.monotonic", return_value=100.0):
                AgentSession._translate(me, _ev("StreamEvent", parent_tool_use_id=parent, event={
                    "type": "message_start", "message": {"usage": usage}}))

        start({"input_tokens": 12, "cache_read_input_tokens": 15_000, "cache_creation_input_tokens": 180_000,
               "cache_creation": {"ephemeral_1h_input_tokens": 180_000}})
        start({"input_tokens": 8, "cache_read_input_tokens": 195_000, "cache_creation_input_tokens": 2_000})
        # A subagent's request caches ITS prefix: not this turn's.
        start({"input_tokens": 5, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 9_000}, parent="toolu_1")
        out = AgentSession._translate(me, _ev(
            "ResultMessage", subtype="success", usage={"output_tokens": 50}, duration_ms=8_400,
            duration_api_ms=6_100, total_cost_usd=None, model_usage=None, is_error=False,
            structured_output=None, result="", session_id="sid", num_turns=2))
        usage = next(e for e in out if e.get("event") == "usage")
        self.assertEqual(usage["duration_api_ms"], 6_100)
        tc = usage["turn_cache"]
        self.assertEqual((tc["requests"], tc["hits"], tc["misses"]), (2, 1, 1))
        self.assertEqual(tc["miss_write_tokens"], 180_000)
        self.assertEqual(tc["ttl_s"], 3600)
        self.assertEqual(tc["last_prompt_tokens"], 8 + 195_000 + 2_000)


class CodexWiring(unittest.TestCase):
    def test_each_token_update_is_one_request_and_repeats_are_ignored(self):
        s = CodexSession.__new__(CodexSession)
        s._turn_cache = prompt_cache.new_turn_cache()

        def update(inp, cached, out, total):
            s._count_cache_request(types.SimpleNamespace(
                last=types.SimpleNamespace(input_tokens=inp, cached_input_tokens=cached, output_tokens=out),
                total=types.SimpleNamespace(input_tokens=total, output_tokens=out)))

        update(27_100, 0, 69, 27_100)          # cold: everything written
        update(27_200, 27_100, 243, 54_300)    # warm
        update(27_200, 27_100, 243, 54_300)    # the same notification again
        tc = s._turn_cache
        self.assertEqual((tc["requests"], tc["hits"], tc["misses"]), (2, 1, 1))
        self.assertEqual(tc["miss_write_tokens"], 27_100)
        self.assertEqual(tc["output_tokens"], 69 + 243)
        self.assertEqual(tc["uncached_tokens"], 0)


if __name__ == "__main__":
    unittest.main()
