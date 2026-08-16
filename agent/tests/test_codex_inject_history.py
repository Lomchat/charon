"""Cross-provider history import tests (stdlib only, no SDK installed)."""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import codex_session as cs  # noqa: E402


class FakeRawClient:
    def __init__(self):
        self.calls = []

    async def request(self, method, params, *, response_model):
        self.calls.append((method, params, response_model))
        return object()


class FakeClient:
    def __init__(self):
        self._client = FakeRawClient()


def make_session(*, ready=True, status="active"):
    s = cs.CodexSession.__new__(cs.CodexSession)
    s.session_id = "dest-1"
    s.claude_session_id = "thread-123"
    s.status = status
    s._client = FakeClient()
    s._thread = type("Thread", (), {"id": "thread-123"})()
    s._active_turn = None
    s._ready_evt = asyncio.Event()
    if ready:
        s._ready_evt.set()
    return s


class TestCodexInjectHistory(unittest.TestCase):
    def setUp(self):
        self.old_model = cs._thread_inject_response_model
        cs._thread_inject_response_model = lambda: dict

    def tearDown(self):
        cs._thread_inject_response_model = self.old_model

    def test_injects_into_the_loaded_thread(self):
        s = make_session()
        items = [{
            "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": "hello"}],
        }]
        result = asyncio.run(s.inject_history(items))
        self.assertEqual(result, {"ok": True, "count": 1, "thread_id": "thread-123"})
        self.assertEqual(len(s._client._client.calls), 1)
        method, params, response_model = s._client._client.calls[0]
        self.assertEqual(method, "thread/inject_items")
        self.assertEqual(params, {"threadId": "thread-123", "items": items})
        self.assertIs(response_model, dict)

    def test_rejects_a_mismatched_content_role(self):
        s = make_session()
        items = [{
            "type": "message", "role": "assistant",
            "content": [{"type": "input_text", "text": "wrong"}],
        }]
        with self.assertRaisesRegex(ValueError, "output_text"):
            asyncio.run(s.inject_history(items))
        self.assertEqual(s._client._client.calls, [])

    def test_ready_error_is_not_treated_as_importable(self):
        s = make_session(status="error")
        items = [{
            "type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": "hello"}],
        }]
        with self.assertRaisesRegex(RuntimeError, "status=error"):
            asyncio.run(s.inject_history(items))


if __name__ == "__main__":
    unittest.main()
