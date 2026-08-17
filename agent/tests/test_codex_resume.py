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
import types
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import codex_session as cs  # noqa: E402


THREAD_ID = "019fb202-0fd5-7093-84e9-7a18939b958c"


class FakeRetryableError(RuntimeError):
    pass


class FakeThread:
    def __init__(self, tid):
        self.id = tid
        self.names = []
        self.compactions = 0

    async def set_name(self, name):
        self.names.append(name)

    async def compact(self):
        self.compactions += 1
        return {"compacted": True}


class FakeClient:
    """Stands in for AsyncCodex: records calls, fails resume on demand."""

    def __init__(self, *, resume_failures=0, resume_exc=None):
        self.resume_failures = resume_failures
        self.resume_exc = resume_exc or FakeRetryableError("server overloaded")
        self.resume_calls = 0
        self.start_calls = 0
        self.fork_calls = []
        self.archive_calls = []
        self.unarchive_calls = []
        self.close_calls = 0

    async def thread_resume(self, thread_id, **kw):
        self.resume_calls += 1
        if self.resume_calls <= self.resume_failures:
            raise self.resume_exc
        return FakeThread(thread_id)

    async def thread_start(self, **kw):
        self.start_calls += 1
        return FakeThread("NEWLY-CREATED-THREAD")

    async def thread_fork(self, thread_id, **kw):
        self.fork_calls.append((thread_id, kw))
        return FakeThread("FORKED-THREAD")

    async def thread_archive(self, thread_id):
        self.archive_calls.append(thread_id)

    async def thread_unarchive(self, thread_id):
        self.unarchive_calls.append(thread_id)
        return FakeThread(thread_id)

    async def close(self):
        self.close_calls += 1


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
    s.codex_config = {}
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
    s._global_task = None
    s._external_turn_task = None
    s._external_probe_task = None
    s._external_probe_lock = None
    s._starting_turn = False
    s._external_probe_task = None
    s._external_probe_lock = None
    s._starting_turn = False
    s._fs_watch_id = None
    s._ready_evt = asyncio.Event()
    s._stopped = asyncio.Event()
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

    saved = {n: getattr(cs, n) for n in (
        "AsyncCodex", "CodexConfig", "Sandbox", "ApprovalMode", "is_retryable_error",
    )}
    cs.AsyncCodex = lambda *a, **kw: client
    cs.CodexConfig = lambda **kw: None
    cs.Sandbox = _FakeEnum
    cs.ApprovalMode = _FakeEnum
    cs.is_retryable_error = lambda exc: isinstance(exc, FakeRetryableError)
    try:
        asyncio.run(main())
    finally:
        for n, v in saved.items():
            setattr(cs, n, v)


def _events(session, name):
    return [kw for ev, kw in session._emitted if ev == name]


class TestCodexResume(unittest.TestCase):
    def test_make_codex_config_prefers_managed_cli_but_honours_override(self):
        saved_bin, saved_config = cs.CODEX_CLI_BIN, cs.CodexConfig
        cs.CODEX_CLI_BIN = "/managed/codex"
        cs.CodexConfig = lambda **kw: kw
        try:
            self.assertEqual(cs.make_codex_config(cwd="/tmp")["codex_bin"], "/managed/codex")
            self.assertEqual(
                cs.make_codex_config(cwd="/tmp", codex_bin="/session/codex")["codex_bin"],
                "/session/codex",
            )
        finally:
            cs.CODEX_CLI_BIN, cs.CodexConfig = saved_bin, saved_config

    def test_advanced_codex_config_is_normalized_and_persisted(self):
        s = cs.CodexSession(
            "cfg", cwd="/tmp", name=None, permission_mode="workspace-write",
            claude_session_id=None, emit=lambda _e: None,
            on_state_change=lambda: None,
            codex_config={
                "configOverrides": ["features.foo=true"],
                "outputSchema": {"type": "object"},
                "summary": "detailed", "personality": "friendly",
                "serviceTier": "flex", "ephemeral": True,
                "modelProvider": "bedrock", "env": {"REGION": "eu"},
                "codexBin": "/opt/codex",
            },
        )
        saved = s.to_persist()["codex_config"]
        self.assertEqual(saved["configOverrides"], ["features.foo=true"])
        self.assertEqual(saved["outputSchema"], {"type": "object"})
        self.assertEqual(saved["summary"], "detailed")
        self.assertTrue(saved["ephemeral"])

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
        self.assertEqual(c.resume_calls, 3, "typed transient failures get bounded backoff")
        self.assertEqual(c.start_calls, 0, "must NOT fall back to a fresh thread")
        self.assertEqual(s.claude_session_id, THREAD_ID, "the resume handle must survive")
        self.assertEqual(s.status, "error")
        self.assertTrue(_events(s, "error"), "the failure must be reported")
        self.assertIn("status", [ev for ev, _ in s._emitted])
        # No session_id event → the hub never persists a different id.
        self.assertEqual(_events(s, "session_id"), [])
        # A waiter on ready must be released, not left hanging.
        self.assertTrue(s._ready_evt.is_set())

    def test_fatal_resume_failure_is_not_retried(self):
        s = _make_session(THREAD_ID)
        c = FakeClient(resume_failures=99, resume_exc=ValueError("bad thread id"))
        _run(s, c)
        self.assertEqual(c.resume_calls, 1)
        self.assertEqual(c.start_calls, 0)
        self.assertEqual(s.claude_session_id, THREAD_ID)
        self.assertEqual(s.status, "error")

    def test_no_thread_id_still_starts_fresh(self):
        # A brand-new session has no id yet: that path must keep working.
        s = _make_session(None)
        c = FakeClient()
        _run(s, c)
        self.assertEqual(c.resume_calls, 0)
        self.assertEqual(c.start_calls, 1)
        self.assertEqual(s.claude_session_id, "NEWLY-CREATED-THREAD")

    def test_native_fork_names_the_new_thread(self):
        # Assert naming through a capturing client so the branch cannot regress
        # to a Charon-only label.
        class CapturingClient(FakeClient):
            async def thread_fork(self, thread_id, **kw):
                self.forked = await super().thread_fork(thread_id, **kw)
                return self.forked

        async def captured():
            s = _make_session(THREAD_ID)
            c = CapturingClient()
            s._client = c
            s._ready_evt.set()
            result = await s.fork("branch name")
            self.assertEqual(result["claude_session_id"], "FORKED-THREAD")
            self.assertEqual(c.fork_calls[0][0], THREAD_ID)
            self.assertEqual(c.forked.names, ["branch name"])

        asyncio.run(captured())

    def test_partial_fork_uses_native_last_turn_id(self):
        class Raw:
            def __init__(self): self.calls = []
            async def thread_fork(self, thread_id, params):
                self.calls.append((thread_id, params))
                return type("Response", (), {"thread": type("Thread", (), {"id": "PARTIAL"})()})()

        class Client:
            def __init__(self): self._client = Raw()

        async def captured():
            s = _make_session(THREAD_ID)
            s._client = Client()
            s._ready_evt.set()
            api = types.ModuleType("openai_codex.api")
            api.AsyncThread = lambda _client, thread_id: FakeThread(thread_id)
            package = types.ModuleType("openai_codex")
            package.__path__ = []
            with mock.patch.dict(sys.modules, {"openai_codex": package, "openai_codex.api": api}):
                result = await s.fork(last_turn_id="turn-7")
            self.assertEqual(result["claude_session_id"], "PARTIAL")
            self.assertEqual(s._client._client.calls[0][1]["lastTurnId"], "turn-7")

        asyncio.run(captured())

    def test_codex_subagents_are_scoped_and_nested(self):
        root = THREAD_ID
        rows = [
            types.SimpleNamespace(id="child", parent_thread_id=root, agent_nickname="worker",
                                  name=None, agent_role="explorer", preview="inspect", status={"type": "idle"}, created_at=1),
            types.SimpleNamespace(id="grandchild", parent_thread_id="child", agent_nickname=None,
                                  name="nested", agent_role=None, preview="deep", status={"type": "active"}, created_at=2),
            types.SimpleNamespace(id="unrelated", parent_thread_id="elsewhere", agent_nickname=None,
                                  name="other", agent_role=None, preview="no", status={"type": "idle"}, created_at=3),
        ]
        class Raw:
            async def request(self, *_args, **_kwargs):
                return types.SimpleNamespace(data=rows, next_cursor=None)
        class Client:
            _client = Raw()
        generated = types.ModuleType("openai_codex.generated.v2_all")
        generated.ThreadListResponse = object
        package = types.ModuleType("openai_codex"); package.__path__ = []
        generated_package = types.ModuleType("openai_codex.generated"); generated_package.__path__ = []

        async def captured():
            s = _make_session(root); s._client = Client()
            with mock.patch.dict(sys.modules, {
                "openai_codex": package, "openai_codex.generated": generated_package,
                "openai_codex.generated.v2_all": generated,
            }):
                result = await s.subagents()
            self.assertEqual([a["id"] for a in result["agents"]], ["child", "grandchild"])
            self.assertEqual([a["depth"] for a in result["agents"]], [1, 2])

        asyncio.run(captured())

    def test_set_name_and_compact_use_the_live_thread(self):
        async def main():
            s = _make_session(THREAD_ID)
            thread = FakeThread(THREAD_ID)
            s._thread = thread
            self.assertTrue(await s.set_session_name("visible name"))
            result = await s.compact()
            self.assertEqual(thread.names, ["visible name"])
            self.assertEqual(thread.compactions, 1)
            self.assertTrue(result["ok"])

        asyncio.run(main())

    def test_archive_and_unarchive_use_supported_sdk_methods(self):
        async def main():
            client = FakeClient()
            saved_codex, saved_config, saved_available = cs.AsyncCodex, cs.CodexConfig, cs.CODEX_AVAILABLE
            cs.AsyncCodex = lambda *_a, **_kw: client
            cs.CodexConfig = lambda **_kw: None
            cs.CODEX_AVAILABLE = True
            try:
                self.assertTrue((await cs.codex_set_thread_archived(THREAD_ID, True))["ok"])
                self.assertTrue((await cs.codex_set_thread_archived(THREAD_ID, False))["ok"])
            finally:
                cs.AsyncCodex, cs.CodexConfig, cs.CODEX_AVAILABLE = saved_codex, saved_config, saved_available
            self.assertEqual(client.archive_calls, [THREAD_ID])
            self.assertEqual(client.unarchive_calls, [THREAD_ID])

        asyncio.run(main())

    def test_force_stop_closes_the_app_server_before_clearing_client(self):
        async def main():
            s = _make_session(THREAD_ID)
            c = FakeClient()
            s._client = c
            s.status = "active"

            async def owner():
                try:
                    await asyncio.Event().wait()
                finally:
                    # Mirrors _run's finally: it can close only while the
                    # session still retains its client reference.
                    if s._client is not None:
                        await s._client.close()

            s._main_task = asyncio.create_task(owner())
            await asyncio.sleep(0)
            await s.force_stop()
            self.assertGreaterEqual(c.close_calls, 1)
            self.assertIsNone(s._client)
            self.assertEqual(s.status, "sleeping")

        asyncio.run(main())

    def test_active_server_turn_is_claimed_before_another_turn_starts(self):
        class Value:
            def __init__(self, value):
                self.value = value

        class ActiveStatus:
            type = "active"

        class Turn:
            id = "external-turn"
            status = Value("inProgress")

        class ThreadRecord:
            status = type("Status", (), {"root": ActiveStatus()})()
            turns = [Turn()]

        class ReadResponse:
            thread = ThreadRecord()

        class LiveThread(FakeThread):
            async def read(self, *, include_turns=False):
                self.include_turns = include_turns
                return ReadResponse()

        class Handle:
            def __init__(self, client, thread_id, turn_id):
                self.client = client
                self.thread_id = thread_id
                self.id = turn_id

            async def stream(self):
                if False:
                    yield None

        async def main():
            s = _make_session(THREAD_ID)
            s._thread = LiveThread(THREAD_ID)
            s._client = FakeClient()
            saved = cs.AsyncTurnHandle
            cs.AsyncTurnHandle = Handle
            try:
                attached = await s._attach_active_external_turn()
                self.assertTrue(attached)
                self.assertEqual(s._active_turn.id, "external-turn")
                self.assertTrue(s._thread.include_turns)
                task = s._external_turn_task
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            finally:
                cs.AsyncTurnHandle = saved

        asyncio.run(main())


if __name__ == "__main__":
    unittest.main()
