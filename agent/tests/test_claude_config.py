"""Provider-neutral advanced config maps to native Claude SDK options."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

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
