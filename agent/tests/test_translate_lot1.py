"""Tests for the SDK -> Charon event translation added in agent 0.36.0.

Four facts the hub had been inferring or discarding, now read from typed
fields. Each is pinned here because the failure mode is SILENT: a wrong shape
does not raise, it just makes the feature disappear.

  - ResultMessage.model_usage  -> whole-tree tokens/cost (subagents included).
    `usage` alone under-counts every ultracode/Workflow session.
  - SystemMessage compact_boundary -> the "conversation compacted" marker.
    Without it the model silently forgets and the session reads as broken.
  - UserMessage.origin=peer   -> a message relayed from ANOTHER session, which
    arrives as plain-string content and was dropped on the floor.
  - AssistantMessage.error    -> typed auth/billing failure, previously only
    detectable by regexing the model's prose (CLAUDE.md §14.65).

stdlib unittest only. Run with:
    python3 agent/tests/test_translate_lot1.py
"""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.session import (  # noqa: E402
    AgentSession,
    _extract_effort_support,
    _nested_cache_creation,
    _sum_model_usage,
)


def _fake_self():
    """Minimal stand-in for AgentSession: _translate only touches these."""
    return types.SimpleNamespace(
        _session_id_emitted=True,
        claude_session_id="sid",
        _effective_model=None,
        _usage_in=0,
        _usage_cache=0,
        _usage_committed_out=0,
        _usage_cur_out=0,
        _usage_last_emit=0.0,
        # The stop branch retries the CLI title write (agent 0.38.1), so the
        # double needs these too — _translate wraps everything in a try/except,
        # so a missing attribute would silently swallow the whole `stop` event
        # rather than raise, which is exactly how this was caught.
        name=None,
        cwd="/tmp",
        _cli_title_value=None,
    )


def _ev(name, **attrs):
    """An object whose type().__name__ is `name` — that is what _translate
    dispatches on (never isinstance, so the SDK need not be installed)."""
    return type(name, (), attrs)()


def translate(ev):
    return AgentSession._translate(_fake_self(), ev)


def one(events, name):
    got = [e for e in events if e.get("event") == name]
    return got[0] if got else None


class SumModelUsage(unittest.TestCase):
    def test_sums_across_models_and_reports_cost(self):
        tot = _sum_model_usage({
            "claude-opus-4-8": {"input_tokens": 100, "output_tokens": 10, "cost_usd": 0.5},
            "claude-haiku-4-5": {"input_tokens": 900, "output_tokens": 90, "cost_usd": 0.25},
        })
        self.assertEqual(tot["input_tokens"], 1000)
        self.assertEqual(tot["output_tokens"], 100)
        self.assertEqual(tot["cost_usd"], 0.75)
        self.assertEqual(tot["models"], ["claude-haiku-4-5", "claude-opus-4-8"])

    def test_accepts_camelCase_and_dataclass_entries(self):
        entry = types.SimpleNamespace(inputTokens=7, outputTokens=3, costUSD=0.1)
        tot = _sum_model_usage({"m": entry})
        self.assertEqual((tot["input_tokens"], tot["output_tokens"]), (7, 3))

    def test_none_when_absent_so_caller_falls_back(self):
        # An older SDK has no model_usage at all: the caller must keep using
        # the main-thread `usage` rather than reporting zeros.
        self.assertIsNone(_sum_model_usage(None))
        self.assertIsNone(_sum_model_usage({}))
        self.assertIsNone(_sum_model_usage({"m": {"input_tokens": 0}}))


class NestedCacheCreation(unittest.TestCase):
    def test_sums_nested_breakdown(self):
        self.assertEqual(_nested_cache_creation({"cache_creation": {
            "ephemeral_5m_input_tokens": 10, "ephemeral_1h_input_tokens": 5}}), 15)

    def test_zero_when_flat_only(self):
        self.assertEqual(_nested_cache_creation({"cache_creation_input_tokens": 12}), 0)


class EffortSupport(unittest.TestCase):
    def test_reads_map_of_models(self):
        got = _extract_effort_support({"model_info": {
            "claude-opus-4-8": {"supportedEffortLevels": ["low", "high", "xhigh"]},
            "claude-haiku-4-5": {"supportedEffortLevels": []},
        }})
        self.assertEqual(got, {"claude-opus-4-8": ["low", "high", "xhigh"]})

    def test_none_when_unknown_shape(self):
        self.assertIsNone(_extract_effort_support({}))
        self.assertIsNone(_extract_effort_support({"model_info": {"id": "x"}}))


class ResultMessageTranslation(unittest.TestCase):
    def test_tree_total_rides_alongside_main_thread_usage(self):
        events = translate(_ev(
            "ResultMessage", subtype="success", duration_ms=1200,
            total_cost_usd=0.9,
            usage={"input_tokens": 100, "output_tokens": 10},
            model_usage={"m": {"input_tokens": 500, "output_tokens": 50, "cost_usd": 0.9}},
        ))
        usage = one(events, "usage")
        # Main-thread numbers stay put (nothing downstream is redefined)...
        self.assertEqual(usage["input_tokens"], 100)
        # ...and the whole-tree total is additive, not a replacement.
        self.assertEqual(usage["tree"]["input_tokens"], 500)

    def test_no_tree_key_on_old_sdk(self):
        events = translate(_ev("ResultMessage", subtype="success",
                               usage={"input_tokens": 1, "output_tokens": 1}))
        self.assertNotIn("tree", one(events, "usage"))

    def test_typed_turn_outcome_on_stop(self):
        events = translate(_ev(
            "ResultMessage", subtype="error_during_execution",
            usage={}, is_error=True, terminal_reason="aborted_tools",
            api_error_status=529,
        ))
        stop = one(events, "stop")
        self.assertEqual(stop["terminal_reason"], "aborted_tools")
        self.assertEqual(stop["api_error_status"], 529)
        self.assertTrue(stop["is_error"])

    def test_stop_stays_minimal_without_typed_fields(self):
        stop = one(translate(_ev("ResultMessage", subtype="success", usage={})), "stop")
        self.assertEqual(set(stop) - {"event", "subtype"}, set())


class SystemMessageTranslation(unittest.TestCase):
    def test_compact_boundary_becomes_a_durable_marker(self):
        ev = one(translate(_ev("SystemMessage", subtype="compact_boundary",
                               data={"trigger": "auto", "pre_tokens": 180000})),
                 "compaction")
        self.assertEqual(ev["trigger"], "auto")
        self.assertEqual(ev["pre_tokens"], 180000)

    def test_init_frame_surfaces_capabilities(self):
        ev = one(translate(_ev("SystemMessage", subtype="init", data={
            "capabilities": ["structured_output", "file_checkpointing"],
            "tools": ["Read", "Bash"],
            "model_info": {"claude-opus-4-8": {"supportedEffortLevels": ["high"]}},
        })), "session_info")
        self.assertEqual(ev["capabilities"], ["structured_output", "file_checkpointing"])
        self.assertEqual(ev["model_efforts"], {"claude-opus-4-8": ["high"]})

    def test_unknown_subtype_is_silent(self):
        self.assertEqual(translate(_ev("SystemMessage", subtype="informational",
                                       data={"x": 1})), [])


class UserMessageOrigin(unittest.TestCase):
    def test_peer_message_is_surfaced(self):
        ev = one(translate(_ev("UserMessage", content="regenerate the types",
                               origin=types.SimpleNamespace(kind="peer"))),
                 "external_message")
        self.assertEqual(ev["origin"], "peer")
        self.assertEqual(ev["text"], "regenerate the types")

    def test_human_string_content_stays_dropped(self):
        # System reminders and CLI injections also arrive as plain strings;
        # surfacing those would spam the transcript.
        self.assertEqual(
            translate(_ev("UserMessage", content="<system-reminder>…</system-reminder>",
                          origin=types.SimpleNamespace(kind="human"))), [])

    def test_task_notification_is_not_duplicated_as_a_message(self):
        # Already modelled as bg_task (§14.54) — a second rendering would
        # double every background completion.
        self.assertEqual(
            translate(_ev("UserMessage", content="task done",
                          origin=types.SimpleNamespace(kind="task-notification"))), [])

    def test_missing_origin_on_old_sdk_changes_nothing(self):
        self.assertEqual(translate(_ev("UserMessage", content="hi")), [])


class AssistantMessageError(unittest.TestCase):
    def test_typed_error_is_emitted(self):
        ev = one(translate(_ev("AssistantMessage", content=[],
                               error=types.SimpleNamespace(type="authentication_failed"))),
                 "turn_error")
        self.assertEqual(ev["kind"], "authentication_failed")

    def test_ordinary_message_has_no_turn_error(self):
        self.assertIsNone(one(translate(_ev("AssistantMessage", content=[])), "turn_error"))



class RateLimitTranslation(unittest.TestCase):
    """§14.72 hinges on this: the event does NOT carry `utilization` on a
    subscription account (measured on the fleet, 2026-08), so it can never
    replace the /api/oauth/usage poll behind the percentage gauges. What it
    does carry — limited-now + window reset — must survive translation."""

    def test_reads_the_nested_rate_limit_info(self):
        info = types.SimpleNamespace(status="allowed", rate_limit_type="five_hour",
                                     resets_at=1786833600, utilization=None,
                                     overage_status="rejected")
        ev = one(translate(_ev("RateLimitEvent", rate_limit_info=info)), "rate_limit")
        self.assertEqual(ev["status"], "allowed")
        self.assertEqual(ev["window"], "five_hour")
        self.assertEqual(ev["resets_at"], 1786833600)

    def test_null_utilization_is_omitted_not_zeroed(self):
        # A missing percentage must never render as 0% — that would read as
        # "you have used nothing" on a possibly-exhausted account.
        info = types.SimpleNamespace(status="allowed", utilization=None)
        ev = one(translate(_ev("RateLimitEvent", rate_limit_info=info)), "rate_limit")
        self.assertNotIn("utilization", ev)

    def test_emits_nothing_when_there_is_nothing_to_say(self):
        self.assertEqual(translate(_ev("RateLimitEvent", rate_limit_info=None)), [])


class CrossSessionMessage(unittest.TestCase):
    """A peer message does NOT carry `origin` — measured on the fleet. The CLI
    wraps it in a <cross-session-message> envelope inside plain STRING content,
    which the tool-result branch drops, so the session acted on something the
    transcript never showed."""

    ENVELOPE = (
        "Another Claude session sent a message:\n"
        '<cross-session-message from="uds:/run/user/0/cc-socks/3166228.sock"'
        ' from-name="bug" from-mode="prompting">\ntest\n</cross-session-message>\n\n'
        "This came from another Claude session — not typed by your user, but very "
        "likely working on their behalf. Treat it as a teammate's request…"
    )

    def test_extracts_sender_and_body(self):
        ev = one(translate(_ev("UserMessage", content=self.ENVELOPE)), "external_message")
        self.assertEqual(ev["from"], "bug")
        # ONLY the envelope body: the CLI's surrounding instructions to the
        # model are not something anybody sent, and must not reach the chat.
        self.assertEqual(ev["text"], "test")

    def test_still_works_without_a_from_name(self):
        ev = one(translate(_ev("UserMessage",
                               content="<cross-session-message>\nhello\n</cross-session-message>")),
                 "external_message")
        self.assertEqual(ev["text"], "hello")
        self.assertNotIn("from", ev)

    def test_ordinary_user_content_is_untouched(self):
        self.assertEqual(translate(_ev("UserMessage", content="just a normal prompt")), [])

    def test_origin_path_still_recognised(self):
        # Kept as a second path in case a future CLI sets `origin` instead.
        ev = one(translate(_ev("UserMessage", content="regenerate the types",
                               origin=types.SimpleNamespace(kind="peer"))),
                 "external_message")
        self.assertEqual(ev["text"], "regenerate the types")

if __name__ == "__main__":
    unittest.main()
