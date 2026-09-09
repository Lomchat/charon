"""The app-server may outrun the SDK's models — that must cost an item, not a session.

Charon runs the standalone Codex CLI ahead of the Python SDK on purpose
(`codex_session._external_codex_bin`). CLI 0.153.4 started reporting
`subAgentActivity` items with `kind:"completed"`; SDK 0.147.0's enum knew only
started/interacted/interrupted, so pydantic failed the ENTIRE
`ThreadResumeResponse`. `thread/resume` raised, the session went to `error`,
and every later resume replayed the same failure against the same immutable
history: the thread was permanently unresumable while the CLI read it fine.

Two guarantees are pinned here:
  1. an item the SDK cannot type is DROPPED from the parsed view, and only it —
     a real error still raises;
  2. `thread/resume` does not validate history at all, since Charon reads one
     field of that response (the id it already knew).

stdlib unittest only. Run with:
    python3.10 agent/tests/test_codex_schema_drift.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import codex_compat  # noqa: E402


class FakeThreadItem:
    """Stands in for the SDK's generated ThreadItem union."""

    KNOWN_KINDS = {"started", "interacted", "interrupted"}

    @classmethod
    def model_validate(cls, data):
        if not isinstance(data, dict) or "type" not in data:
            raise ValueError("not a thread item")
        if data["type"] == "subAgentActivity" and data.get("kind") not in cls.KNOWN_KINDS:
            raise ValueError(f"Input should be 'started', 'interacted' or 'interrupted'")
        if data["type"] == "unknownFuturething":
            raise ValueError("no such variant")
        return data


def _payload():
    return {
        "thread": {
            "id": "01a07b35-7963-7e03-9a7e-727e39144740",
            "turns": [
                {
                    "id": "t1",
                    "items": [
                        {"type": "userMessage", "id": "u1", "content": "hi"},
                        {"type": "subAgentActivity", "id": "s1", "kind": "started"},
                        {"type": "subAgentActivity", "id": "s2", "kind": "completed"},
                        {"type": "unknownFuturething", "id": "x1"},
                        {"type": "agentMessage", "id": "a1", "text": "yo"},
                    ],
                },
                {"id": "t2", "items": [{"type": "userMessage", "id": "u2", "content": "ok"}]},
            ],
        }
    }


class DropUntypeableItems(unittest.TestCase):
    def test_drops_only_the_items_the_models_reject(self):
        payload = _payload()
        dropped = codex_compat.drop_untypeable_items(payload, FakeThreadItem)
        self.assertEqual(dropped, 2)
        kept = [i["id"] for i in payload["thread"]["turns"][0]["items"]]
        self.assertEqual(kept, ["u1", "s1", "a1"])
        # An untouched turn keeps its list object, not just its contents.
        self.assertEqual([i["id"] for i in payload["thread"]["turns"][1]["items"]], ["u2"])

    def test_a_clean_payload_is_left_alone(self):
        payload = {"thread": {"id": "t", "turns": [{"id": "1", "items": [
            {"type": "userMessage", "id": "u1", "content": "hi"}]}]}}
        self.assertEqual(codex_compat.drop_untypeable_items(payload, FakeThreadItem), 0)

    def test_walks_list_and_search_shapes(self):
        bad = {"type": "subAgentActivity", "id": "s", "kind": "completed"}
        listed = {"threads": [{"id": "a", "turns": [{"id": "1", "items": [dict(bad)]}]}]}
        searched = {"results": [{"snippet": "x", "thread": {
            "id": "b", "turns": [{"id": "1", "items": [dict(bad)]}]}}]}
        self.assertEqual(codex_compat.drop_untypeable_items(listed, FakeThreadItem), 1)
        self.assertEqual(codex_compat.drop_untypeable_items(searched, FakeThreadItem), 1)

    def test_ignores_unrelated_item_lists(self):
        """Only thread history is repaired — an `items` key elsewhere is data."""
        payload = {"items": [{"anything": 1}], "skills": {"items": [{"name": "x"}]}}
        self.assertEqual(codex_compat.drop_untypeable_items(payload, FakeThreadItem), 0)
        self.assertEqual(payload["items"], [{"anything": 1}])


class InstallOnTheRequestFunnel(unittest.TestCase):
    def setUp(self):
        calls = self.calls = []

        class FakeCodexClient:
            def _request_raw(self, method, params=None):
                calls.append((method, params))
                return _payload()

        self.cls = FakeCodexClient
        # openai_codex is never installed hub-side or in CI, so stand in for
        # the union the hook asks the SDK for.
        self._real = codex_compat._thread_item_model
        codex_compat._thread_item_model = lambda: FakeThreadItem

    def tearDown(self):
        codex_compat._thread_item_model = self._real

    def test_thread_methods_are_repaired_and_others_untouched(self):
        self.assertTrue(codex_compat.install(self.cls))
        client = self.cls()
        repaired = client._request_raw("thread/resume", {"threadId": "x"})
        self.assertEqual(
            [i["id"] for i in repaired["thread"]["turns"][0]["items"]], ["u1", "s1", "a1"]
        )
        untouched = client._request_raw("account/status", None)
        self.assertEqual(len(untouched["thread"]["turns"][0]["items"]), 5)
        self.assertEqual(self.calls[0][0], "thread/resume")

    def test_installing_twice_does_not_stack_wrappers(self):
        self.assertTrue(codex_compat.install(self.cls))
        once = self.cls._request_raw
        self.assertTrue(codex_compat.install(self.cls))
        self.assertIs(self.cls._request_raw, once)

    def test_a_moved_funnel_is_reported_not_silently_skipped(self):
        class Moved:
            pass

        self.assertFalse(codex_compat.install(Moved))


class ResumeReadsOnlyTheId(unittest.TestCase):
    def test_history_the_sdk_cannot_type_does_not_block_the_resume(self):
        raw = _payload()
        raw["thread"]["turns"][0]["items"].append(
            {"type": "somethingBrandNew", "shape": {"nobody": "knows"}}
        )
        raw["model"] = "a-model-this-sdk-never-heard-of"
        resumed = codex_compat.ResumedThread.model_validate(raw)
        self.assertEqual(resumed.thread.id, "01a07b35-7963-7e03-9a7e-727e39144740")

    def test_a_response_without_a_thread_id_still_fails(self):
        for bad in ({}, {"thread": {}}, {"thread": {"id": ""}}, {"thread": None}, None):
            with self.assertRaises(Exception):
                codex_compat.ResumedThread.model_validate(bad)


if __name__ == "__main__":
    unittest.main()
