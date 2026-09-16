import copy
import unittest

from charon_agent.endpoint_parameters import apply_parameters, selected_params
from charon_agent.endpoint_runtime import claude_env, codex_overrides


class EndpointParametersTests(unittest.TestCase):
    def setUp(self):
        axes = [
            {"id": "effort", "values": [{"value": v} for v in ["low", "high", "max"]]},
            {"id": "thinking", "values": [{"value": v} for v in ["true", "false"]]},
            {"id": "budget_tokens", "values": [{"value": "16384"}]},
        ]
        self.endpoint = {"baseUrl": "https://opencode.ai/zen/go", "model": "custom", "auth": "none", "models": [{
            "id": "custom", "info": {"outputTokens": 65536},
            "parameters": {"claude": axes, "codex": axes[:2]},
            "checks": {k: {"model": "custom", "ok": True} for k in ["claude", "codex"]},
        }]}

    def test_explicit_selection_overrides_cli_defaults_without_changing_input(self):
        for engine, body in [("claude", {"output_config": {"effort": "high", "format": "text"}, "thinking": {"type": "disabled"}}),
                             ("codex", {"reasoning": {"effort": "high", "summary": "auto"}})]:
            original = {"model": "custom", "service_tier": "priority", **body}
            before = copy.deepcopy(original)
            result = apply_parameters(original, self.endpoint, engine, "effort=max")
            self.assertNotIn("service_tier", result)
            self.assertEqual(result["output_config" if engine == "claude" else "reasoning"]["effort"], "max")
            default = apply_parameters(original, self.endpoint, engine, None)
            self.assertNotIn("reasoning", default)
            self.assertNotIn("thinking", default)
            self.assertNotIn("effort", default.get("output_config", {}))
            self.assertEqual(original, before)

    def test_thinking_off_and_token_budget_are_native_messages_parameters(self):
        off = apply_parameters({"model": "custom"}, self.endpoint, "claude", "thinking=false")
        self.assertEqual(off["thinking"], {"type": "disabled"})
        result = apply_parameters({"model": "custom", "max_tokens": 4096}, self.endpoint, "claude", "budget_tokens=16384&thinking=true")
        self.assertEqual(result["thinking"], {"type": "enabled", "budget_tokens": 16384})
        self.assertGreater(result["max_tokens"], 16384)
        self.assertEqual(apply_parameters({"model": "custom"}, self.endpoint, "codex", "thinking=false")["reasoning"], {"effort": "none"})
        self.assertEqual(apply_parameters({"model": "custom"}, self.endpoint, "codex", "thinking=true")["reasoning"], {"effort": "high"})

    def test_invalid_or_foreign_parameters_never_reach_the_endpoint(self):
        for effort in ["fast=true", "effort=ultra", "effort=max&effort=low", "effort=max&thinking=false", "effort=max&token=secret"]:
            with self.assertRaises(ValueError): selected_params(self.endpoint, "claude", "custom", effort)
        other = {**self.endpoint, "baseUrl": "https://another.example"}
        with self.assertRaises(ValueError): selected_params(other, "claude", "custom", "effort=max")
        result = apply_parameters({"model": "other", "reasoning": {"effort": "max"}}, self.endpoint, "codex", "effort=max")
        self.assertNotIn("reasoning", result)

    def test_parameter_sets_never_enter_cli_enums(self):
        params = "effort=max&thinking=true"
        self.assertEqual(claude_env(self.endpoint, "custom", params)["CLAUDE_CODE_EFFORT_LEVEL"], "auto")
        overrides, _ = codex_overrides(self.endpoint, "custom", params)
        self.assertNotIn(params, "\n".join(overrides))
        self.assertIn('model_reasoning_effort="none"', overrides)

    def test_sessions_preserve_parameters_across_construction_and_persistence(self):
        from charon_agent.session import AgentSession
        from charon_agent.codex_session import CodexSession
        for cls, key in [(AgentSession, "session_config"), (CodexSession, "codex_config")]:
            session = cls("test", cwd="/tmp", name="test", permission_mode="normal", claude_session_id=None,
                          emit=lambda e: None, on_state_change=lambda: None, model="custom", effort="effort=max",
                          **{key: {"customEndpoint": self.endpoint}})
            self.assertEqual(session.effort, "effort=max")
            self.assertEqual(session.to_persist()["effort"], "effort=max")
