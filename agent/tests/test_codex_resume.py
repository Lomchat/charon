"""Tests for CodexSession's thread-resume path.

The invariant under test: **a resume failure must never silently start a fresh
thread.** For a Codex session the thread id IS the conversation, and it lives in
`claude_session_id` (CLAUDE.md §14.59). The old code fell back to
`thread_start()` on any resume exception; the new id then overwrote
`claude_session_id` and got persisted, so one transient hiccup (app-server still
booting, codex signed out, cwd momentarily missing) permanently destroyed the
resume handle — the session kept working but had silently lost all its context,
with a single `error` line as the only evidence.

So: retry once, then fail loudly into `error` WITHOUT touching the id, leaving a
later resume able to succeed once the real cause is fixed.

stdlib unittest only. Run with:
    python3.10 agent/tests/test_codex_resume.py
"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import codex_session as cs  # noqa: E402


THREAD_ID = "019fb202-0fd5-7093-84e9-7a18939b958c"


class FakeThread:
    def __init__(self, tid):
        self.id = tid


class FakeClient:
    """Stands in for AsyncCodex: records calls, fails resume on demand."""

    def __init__(self, *, resume_failures=0, resume_exc=None):
        self.resume_failures = resume_failures
        self.resume_exc = resume_exc or RuntimeError("thread not found")
        self.resume_calls = 0
        self.start_calls = 0

    async def thread_resume(self, thread_id, **kw):
        self.resume_calls += 1
        if self.resume_calls <= self.resume_failures:
            raise self.resume_exc
        return FakeThread(thread_id)

    async def thread_start(self, **kw):
        self.start_calls += 1
        return FakeThread("NEWLY-CREATED-THREAD")

    def close(self):
        return None


def _make_session(claude_session_id):
    """Build a CodexSession without running __init__'s SDK checks."""
    s = cs.CodexSession.__new__(cs.CodexSession)
    s.session_id = "sess-1"
    s.cwd = "/srv/charon"
    s.name = None
    s.kind = "codex"
    s.claude_session_id = claude_session_id
    s.permission_mode = "workspace-write"
    s.model = None
    s.fallback_model = None
    s.effort = None
    s.status = "starting"
    s._error_msg = None
    s._emitted = []
    s._streamed_items = set()
    s._session_id_emitted = False
    s._effective_model = None
    s._thread = None
    s._client = None
    s._active_turn = None
    s._main_task = None
    s._ready_evt = asyncio.Event()
    s._stdin_queue = asyncio.Queue()
    s._codex_stderr_lines = []      # _format_err tails this
    s._emit = lambda ev, **kw: s._emitted.append((ev, kw))
    s._emit_to_server = lambda payload: None
    s._save_state = _noop_coro
    return s


async def _noop_coro(*a, **kw):
    return None


class _FakeEnum:
    """Stand-in for the SDK's Sandbox / ApprovalMode enums."""
    read_only = "read-only"
    workspace_write = "workspace-write"
    full_access = "full-access"
    deny_all = "deny_all"
    auto_review = "auto_review"


def _run(session, client):
    """Drive _run() with a fake client, feeding None to end the turn loop.

    Every openai_codex symbol `_run` touches is stubbed, so this exercises OUR
    control flow with NO SDK installed — which is the case both on the hub and
    in CI (the SDK only ever lives in the remote VPS venv).
    """
    async def main():
        session._stdin_queue.put_nowait(None)   # end the turn loop immediately
        await session._run()

    saved = {n: getattr(cs, n) for n in ("AsyncCodex", "CodexConfig", "Sandbox", "ApprovalMode")}
    cs.AsyncCodex = lambda *a, **kw: client
    cs.CodexConfig = lambda **kw: None
    cs.Sandbox = _FakeEnum
    cs.ApprovalMode = _FakeEnum
    try:
        asyncio.run(main())
    finally:
        for n, v in saved.items():
            setattr(cs, n, v)


def _events(session, name):
    return [kw for ev, kw in session._emitted if ev == name]


class TestCodexResume(unittest.TestCase):
    def test_resume_success_keeps_thread_id(self):
        s = _make_session(THREAD_ID)
        c = FakeClient()
        _run(s, c)
        self.assertEqual(c.resume_calls, 1)
        self.assertEqual(c.start_calls, 0, "a successful resume must not start a thread")
        self.assertEqual(s.claude_session_id, THREAD_ID)

    def test_transient_failure_is_retried_once(self):
        # The app-server child is spawned lazily by the first RPC, so a single
        # failure is expected on a cold box — it must NOT cost the thread.
        s = _make_session(THREAD_ID)
        c = FakeClient(resume_failures=1)
        _run(s, c)
        self.assertEqual(c.resume_calls, 2)
        self.assertEqual(c.start_calls, 0)
        self.assertEqual(s.claude_session_id, THREAD_ID)
        self.assertNotEqual(s.status, "error")

    def test_persistent_failure_never_clobbers_the_thread_id(self):
        # THE regression guard: no fresh thread, id intact, loud error.
        s = _make_session(THREAD_ID)
        c = FakeClient(resume_failures=99)
        _run(s, c)
        self.assertEqual(c.resume_calls, 2, "retry once, then give up")
        self.assertEqual(c.start_calls, 0, "must NOT fall back to a fresh thread")
        self.assertEqual(s.claude_session_id, THREAD_ID, "the resume handle must survive")
        self.assertEqual(s.status, "error")
        self.assertTrue(_events(s, "error"), "the failure must be reported")
        self.assertIn("status", [ev for ev, _ in s._emitted])
        # No session_id event → the hub never persists a different id.
        self.assertEqual(_events(s, "session_id"), [])
        # A waiter on ready must be released, not left hanging.
        self.assertTrue(s._ready_evt.is_set())

    def test_no_thread_id_still_starts_fresh(self):
        # A brand-new session has no id yet: that path must keep working.
        s = _make_session(None)
        c = FakeClient()
        _run(s, c)
        self.assertEqual(c.resume_calls, 0)
        self.assertEqual(c.start_calls, 1)
        self.assertEqual(s.claude_session_id, "NEWLY-CREATED-THREAD")


if __name__ == "__main__":
    unittest.main()
