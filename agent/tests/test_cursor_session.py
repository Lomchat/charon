"""Cursor backend units that carry logic rather than plumbing (§14.103).

Deliberately SDK-free: `cursor-sdk` is not installed in CI (like `openai_codex`,
§14.74), so these cover the parts Charon owns — the mode ladder, the stored
credential, and the coercions that decide what a session emits.
"""
import json
import sys
import tempfile
import time
import types
import unittest
import pathlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from charon_agent import cursor_catalog, cursor_runtime, cursor_session
from charon_agent.cursor_catalog import _epoch
from charon_agent.cursor_session import (
    DEFAULT_MODE,
    MODES,
    CursorSession,
    _assistant_text,
    _error_text,
    _is_auth_error,
    _turn_error_kind,
)
from charon_agent.providers import PROVIDERS as AGENT_PROVIDERS
from charon_agent import cursor_login


class ModeLadderTest(unittest.TestCase):
    def test_every_mode_maps_to_a_real_sdk_mode(self):
        # The SDK knows only agent|plan; the other rungs are a sandbox flag and
        # a per-send force. A rung mapping to anything else would be silently
        # rejected by the SDK at turn time.
        for name, spec in MODES.items():
            self.assertIn(spec["sdk_mode"], ("agent", "plan"), name)
            for key in ("sandbox", "force", "auto_review"):
                self.assertIsInstance(spec[key], bool, f"{name}.{key}")

    def test_the_ladder_is_ordered_from_least_to_most_freedom(self):
        self.assertEqual(list(MODES), ["plan", "sandbox", "agent", "force"])
        self.assertEqual(MODES["plan"]["sdk_mode"], "plan")
        # Only the explicit top rung disables the classifier — every other mode
        # keeps Cursor's own review on, since Charon has no card to raise.
        self.assertTrue(MODES["force"]["force"])
        self.assertFalse(MODES["force"]["auto_review"])
        for name in ("plan", "sandbox", "agent"):
            self.assertTrue(MODES[name]["auto_review"], name)
            self.assertFalse(MODES[name]["force"], name)

    def test_an_unknown_mode_falls_back_to_the_safe_default(self):
        s = CursorSession(
            "s1", cwd="/tmp", name=None, permission_mode="totally-bogus",
            claude_session_id=None, emit=lambda _m: None, on_state_change=lambda: None,
        )
        self.assertEqual(s.permission_mode, DEFAULT_MODE)
        self.assertFalse(s._mode_spec()["force"])


class StoredCredentialTest(unittest.TestCase):
    def _with_auth(self, payload):
        tmp = tempfile.mkdtemp()
        path = Path(tmp) / "auth.json"
        if payload is not None:
            path.write_text(json.dumps(payload), "utf-8")
        original = cursor_runtime.auth_path
        cursor_runtime.auth_path = lambda: path  # type: ignore
        self.addCleanup(lambda: setattr(cursor_runtime, "auth_path", original))
        return path

    def test_reads_the_key_the_login_stored(self):
        self._with_auth({"version": 1, "apiKey": "key-123"})
        self.assertEqual(cursor_runtime.stored_api_key(), "key-123")

    def test_an_expired_key_reads_as_absent(self):
        # A lapsed key fails mid-turn and reads as a broken session; treating it
        # as "not signed in" turns it into a Sign-in button instead.
        self._with_auth({
            "apiKey": "old", "apiKeyExpiresAtMs": int((time.time() - 60) * 1000),
        })
        self.assertIsNone(cursor_runtime.stored_api_key())

    def test_a_future_expiry_is_still_usable(self):
        self._with_auth({
            "apiKey": "fresh", "apiKeyExpiresAtMs": int((time.time() + 3600) * 1000),
        })
        self.assertEqual(cursor_runtime.stored_api_key(), "fresh")

    def test_missing_or_corrupt_file_is_not_an_error(self):
        path = self._with_auth(None)
        self.assertIsNone(cursor_runtime.stored_api_key())
        path.write_text("{not json", "utf-8")
        self.assertIsNone(cursor_runtime.stored_api_key())
        path.write_text(json.dumps({"version": 1}), "utf-8")
        self.assertIsNone(cursor_runtime.stored_api_key())


class RuntimeLaunchTest(unittest.IsolatedAsyncioTestCase):
    async def test_bridge_launch_uses_the_cursor_state_root(self):
        launched = {}

        class _Client:
            async def aclose(self):
                return None

        class _AsyncClient:
            @staticmethod
            async def launch_bridge(**kwargs):
                launched.update(kwargs)
                return _Client()

        class _Sdk:
            AsyncClient = _AsyncClient

        original_sdk = cursor_session.require_sdk
        original_key = cursor_session.effective_api_key
        cursor_session.require_sdk = lambda: _Sdk  # type: ignore
        cursor_session.effective_api_key = lambda: None  # type: ignore
        self.addCleanup(setattr, cursor_session, "require_sdk", original_sdk)
        self.addCleanup(setattr, cursor_session, "effective_api_key", original_key)

        session = CursorSession(
            "s1", cwd="/work", name=None, permission_mode=DEFAULT_MODE,
            claude_session_id="agent-1", emit=lambda _m: None,
            on_state_change=lambda: None,
        )
        await session._run_loop()

        self.assertEqual(launched["workspace"], "/work")
        self.assertTrue(str(launched["state_root"]).endswith("/cursor-state"))


class AuthErrorTest(unittest.TestCase):
    def test_recognises_every_way_the_sdk_says_not_signed_in(self):
        # `missing_api_key` comes from the PYTHON client refusing before the
        # bridge; `unauthenticated` from the backend. Both mean "sign in", and
        # only the first shape was missed until a live run produced it.
        for msg in (
            "unauthenticated: API key is required for cloud catalog calls.",
            "missing_api_key: Agent.create requires api_key (set CURSOR_API_KEY...)",
            "API key is required for cloud operations.",
        ):
            self.assertTrue(_is_auth_error(RuntimeError(msg)), msg)

    def test_does_not_swallow_unrelated_failures(self):
        for msg in ("model 'x' is not available", "bridge exited with code 1"):
            self.assertFalse(_is_auth_error(RuntimeError(msg)), msg)

    def test_the_typed_class_is_enough(self):
        class AuthenticationError(Exception):
            pass
        self.assertTrue(_is_auth_error(AuthenticationError("no detail")))


class CoercionTest(unittest.TestCase):
    def test_assistant_text_handles_every_content_shape(self):
        self.assertEqual(_assistant_text("plain"), "plain")
        self.assertEqual(_assistant_text({"content": "flat"}), "flat")
        self.assertEqual(
            _assistant_text({"content": [{"type": "text", "text": "a"},
                                         {"type": "text", "text": "b"}]}),
            "ab",
        )
        self.assertEqual(_assistant_text(None), "")
        self.assertEqual(_assistant_text({"content": [{"type": "image"}]}), "")

    def test_json_safe_unwraps_an_enum_instead_of_emptying_it(self):
        # An Enum member's only attributes are `_name_` / `_value_`, which the
        # private-key filter drops — so every status and error CODE the SDK
        # types as an enum used to serialise as `{}`, taking the reason for a
        # failed turn with it.
        import enum

        class Status(enum.Enum):
            ERROR = "error"

        self.assertEqual(CursorSession._json_safe(Status.ERROR), "error")
        self.assertEqual(CursorSession._json_safe({"status": Status.ERROR}),
                         {"status": "error"})

    def test_json_safe_bounds_depth_and_coerces_paths(self):
        deep = {"a": {"b": {"c": {"d": {"e": {"f": {"g": "too far"}}}}}}}
        # Bounded rather than recursing forever: an unbounded walk on a cyclic
        # structure hangs the event loop instead of dropping one field.
        self.assertIn("…", json.dumps(CursorSession._json_safe(deep), ensure_ascii=False))
        self.assertEqual(CursorSession._json_safe(Path("/tmp/x")), "/tmp/x")
        self.assertEqual(CursorSession._json_safe({"n": 1, "b": True}), {"n": 1, "b": True})

    def test_epoch_accepts_iso_and_millis(self):
        self.assertEqual(_epoch(1700000000), 1700000000)
        self.assertEqual(_epoch(1700000000000), 1700000000)
        self.assertIsNotNone(_epoch("2026-01-02T03:04:05Z"))
        self.assertIsNone(_epoch(None))
        self.assertIsNone(_epoch("not a date"))


class _FakeParam:
    def __init__(self, id: str, value: str) -> None:
        self.id, self.value = id, value

    def __eq__(self, other: object) -> bool:
        return (self.id, self.value) == (other.id, other.value)

    def __repr__(self) -> str:
        return f"{self.id}={self.value}"


class _FakeSelection:
    def __init__(self, id: str, params: list) -> None:
        self.id, self.params = id, params


class _FakeSdk:
    ModelParameterValue = _FakeParam
    ModelSelection = _FakeSelection
    LocalSendOptions = staticmethod(lambda **kw: kw)


class ModelSelectionTest(unittest.TestCase):
    """Where the reasoning choice comes from — the model column, the effort
    column, or both.

    Cursor's reasoning knob is a per-model PARAMETER, so a selection is a pair:
    `model` holds the id, `effort` holds the parameter set. The first shipped
    encoding put both in the model column (`claude-opus-5?thinking=true`) and
    sessions created then still hold it, so BOTH must resolve — and the two must
    agree on precedence, or changing the effort of such a session would appear
    to do nothing.
    """

    def setUp(self):
        self._real = cursor_session.require_sdk
        cursor_session.require_sdk = lambda: _FakeSdk
        self.addCleanup(setattr, cursor_session, "require_sdk", self._real)

    def test_no_parameters_stays_a_bare_id(self):
        # A bare id lets the provider apply the model's OWN default variant;
        # sending an empty param list instead would override it with nothing.
        self.assertEqual(cursor_session.parse_model("claude-opus-5"), "claude-opus-5")
        self.assertEqual(cursor_session.parse_model("claude-opus-5", ""), "claude-opus-5")
        self.assertEqual(cursor_session.parse_model("claude-opus-5", None), "claude-opus-5")

    def test_an_empty_model_falls_back_to_the_verified_default(self):
        # `Agent.create` REQUIRES a model, so "none configured" still names one.
        self.assertEqual(cursor_session.parse_model(None), cursor_session.DEFAULT_MODEL)
        self.assertEqual(cursor_session.parse_model("  "), cursor_session.DEFAULT_MODEL)
        self.assertEqual(cursor_session.parse_model("?thinking=true").id,
                         cursor_session.DEFAULT_MODEL)

    def test_the_effort_column_carries_the_parameters(self):
        sel = cursor_session.parse_model("claude-opus-5", "effort=high&thinking=true")
        self.assertEqual(sel.id, "claude-opus-5")
        # Sorted, so a selection has one representation on the wire too.
        self.assertEqual(sel.params, [_FakeParam("effort", "high"), _FakeParam("thinking", "true")])

    def test_the_legacy_suffix_is_still_honoured(self):
        sel = cursor_session.parse_model("claude-opus-5?thinking=true")
        self.assertEqual(sel.id, "claude-opus-5")
        self.assertEqual(sel.params, [_FakeParam("thinking", "true")])

    def test_the_effort_column_wins_over_the_legacy_suffix(self):
        # Otherwise a session created before the split could never have its
        # reasoning changed: the stale suffix would keep overriding the picker.
        sel = cursor_session.parse_model("claude-opus-5?effort=low", "effort=max")
        self.assertEqual([p.value for p in sel.params if p.id == "effort"], ["max"])
        # A key only the suffix names survives — it is a real setting, not junk.
        sel = cursor_session.parse_model("claude-opus-5?thinking=true", "effort=max")
        self.assertEqual(sel.params,
                         [_FakeParam("effort", "max"), _FakeParam("thinking", "true")])

    def test_malformed_pairs_are_skipped_not_forwarded(self):
        sel = cursor_session.parse_model("claude-opus-5", "effort=high&&broken&=x")
        self.assertEqual(sel.params, [_FakeParam("effort", "high")])
        # Nothing usable left ⇒ a bare id, never a selection with no params.
        self.assertEqual(cursor_session.parse_model("claude-opus-5", "broken"), "claude-opus-5")

    def test_clearing_model_and_effort_sends_the_default_selection(self):
        self.assertEqual(_session(model=None, effort=None)._send_options()["model"],
                         cursor_session.DEFAULT_MODEL)


if __name__ == "__main__":
    unittest.main()


def _session(**kwargs):
    """A CursorSession with no SDK behind it — enough for the pure logic."""
    defaults = dict(
        cwd="/tmp", name=None, permission_mode=DEFAULT_MODE,
        claude_session_id=None, emit=lambda _m: None, on_state_change=lambda: None,
    )
    defaults.update(kwargs)
    return CursorSession("sid", **defaults)


class PersistenceKeyTest(unittest.TestCase):
    """Persistence uses the provider-config key read by the boot loader."""

    def test_the_config_lands_under_the_key_the_loader_reads(self):
        s = _session(session_config={"autoReview": False})
        row = s.to_persist()
        self.assertEqual(row["provider_config"], {"autoReview": False})
        self.assertNotIn("session_config", row)

    def test_an_empty_config_persists_as_null_not_an_empty_dict(self):
        self.assertIsNone(_session().to_persist()["provider_config"])


class TurnErrorTest(unittest.TestCase):
    """Turn errors carry the typed `kind` used for auth recovery."""

    def test_an_auth_failure_is_named_so_the_hub_can_see_it(self):
        for text in ("Unauthenticated", "missing_api_key", "the API key is required"):
            self.assertEqual(_turn_error_kind(text), "authentication_failed", text)

    def test_an_ordinary_failure_is_not_an_auth_failure(self):
        self.assertEqual(_turn_error_kind("model overloaded"), "turn_failed")

    def test_error_text_survives_every_shape_the_run_reports(self):
        self.assertEqual(_error_text("boom"), "boom")
        self.assertEqual(_error_text({"message": "boom"}), "boom")
        self.assertEqual(_error_text({"code": 7}), '{"code": 7}')
        self.assertEqual(_error_text(None), "the run failed")

    def test_run_result_text_drives_auth_recovery(self):
        events = []
        s = _session(emit=events.append)
        s._on_result(types.SimpleNamespace(
            status="error", result="Unauthenticated: API key expired", model=None,
        ))
        self.assertIn(
            {"event": "error", "session_id": "sid",
             "msg": "Unauthenticated: API key expired", "fatal": False},
            events,
        )
        self.assertIn(
            {"event": "turn_error", "session_id": "sid",
             "kind": "authentication_failed"},
            events,
        )


class ConstructionSignatureTest(unittest.TestCase):
    """Construction changes rebuild before the next turn."""

    def test_crossing_the_sandbox_boundary_changes_the_signature(self):
        s = _session(permission_mode="agent")
        before = s._construction_signature()
        s.permission_mode = "sandbox"
        self.assertNotEqual(before, s._construction_signature())

    def test_a_model_change_does_not(self):
        s = _session(permission_mode="agent")
        before = s._construction_signature()
        s.model = "composer-2.5"
        s.effort = "effort=high"
        self.assertEqual(before, s._construction_signature())

    def test_force_to_agent_reenables_the_mode_derived_reviewer(self):
        s = _session(permission_mode="force")
        before = s._construction_signature()
        s.permission_mode = "agent"
        self.assertNotEqual(before, s._construction_signature())

    def test_an_explicit_reviewer_override_stays_independent_of_the_mode(self):
        s = _session(permission_mode="force", session_config={"autoReview": False})
        before = s._construction_signature()
        s.permission_mode = "agent"
        self.assertEqual(before, s._construction_signature())

    def test_the_session_config_is_part_of_it(self):
        s = _session(session_config={"autoReview": True})
        before = s._construction_signature()
        s.session_config = {"autoReview": False}
        self.assertNotEqual(before, s._construction_signature())


class AgentRebuildTest(unittest.IsolatedAsyncioTestCase):
    """A rebuild resumes the same id and leaves the replacement open."""

    def setUp(self):
        self.resumes = []
        outer = self

        class _Agent:
            def __init__(self, tag):
                self.tag = tag
                self.closed = False

            async def close(self):
                self.closed = True

        class _AsyncAgent:
            @staticmethod
            async def resume(agent_id, options, *, client=None):
                outer.resumes.append(agent_id)
                return _Agent(f"fresh-{len(outer.resumes)}")

        class _Sdk:
            AsyncAgent = _AsyncAgent
            LocalAgentOptions = staticmethod(lambda **kw: kw)
            LocalAgentStoreConfig = staticmethod(lambda **kw: kw)
            SandboxOptions = staticmethod(lambda **kw: kw)
            AgentOptions = staticmethod(lambda **kw: kw)
            StdioMcpServerConfig = staticmethod(lambda **kw: kw)
            ModelSelection = _FakeSelection
            ModelParameterValue = _FakeParam

        self._agent_cls = _Agent
        # Restored on teardown: a leaked monkeypatch would silently hand the
        # fake SDK to every later test in this process.
        original = cursor_session.require_sdk
        cursor_session.require_sdk = lambda: _Sdk  # type: ignore
        self.addCleanup(
            lambda: setattr(cursor_session, "require_sdk", original))

    async def test_a_mode_change_re_resumes_and_never_closes(self):
        s = _session(permission_mode="agent", claude_session_id="agent-123")
        s._client = object()
        s._agent = self._agent_cls("original")
        s._agent_signature = s._construction_signature()
        original = s._agent

        s.permission_mode = "sandbox"
        await s._rebuild_agent_if_stale()

        # Re-attached to the SAME conversation, exactly once.
        self.assertEqual(self.resumes, ["agent-123"])
        self.assertIsNot(s._agent, original)
        # ⚠ THE invariant: closing the old handle would dispose the new agent,
        # because the bridge resolves both by the same id.
        self.assertFalse(original.closed)
        self.assertFalse(s._agent.closed)

    async def test_an_unchanged_signature_does_not_touch_the_agent(self):
        s = _session(permission_mode="agent", claude_session_id="agent-123")
        s._client = object()
        s._agent = self._agent_cls("original")
        s._agent_signature = s._construction_signature()

        s.model = "composer-2.5"          # per-send, not construction
        await s._rebuild_agent_if_stale()

        self.assertEqual(self.resumes, [])
        self.assertEqual(s._agent.tag, "original")

    async def test_no_agent_id_yet_is_a_no_op_not_a_crash(self):
        s = _session(permission_mode="agent", claude_session_id=None)
        s._client = object()
        s._agent = self._agent_cls("original")
        s._agent_signature = "stale"
        await s._rebuild_agent_if_stale()
        self.assertEqual(self.resumes, [])


class CatalogStoreTest(unittest.IsolatedAsyncioTestCase):
    """The import list, the transcript read and archive must all land in the
    SAME store as the session — and the only lever is the CWD.

    ⚠ The previous version of this test faked `AgentOptions.to_json()` so the
    `local.store` it sent survived into the assertion. On the wire it does not:
    `ListAgentsOptions` and `AgentOperationOptions` carry `cwd` + `api_key` and
    nothing else, so proto3 drops the unknown field and the call reads the SDK's
    OWN per-workspace store. The mock proved a wiring that did not exist — an
    empty import tab and "Agent not found" on archive, both green in CI. So this
    asserts the payloads carry ONLY what those messages can hold, and
    `test_the_wire_messages_really_have_no_store_field` checks that claim
    against the installed proto whenever the SDK is present.
    """

    def setUp(self):
        self.calls = []
        calls = self.calls

        class _Options:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

        class _Agent:
            async def list_messages(self, options):
                calls.append(("messages", options))
                return []

            async def close(self):
                return None

        class _AsyncAgent:
            @staticmethod
            async def list(options, *, client=None):
                calls.append(("list", options))
                return types.SimpleNamespace(items=[])

            @staticmethod
            async def resume(agent_id, options, *, client=None):
                calls.append(("resume", agent_id, options))
                return _Agent()

            @staticmethod
            async def archive(agent_id, options, *, client=None):
                calls.append(("archive", agent_id, options))

            @staticmethod
            async def unarchive(agent_id, options, *, client=None):
                calls.append(("unarchive", agent_id, options))

        class _Sdk:
            AsyncAgent = _AsyncAgent
            AgentOptions = _Options
            LocalAgentOptions = staticmethod(lambda **kw: kw)

        class _Bridge:
            def __init__(self, workspace):
                self.workspace = workspace

            async def __aenter__(self):
                calls.append(("bridge", self.workspace))
                return object()

            async def __aexit__(self, *_exc):
                return None

        saved = {
            "available": cursor_catalog.CURSOR_AVAILABLE,
            "require_sdk": cursor_catalog.require_sdk,
            "bridge": cursor_catalog._Bridge,
            "key": cursor_catalog.effective_api_key,
        }
        cursor_catalog.CURSOR_AVAILABLE = True
        cursor_catalog.require_sdk = lambda: _Sdk
        cursor_catalog._Bridge = _Bridge
        cursor_catalog.effective_api_key = lambda: "key"
        self.addCleanup(setattr, cursor_catalog, "CURSOR_AVAILABLE", saved["available"])
        self.addCleanup(setattr, cursor_catalog, "require_sdk", saved["require_sdk"])
        self.addCleanup(setattr, cursor_catalog, "_Bridge", saved["bridge"])
        self.addCleanup(setattr, cursor_catalog, "effective_api_key", saved["key"])

    async def test_every_call_scopes_to_the_same_workspace(self):
        listed = await cursor_catalog.list_agents({"limit": 10, "cwd": "/work"})
        messages = await cursor_catalog.agent_messages({"agent_id": "a1", "cwd": "/work"})
        archived = await cursor_catalog.set_archived({"agent_id": "a1", "cwd": "/work"}, True)
        self.assertTrue(listed["ok"] and messages["ok"] and archived["ok"])

        # Every bridge is opened on the session's workspace: that IS the store.
        self.assertEqual([c[1] for c in self.calls if c[0] == "bridge"],
                         ["/work", "/work", "/work"])

        list_options = next(c[1] for c in self.calls if c[0] == "list")
        archive_options = next(c[2] for c in self.calls if c[0] == "archive")
        resume_options = next(c[2] for c in self.calls if c[0] == "resume")
        message_options = next(c[1] for c in self.calls if c[0] == "messages")

        # ONLY the fields these two proto messages actually carry.
        self.assertEqual(set(list_options), {"cwd", "apiKey", "limit", "includeArchived"})
        self.assertEqual(set(archive_options), {"cwd", "apiKey"})
        self.assertEqual(list_options["cwd"], "/work")
        self.assertEqual(archive_options["cwd"], "/work")
        # Resume takes a real AgentOptions — cwd, still no store override.
        self.assertEqual(resume_options.kwargs["local"], {"cwd": "/work"})
        self.assertNotIn("store", resume_options.kwargs["local"])
        # The instance method is a static ListAgentMessages RPC underneath;
        # scope it explicitly instead of relying on the bridge launch cwd.
        self.assertEqual(message_options, {"limit": 2000, "cwd": "/work"})

    async def test_a_call_without_a_cwd_still_picks_one_workspace(self):
        await cursor_catalog.list_agents({"limit": 5})
        opts = next(c[1] for c in self.calls if c[0] == "list")
        # Never absent/None: the SDK would resolve a DIFFERENT workspace store.
        self.assertTrue(opts["cwd"])

    def test_the_wire_messages_really_have_no_store_field(self):
        # The claim the mock above cannot make. Skipped where the SDK is not
        # installed (CI), which is precisely why the mock must stay honest.
        try:
            from cursor_sdk._vendor import resolve_bridge_path  # type: ignore
        except Exception:
            self.skipTest("cursor-sdk not installed")
        proto = (Path(resolve_bridge_path()).parent.parent / "node_modules"
                 / "@anysphere" / "proto" / "dist" / "generated" / "sdk" / "v1"
                 / "sdk_agent_service_pb.d.ts")
        if not proto.is_file():
            self.skipTest("bundled proto not found")
        src = proto.read_text("utf-8")
        import re as _re
        for cls in ("ListAgentsOptions", "AgentOperationOptions"):
            block = _re.search(r"export declare class %s extends[\s\S]*?\n\}" % cls, src)
            self.assertIsNotNone(block, cls)
            fields = _re.findall(r"@generated from field: [^\n]*?(\w+) = \d+;", block.group(0))
            self.assertNotIn("store", fields, f"{cls} gained a store field — revisit §14.103")
            self.assertIn("cwd", fields, cls)


class ToolListPlacementTest(unittest.TestCase):
    """`tools`/`disallowed_tools` are `AgentOptions` fields.

    `LocalAgentOptions` is a frozen dataclass that has neither, so putting them
    there is a TypeError at construction — a session that cannot start at all
    the moment anyone configures a tool list.
    """

    def test_tool_lists_are_not_local_agent_options(self):
        s = _session(session_config={"tools": ["read"], "disallowedTools": ["shell"]})
        self.assertEqual(s._tool_lists(), {"tools": ["read"], "disallowed_tools": ["shell"]})

    def test_no_lists_configured_sends_nothing(self):
        self.assertEqual(_session()._tool_lists(), {})


class ProviderPolicyTest(unittest.TestCase):
    """Rewind and compaction are DECLARED, never inferred from the kind.

    The dispatch used to be `kind == "codex"` with a Claude FALLTHROUGH, so a
    backend with neither ran Claude's transcript fork — which clears
    `claude_session_id`, i.e. the only resume handle a non-Claude session has.
    """

    def test_cursor_declares_neither(self):
        spec = AGENT_PROVIDERS["cursor"]
        self.assertIsNone(spec.rewind)
        self.assertIsNone(spec.compact)

    def test_the_originals_keep_their_mechanism(self):
        self.assertEqual(AGENT_PROVIDERS["claude"].rewind, "claude_fork")
        self.assertEqual(AGENT_PROVIDERS["claude"].compact, "slash_command")
        self.assertEqual(AGENT_PROVIDERS["codex"].rewind, "native")
        self.assertEqual(AGENT_PROVIDERS["codex"].compact, "native")

    def test_every_declared_provider_answers_both(self):
        # A new backend must STATE what it can do; inheriting someone else's
        # mechanism by omission is the bug this table replaces.
        for kind, spec in AGENT_PROVIDERS.items():
            self.assertIn(spec.rewind, (None, "native", "claude_fork"), kind)
            self.assertIn(spec.compact, (None, "native", "slash_command"), kind)


class WorkspaceStoreTest(unittest.TestCase):
    """The CWD selects the agent store; nothing may override it.

    Only `CreateAgent`/`ResumeAgent` carry an `AgentOptions` on the wire.
    `ListAgentsOptions` and `AgentOperationOptions` have `cwd` + `api_key` and
    NOTHING else — no store — so a session pointed at a private store wrote
    conversations the import list and archive could never see.
    """

    def test_sessions_never_override_the_store(self):
        class _Sdk:
            SandboxOptions = staticmethod(lambda **kw: kw)
            LocalAgentStoreConfig = staticmethod(lambda **kw: kw)
        original = cursor_session.require_sdk
        cursor_session.require_sdk = lambda: _Sdk          # type: ignore
        self.addCleanup(lambda: setattr(cursor_session, "require_sdk", original))
        opts = _session(cwd="/srv/app", session_config={"autoReview": True})._local_options()
        self.assertNotIn("store", opts)
        self.assertEqual(opts["cwd"], "/srv/app")

    def test_scoped_options_carry_only_what_the_proto_has(self):
        opts = cursor_catalog._scoped_options("/srv/app")
        self.assertEqual(set(opts), {"cwd", "apiKey"})
        self.assertEqual(opts["cwd"], "/srv/app")

    def test_a_missing_cwd_still_resolves_to_one_workspace(self):
        # Never None: the SDK would fall back to a DIFFERENT workspace store
        # than the one the session used, and the list would come back empty.
        self.assertTrue(cursor_runtime.workspace_ref(None))
        self.assertEqual(cursor_runtime.workspace_ref("/srv/app"), "/srv/app")
        self.assertEqual(cursor_runtime.workspace_ref(""), cursor_runtime.workspace_ref(None))


class AuthStatusCredentialTest(unittest.IsolatedAsyncioTestCase):
    """The probe must judge the SAME credential a session runs under.

    Sessions accept `CURSOR_API_KEY` (`effective_api_key`), so checking only the
    stored file marked a working box signed-out and turned its launchers into a
    sign-in button.
    """

    def _creds(self, stored, env):
        cursor_login.stored_api_key = lambda: stored          # type: ignore
        cursor_login.effective_api_key = lambda: stored or env  # type: ignore
        self.addCleanup(lambda: (
            setattr(cursor_login, "stored_api_key", cursor_runtime.stored_api_key),
            setattr(cursor_login, "effective_api_key", cursor_runtime.effective_api_key),
        ))

    async def test_an_env_only_key_reads_as_signed_in(self):
        self._creds(stored=None, env="env-key")
        r = await cursor_login.auth_status()
        self.assertTrue(r["logged_in"])
        self.assertEqual(r.get("source"), "env")

    async def test_no_credential_at_all_is_signed_out(self):
        self._creds(stored=None, env=None)
        r = await cursor_login.auth_status()
        self.assertFalse(r["logged_in"])

    async def test_a_stored_key_still_goes_to_the_authoritative_probe(self):
        # The file's existence is NOT the verdict — the key must be unexpired
        # and minted for this backend, which only the SDK can say (§14.104).
        self._creds(stored="stored-key", env=None)
        calls = []

        async def fake_helper(body, timeout=None):
            calls.append(body)
            return [{"type": "status", "status": "logged-in", "email": "a@b.c"}]

        original = cursor_login.run_node_helper
        cursor_login.run_node_helper = fake_helper   # type: ignore
        self.addCleanup(lambda: setattr(cursor_login, "run_node_helper", original))
        r = await cursor_login.auth_status()
        self.assertTrue(r["logged_in"])
        self.assertEqual(len(calls), 1)


class LegacyStoreTest(unittest.IsolatedAsyncioTestCase):
    """Agents created before the store rule must still resume.

    The old private store is JSONL, the SDK's default is a private SQLite
    schema — not convertible — so they are READ where they are, and only for
    ids the legacy index actually lists.
    """

    def _legacy(self, rows):
        import tempfile, json as _json
        root = pathlib.Path(tempfile.mkdtemp())
        (root / "agents.ndjson").write_text(
            "\n".join(_json.dumps(r) for r in rows), "utf-8")
        original = cursor_runtime.legacy_store_root
        cursor_runtime.legacy_store_root = lambda: root      # type: ignore
        self.addCleanup(lambda: setattr(cursor_runtime, "legacy_store_root", original))
        return root

    def test_only_a_listed_id_gets_the_override(self):
        self._legacy([{"agentId": "agent-old", "cwd": "/var/www/html", "name": "T"}])

        class _Sdk:
            SandboxOptions = staticmethod(lambda **kw: kw)
            LocalAgentStoreConfig = staticmethod(lambda **kw: kw)
        original = cursor_session.require_sdk
        cursor_session.require_sdk = lambda: _Sdk            # type: ignore
        self.addCleanup(lambda: setattr(cursor_session, "require_sdk", original))

        old = _session(cwd="/var/www/html", claude_session_id="agent-old")._local_options()
        self.assertEqual(old["store"]["type"], "jsonl")
        # A NEW agent must never inherit it — that would re-create the very bug
        # the override exists to survive (invisible to list/archive).
        new = _session(cwd="/var/www/html", claude_session_id="agent-new")._local_options()
        self.assertNotIn("store", new)
        # And a session with no agent id yet is always new.
        self.assertNotIn("store", _session(cwd="/var/www/html")._local_options())

    def test_no_legacy_store_at_all_is_not_an_error(self):
        import tempfile
        missing = pathlib.Path(tempfile.mkdtemp()) / "gone"
        original = cursor_runtime.legacy_store_root
        cursor_runtime.legacy_store_root = lambda: missing   # type: ignore
        self.addCleanup(lambda: setattr(cursor_runtime, "legacy_store_root", original))
        self.assertEqual(cursor_runtime.legacy_store_agent_ids(), set())
        self.assertEqual(cursor_runtime.legacy_store_rows(), [])

    def test_a_corrupt_index_is_skipped_line_by_line(self):
        self._legacy([{"agentId": "a1"}])
        root = cursor_runtime.legacy_store_root()
        (root / "agents.ndjson").write_text(
            '{"agentId":"a1"}\nnot json\n{"agentId":"a2"}\n', "utf-8")
        self.assertEqual(cursor_runtime.legacy_store_agent_ids(), {"a1", "a2"})

    def test_an_append_only_index_keeps_the_last_row_per_id(self):
        self._legacy([
            {"agentId": "a1", "name": "first"},
            {"agentId": "a1", "name": "renamed"},
        ])
        rows = cursor_runtime.legacy_store_rows()
        self.assertEqual([r["name"] for r in rows], ["renamed"])


class ScanWorkspacesTest(unittest.TestCase):
    """A scan must look in every workspace, not just home.

    One workspace = one store, so a cwd-less scan reports "nothing to import"
    on a box whose conversations all live under project directories.
    """

    def test_the_callers_order_is_kept_and_deduped(self):
        # The hub orders by recency; re-sorting here would throw that away.
        page, rest = cursor_catalog._workspace_page(
            {"cwds": ["/var/www/html", "/srv/app", "/var/www/html"]})
        self.assertEqual(page, ["/var/www/html", "/srv/app"])
        self.assertEqual(rest, [])

    def test_an_explicit_folder_is_the_whole_scan(self):
        page, rest = cursor_catalog._workspace_page({"cwd": "/srv/app", "cwds": ["/other"]})
        self.assertEqual((page, rest), (["/srv/app"], []))

    def test_no_cwd_falls_back_to_one_workspace_never_none(self):
        page, _ = cursor_catalog._workspace_page({})
        self.assertEqual(len(page), 1)
        self.assertTrue(page[0])

    def test_a_dead_workspace_does_not_lose_the_others(self):
        # A stale known path is normal; scanning must not go empty because of it.
        import asyncio as _a

        class _AsyncAgent:
            @staticmethod
            async def list(options, *, client=None):
                if options["cwd"] == "/gone":
                    raise RuntimeError("ENOENT")
                return types.SimpleNamespace(items=[types.SimpleNamespace(
                    agent_id="a-" + options["cwd"].strip("/").replace("/", "-"),
                    cwd=options["cwd"], name="n", summary="", archived=False,
                    status="idle", runtime="local", last_modified=1, created_at=1)])

        class _Sdk:
            AsyncAgent = _AsyncAgent

        class _Bridge:
            def __init__(self, workspace): self.workspace = workspace
            async def __aenter__(self): return object()
            async def __aexit__(self, *_e): return None

        saved = (cursor_catalog.CURSOR_AVAILABLE, cursor_catalog.require_sdk,
                 cursor_catalog._Bridge, cursor_catalog.effective_api_key,
                 cursor_catalog.legacy_store_rows)
        cursor_catalog.CURSOR_AVAILABLE = True
        cursor_catalog.require_sdk = lambda: _Sdk
        cursor_catalog._Bridge = _Bridge
        cursor_catalog.effective_api_key = lambda: "k"
        cursor_catalog.legacy_store_rows = lambda: []
        try:
            r = _a.run(cursor_catalog.list_agents(
                {"cwds": ["/gone", "/var/www/html", "/srv/app"]}))
        finally:
            (cursor_catalog.CURSOR_AVAILABLE, cursor_catalog.require_sdk,
             cursor_catalog._Bridge, cursor_catalog.effective_api_key,
             cursor_catalog.legacy_store_rows) = saved
        self.assertTrue(r["ok"])
        self.assertEqual(r["scanned"], ["/var/www/html", "/srv/app"])
        # Merged across workspaces — the whole point of the fan-out.
        self.assertEqual({a["cwd"] for a in r["agents"]}, {"/var/www/html", "/srv/app"})

    def test_the_bound_is_a_PAGE_and_the_rest_is_reported(self):
        # Silently dropping the tail made conversations permanently unfindable.
        page, rest = cursor_catalog._workspace_page({"cwds": [f"/p{i}" for i in range(50)]})
        self.assertEqual(len(page), cursor_catalog._MAX_SCAN_WORKSPACES)
        self.assertEqual(len(page) + len(rest), 50)
        self.assertEqual(rest[0], f"/p{cursor_catalog._MAX_SCAN_WORKSPACES}")

    def test_every_sdk_page_in_one_workspace_is_consumed(self):
        import asyncio as _a

        calls = []

        class _Page:
            def __init__(self, start, client):
                stop = min(start + 100, 101)
                self.items = [types.SimpleNamespace(
                    agent_id=f"a-{i}", cwd="/srv/app", name=f"n-{i}",
                    summary="", archived=False, status="idle", runtime="local",
                    last_modified=i, created_at=i,
                ) for i in range(start, stop)]
                self.next_cursor = str(stop) if stop < 101 else ""
                self._client = client

            async def get_next_page(self):
                calls.append((self.next_cursor, self._client))
                return _Page(int(self.next_cursor), self._client)

        class _AsyncAgent:
            @staticmethod
            async def list(options, *, client=None):
                calls.append((options, client))
                return _Page(0, client)

        class _Sdk:
            AsyncAgent = _AsyncAgent

        bridge_client = object()

        class _Bridge:
            def __init__(self, workspace): self.workspace = workspace
            async def __aenter__(self): return bridge_client
            async def __aexit__(self, *_e): return None

        saved = (cursor_catalog.CURSOR_AVAILABLE, cursor_catalog.require_sdk,
                 cursor_catalog._Bridge, cursor_catalog.effective_api_key,
                 cursor_catalog.legacy_store_rows)
        cursor_catalog.CURSOR_AVAILABLE = True
        cursor_catalog.require_sdk = lambda: _Sdk
        cursor_catalog._Bridge = _Bridge
        cursor_catalog.effective_api_key = lambda: "k"
        cursor_catalog.legacy_store_rows = lambda: []
        try:
            r = _a.run(cursor_catalog.list_agents({"cwds": ["/srv/app"]}))
        finally:
            (cursor_catalog.CURSOR_AVAILABLE, cursor_catalog.require_sdk,
             cursor_catalog._Bridge, cursor_catalog.effective_api_key,
             cursor_catalog.legacy_store_rows) = saved

        self.assertTrue(r["ok"])
        self.assertEqual(len(r["agents"]), 101)
        self.assertEqual({client for _, client in calls}, {bridge_client})
        self.assertEqual(calls[1][0], "100")


class MessageDecoderTest(unittest.TestCase):
    """The import reads TURNS, not just `{role, content}` pairs.

    Shapes below are the ones this account's store really produced (checkpoint
    blobs and run records), which is what the old decoder silently returned
    nothing for.
    """

    def rows(self, m):
        return cursor_catalog._message_rows(m)

    def test_the_bridge_agent_message_shape_yields_both_sides(self):
        # Exact ListAgentMessages shape observed through the real bridge. The
        # outer type is "user" but has no content; treating it as a normal
        # role/content message used to return [] before reaching the turn.
        message = {
            "type": "user",
            "message": {"turn": {"value": {
                "userMessage": {"text": "Bonjour"},
                "steps": [
                    {"message": {"case": "thinkingMessage",
                                 "value": {"text": "private reasoning"}}},
                    {"message": {"case": "toolCall",
                                 "value": {"name": "Read"}}},
                    {"message": {"case": "assistantMessage",
                                 "value": {"text": "Bonjour !"}}},
                ],
            }}},
        }
        self.assertEqual(self.rows(message),
                         [("user", "Bonjour"), ("assistant", "Bonjour !")])

    def test_the_bridge_object_shape_is_decoded_too(self):
        turn = types.SimpleNamespace(
            userMessage=types.SimpleNamespace(text="Object prompt"),
            steps=[types.SimpleNamespace(
                message=types.SimpleNamespace(
                    case="assistantMessage",
                    value=types.SimpleNamespace(text="Object answer")))],
        )
        message = types.SimpleNamespace(
            type="user",
            message=types.SimpleNamespace(
                turn=types.SimpleNamespace(value=turn)),
        )
        self.assertEqual(self.rows(message), [
            ("user", "Object prompt"), ("assistant", "Object answer"),
        ])

    def test_non_assistant_oneof_steps_are_not_imported(self):
        message = {"type": "user", "message": {"turn": {"value": {
            "userMessage": {"text": "Prompt"},
            "steps": [
                {"message": {"case": "thinkingMessage",
                             "value": {"text": "hidden"}}},
                {"message": {"case": "toolCall",
                             "value": {"text": "tool output"}}},
            ],
        }}}}
        self.assertEqual(self.rows(message), [("user", "Prompt")])

    def test_a_turn_yields_the_user_prompt_AND_the_answer(self):
        turn = {"turnNumber": 1,
                "userMessage": {"role": "user", "content": [
                    {"type": "text", "text": "<timestamp>Sep 10</timestamp>\n"
                                             "<user_query>\nSalut\n</user_query>"}]},
                "result": "Salut ! Comment puis-je t\u2019aider ?"}
        self.assertEqual(self.rows(turn),
                         [("user", "Salut"), ("assistant", "Salut ! Comment puis-je t\u2019aider ?")])

    def test_a_plain_role_content_pair_still_works(self):
        m = {"message": {"role": "assistant", "content": [
            {"type": "reasoning", "text": "", "signature": "AAAA"},
            {"type": "text", "text": "Re salut !"}]}}
        # ⚠ the reasoning block carries an empty text and a huge signature.
        self.assertEqual(self.rows(m), [("assistant", "Re salut !")])

    def test_the_context_envelope_is_not_the_users_words(self):
        m = {"role": "user", "content": "<user_info>\nOS Version: linux\n</user_info>\n"
                                        "<git_status>\n## main\n</git_status>"}
        # Pure envelope ⇒ nothing to import, not a page of git status.
        self.assertEqual(self.rows(m), [])

    def test_the_query_is_extracted_from_the_envelope(self):
        m = {"role": "user", "content": [
            {"type": "text", "text": "<system_reminder>ignore me</system_reminder>"},
            {"type": "text", "text": "<timestamp>x</timestamp>\n<user_query>\nSalut encore\n</user_query>"}]}
        self.assertEqual(self.rows(m), [("user", "Salut encore")])

    def test_responses_are_walked_when_present(self):
        turn = {"userMessage": {"content": "<user_query>hi</user_query>"},
                "responses": [{"role": "assistant", "content": [{"type": "text", "text": "yo"}]}]}
        self.assertEqual(self.rows(turn), [("user", "hi"), ("assistant", "yo")])

    def test_result_is_not_duplicated_when_responses_already_spoke(self):
        turn = {"userMessage": {"content": "<user_query>hi</user_query>",},
                "responses": [{"role": "assistant", "content": "yo"}],
                "result": "yo"}
        self.assertEqual([r for r, _ in self.rows(turn)], ["user", "assistant"])

    def test_an_unknown_shape_is_dropped_not_crashed(self):
        self.assertEqual(self.rows({"type": "tool_call", "name": "Read"}), [])
        self.assertEqual(self.rows({}), [])
        self.assertEqual(self.rows(None), [])


class LegacyHistoryTest(unittest.IsolatedAsyncioTestCase):
    async def test_catalog_reads_legacy_history_without_the_default_store_rpc(self):
        calls = []

        async def read_legacy(agent_id, cwd, limit):
            calls.append((agent_id, cwd, limit))
            return [{
                "type": "user",
                "message": {"turn": {"value": {
                    "userMessage": {"text": "Old prompt"},
                    # getFullConversation's protobuf JSON shape, as opposed to
                    # ListAgentMessages' message.case/value representation.
                    "steps": [{"assistantMessage": {"text": "Old answer"}}],
                }}},
            }]

        class RefuseBridge:
            def __init__(self, *_args, **_kwargs):
                raise AssertionError("legacy history must not use ListAgentMessages")

        saved = (
            cursor_catalog.CURSOR_AVAILABLE,
            cursor_catalog.require_sdk,
            cursor_catalog.legacy_store_agent_ids,
            cursor_catalog.legacy_store_messages,
            cursor_catalog._Bridge,
        )
        cursor_catalog.CURSOR_AVAILABLE = True
        cursor_catalog.require_sdk = lambda: object()
        cursor_catalog.legacy_store_agent_ids = lambda: {"agent-old"}
        cursor_catalog.legacy_store_messages = read_legacy
        cursor_catalog._Bridge = RefuseBridge
        try:
            result = await cursor_catalog.agent_messages({
                "agent_id": "agent-old", "cwd": "/legacy", "limit": 50,
            })
        finally:
            (
                cursor_catalog.CURSOR_AVAILABLE,
                cursor_catalog.require_sdk,
                cursor_catalog.legacy_store_agent_ids,
                cursor_catalog.legacy_store_messages,
                cursor_catalog._Bridge,
            ) = saved

        self.assertEqual(calls, [("agent-old", "/legacy", 50)])
        self.assertEqual(result, {"ok": True, "messages": [
            {"role": "user", "content": "Old prompt"},
            {"role": "assistant", "content": "Old answer"},
        ]})

    async def test_runtime_helper_uses_the_public_sdk_with_the_legacy_store(self):
        calls = []

        async def helper(body, *, timeout=30.0, env=None):
            calls.append((body, env))
            return [{"type": "messages", "messages": [{"type": "user"}]}]

        saved = (
            cursor_runtime.run_node_helper,
            cursor_runtime.legacy_store_agent_ids,
            cursor_runtime.legacy_store_root,
        )
        cursor_runtime.run_node_helper = helper
        cursor_runtime.legacy_store_agent_ids = lambda: {"agent-old"}
        cursor_runtime.legacy_store_root = lambda: Path("/legacy/store")
        try:
            messages = await cursor_runtime.legacy_store_messages(
                "agent-old", "/workspace", 123,
            )
        finally:
            (
                cursor_runtime.run_node_helper,
                cursor_runtime.legacy_store_agent_ids,
                cursor_runtime.legacy_store_root,
            ) = saved

        self.assertEqual(messages, [{"type": "user"}])
        body, env = calls[0]
        self.assertIn("sdk.Agent.resume", body)
        self.assertIn("local: { cwd, store }", body)
        self.assertIn("checkpointStore.getFullConversation", body)
        self.assertIn("sdk.JsonlLocalAgentStore", body)
        self.assertEqual(env, {
            "CHARON_CURSOR_LEGACY_AGENT_ID": "agent-old",
            "CHARON_CURSOR_LEGACY_CWD": "/workspace",
            "CHARON_CURSOR_LEGACY_STORE": "/legacy/store",
            "CHARON_CURSOR_LEGACY_LIMIT": "123",
        })


class LegacyArchiveTest(unittest.IsolatedAsyncioTestCase):
    """Archiving a pre-0.95.3 agent cannot be mirrored, and must not fail.

    `ArchiveAgent` carries `cwd` + `api_key` and no store on ANY path — the
    bridge calls `Agent.archive` directly rather than resolving through its
    registry — so the old private store is unreachable. Charon's own column
    carries the state instead (the `adapted` behaviour Claude always had);
    erroring would refuse a legitimate action.
    """

    async def test_a_legacy_agent_archives_locally_without_an_rpc(self):
        called = []
        saved = (cursor_catalog.CURSOR_AVAILABLE, cursor_catalog.legacy_store_agent_ids,
                 cursor_catalog.require_sdk)
        cursor_catalog.CURSOR_AVAILABLE = True
        cursor_catalog.legacy_store_agent_ids = lambda: {"agent-old"}
        cursor_catalog.require_sdk = lambda: called.append("sdk")
        try:
            r = await cursor_catalog.set_archived({"agent_id": "agent-old"}, True)
        finally:
            (cursor_catalog.CURSOR_AVAILABLE, cursor_catalog.legacy_store_agent_ids,
             cursor_catalog.require_sdk) = saved
        self.assertTrue(r["ok"])
        self.assertFalse(r["mirrored"])
        self.assertEqual(r["reason"], "legacy_store")
        # The doomed RPC is never attempted.
        self.assertEqual(called, [])
