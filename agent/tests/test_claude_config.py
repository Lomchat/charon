"""Provider-neutral advanced config maps to native Claude SDK options."""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.session import AgentSession  # noqa: E402


class ClaudeAdvancedConfigTest(unittest.TestCase):
    def make_session(self, config, cwd="/tmp"):
        return AgentSession(
            "s1", cwd=cwd, name="demo", permission_mode="normal",
            claude_session_id=None, emit=lambda _event: None,
            on_state_change=lambda: None, session_config=config,
        )

    def test_maps_instructions_schema_skills_and_environment(self):
        schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
        session = self.make_session({
            "baseInstructions": "Be concise.",
            "developerInstructions": "Run tests.",
            "outputSchema": schema,
            "skills": ["review", "  frontend  ", 4],
            "env": {"REGION": "eu", "N": 3},
        })
        got = session._advanced_option_kwargs()
        self.assertEqual(got["system_prompt"]["preset"], "claude_code")
        self.assertIn("Session instructions:\nBe concise.", got["system_prompt"]["append"])
        self.assertIn("Developer instructions:\nRun tests.", got["system_prompt"]["append"])
        self.assertEqual(got["output_format"], {"type": "json_schema", "schema": schema})
        self.assertEqual(got["skills"], ["review", "frontend"])
        self.assertEqual(got["env"], {"REGION": "eu", "N": "3"})

    def test_config_survives_agent_state_persistence(self):
        session = self.make_session({"skills": "all", "baseInstructions": "Keep this"})
        saved = session.to_persist()["provider_config"]
        self.assertEqual(saved["skills"], "all")
        self.assertEqual(saved["baseInstructions"], "Keep this")


class ClaudeSettingSourcesTest(unittest.TestCase):
    """§14.100 — which settings files a session loads."""

    def make_session(self, config, cwd="/tmp"):
        return AgentSession(
            "s1", cwd=cwd, name="demo", permission_mode="normal",
            claude_session_id=None, emit=lambda _event: None,
            on_state_change=lambda: None, session_config=config,
        )

    def test_a_session_that_never_chose_keeps_the_historical_project_scope(self):
        for config in (None, {}, {"settingSources": None}, {"settingSources": "user"}):
            with self.subTest(config=config):
                self.assertEqual(
                    self.make_session(config)._effective_setting_sources(), ["project"])

    def test_an_explicit_choice_is_normalised_to_the_canonical_order(self):
        session = self.make_session({"settingSources": ["local", "user", "user", "nope"]})
        self.assertEqual(session._effective_setting_sources(), ["user", "local"])

    def test_empty_list_is_isolation_not_the_default(self):
        # The whole point of the tri-state: [] must reach the SDK as [] (no
        # settings file, no CLAUDE.md), never collapse back to ["project"].
        session = self.make_session({"settingSources": []})
        self.assertEqual(session._effective_setting_sources(), [])
        self.assertEqual(session.to_persist()["provider_config"]["settingSources"], [])

    def test_the_scope_is_never_set_twice(self):
        # _run passes setting_sources itself; _advanced_option_kwargs must not
        # also emit it, or the two answers can drift.
        session = self.make_session({"settingSources": ["user"], "skills": "all"})
        self.assertNotIn("setting_sources", session._advanced_option_kwargs())

    def test_skills_in_a_scope_that_is_not_loaded_are_reported_unavailable(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as cwd:
            user_skill = Path(home) / ".claude" / "skills" / "audit" / "SKILL.md"
            user_skill.parent.mkdir(parents=True)
            user_skill.write_text("---\nname: audit\ndescription: user one\n---\n")
            project_skill = Path(cwd) / ".claude" / "skills" / "review" / "SKILL.md"
            project_skill.parent.mkdir(parents=True)
            project_skill.write_text("---\nname: review\ndescription: project one\n---\n")

            with mock.patch.dict(os.environ, {"HOME": home}):
                project_only = self.make_session({"settingSources": ["project"]}, cwd=cwd)
                by_name = {s["name"]: s for s in project_only._discovered_skills()}
                self.assertFalse(by_name["audit"]["available"])
                self.assertFalse(by_name["audit"]["enabled"])
                self.assertIn("not loaded", by_name["audit"]["unavailable_reason"])
                self.assertTrue(by_name["review"]["available"])
                self.assertTrue(by_name["review"]["enabled"])

                both = self.make_session({"settingSources": ["user", "project"]}, cwd=cwd)
                by_name = {s["name"]: s for s in both._discovered_skills()}
                self.assertTrue(by_name["audit"]["available"])
                self.assertTrue(by_name["audit"]["enabled"])


class ClaudePermissionExpiryTest(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_emits_expiry_after_deadlined_request(self):
        emitted = []
        session = AgentSession(
            "s1", cwd="/tmp", name="demo", permission_mode="normal",
            claude_session_id=None, emit=emitted.append,
            on_state_change=lambda: None,
        )
        with mock.patch(
            "charon_agent.session.asyncio.wait_for",
            side_effect=asyncio.TimeoutError,
        ):
            result = await session._ask_dashboard_permission(
                tool_name="Bash", tool_input={"command": "npm test"},
                perm_id="perm-timeout",
            )

        self.assertIsNone(result)
        self.assertEqual(emitted[0]["event"], "permission_request")
        self.assertGreater(emitted[0]["expires_at"], int(time.time()))
        self.assertEqual(emitted[1], {
            "event": "interaction_resolved", "session_id": "s1",
            "id": "perm-timeout",
            "kind": "permission", "outcome": "expired",
        })
        self.assertFalse(session.respond_permission("perm-timeout", True))


class ClaudeResourcesTest(unittest.IsolatedAsyncioTestCase):
    async def test_context_envelope_has_common_provider_and_status(self):
        session = AgentSession(
            "s1", cwd="/tmp", name="demo", permission_mode="normal",
            claude_session_id=None, emit=lambda _event: None,
            on_state_change=lambda: None,
        )
        session.status = "thinking"

        class Client:
            async def get_context_usage(self):
                return {"totalTokens": 250, "maxTokens": 1000, "percentage": 25}

        session._client = Client()
        result = await session.context_usage()
        self.assertEqual(result["provider"], "claude")
        self.assertEqual(result["status"], {"type": "thinking"})
        self.assertEqual(result["total_tokens"], 250)

    async def test_project_skills_and_live_commands_share_one_inventory(self):
        with tempfile.TemporaryDirectory(prefix="charon-skills-") as tmp:
            skill = Path(tmp) / ".claude" / "skills" / "review" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("---\nname: careful-review\ndescription: Find regressions\n---\n", encoding="utf-8")
            session = AgentSession(
                "s1", cwd=tmp, name="demo", permission_mode="normal",
                claude_session_id=None, emit=lambda _event: None,
                on_state_change=lambda: None,
                session_config={"skills": ["careful-review"]},
            )

            class Client:
                async def get_server_info(self):
                    return {"commands": [{"name": "compact", "description": "Compact context"}]}

            session._client = Client()
            result = await session.resources()
            self.assertEqual(result["skills"][0]["name"], "careful-review")
            self.assertTrue(result["skills"][0]["enabled"])
            self.assertEqual(result["commands"], [{
                "name": "compact", "description": "Compact context", "argument_hint": None,
            }])


if __name__ == "__main__":
    unittest.main(verbosity=2)
