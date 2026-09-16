import asyncio
import os
import sys
import time
import unittest
import types
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.codex_session import (  # noqa: E402
    CodexSession, _approval_policy_wire, _collaboration_mode_wire,
    _sandbox_mode_wire, _sandbox_policy_wire,
)


def session():
    emitted = []
    s = CodexSession(
        "codex-perms", cwd="/tmp", name="test", permission_mode="workspace-write",
        claude_session_id="thread-1", emit=emitted.append,
        on_state_change=lambda: None,
    )
    return s, emitted


class TestCodexPermissions(unittest.TestCase):
    def test_accept_all_combines_unrestricted_sandbox_and_no_prompts(self):
        s = CodexSession(
            "codex-unrestricted", cwd="/tmp", name="test",
            permission_mode="accept-all", claude_session_id=None,
            emit=lambda _event: None, on_state_change=lambda: None,
        )
        self.assertEqual(s.permission_mode, "accept-all")
        self.assertEqual(_sandbox_mode_wire(s.permission_mode), "danger-full-access")
        self.assertEqual(_sandbox_policy_wire(s.permission_mode), {"type": "dangerFullAccess"})
        self.assertEqual(_approval_policy_wire(s.permission_mode), "never")

    def test_interactive_modes_keep_on_request_approval(self):
        self.assertEqual(_approval_policy_wire("workspace-write"), "on-request")
        self.assertEqual(_approval_policy_wire("full-access"), "on-request")
        self.assertEqual(_approval_policy_wire("read-only"), "never")

    def test_accept_all_reaches_thread_and_every_turn(self):
        async def main():
            calls = {}

            class Raw:
                async def thread_start(self, params):
                    calls["thread"] = params
                    return types.SimpleNamespace(thread=types.SimpleNamespace(id="thread-new"))

                async def turn_start(self, thread_id, content, params):
                    calls["turn"] = params
                    return types.SimpleNamespace(turn=types.SimpleNamespace(id="turn-new"))

            class AsyncThread:
                def __init__(self, _client, thread_id):
                    self.id = thread_id

            class AsyncTurnHandle:
                def __init__(self, _client, thread_id, turn_id):
                    self.thread_id = thread_id
                    self.turn_id = turn_id

            package = types.ModuleType("openai_codex"); package.__path__ = []
            api = types.ModuleType("openai_codex.api")
            api.AsyncThread = AsyncThread
            api.AsyncTurnHandle = AsyncTurnHandle
            client = types.SimpleNamespace(_client=Raw())
            s = CodexSession(
                "codex-unrestricted", cwd="/tmp", name="test",
                permission_mode="accept-all", claude_session_id=None,
                emit=lambda _event: None, on_state_change=lambda: None,
                codex_config={"permissionProfile": ":workspace"},
            )
            s._client = client
            with mock.patch.dict(sys.modules, {
                "openai_codex": package,
                "openai_codex.api": api,
            }):
                thread = await s._sdk_thread_start(client, resume=False)
                await s._sdk_turn(thread, "do it")

            self.assertEqual(calls["thread"]["approvalPolicy"], "never")
            self.assertEqual(calls["thread"]["sandbox"], "danger-full-access")
            self.assertNotIn("permissions", calls["thread"])
            self.assertEqual(calls["turn"]["approvalPolicy"], "never")
            self.assertEqual(calls["turn"]["sandboxPolicy"], {"type": "dangerFullAccess"})

        asyncio.run(main())

    def test_accept_all_defensively_accepts_residual_sdk_gates(self):
        s, emitted = session()
        s.permission_mode = "accept-all"
        requested = {"network": {"enabled": True}}

        self.assertEqual(s._sdk_approval_handler(
            "item/commandExecution/requestApproval", {"itemId": "cmd-1"},
        ), {"decision": "acceptForSession"})
        self.assertEqual(s._sdk_approval_handler(
            "item/fileChange/requestApproval", {"itemId": "edit-1"},
        ), {"decision": "acceptForSession"})
        self.assertEqual(s._sdk_approval_handler(
            "item/permissions/requestApproval", {"permissions": requested},
        ), {"permissions": requested, "scope": "session"})
        self.assertEqual(s._sdk_approval_handler(
            "mcpServer/elicitation/request", {"mode": "url"},
        ), {"action": "accept", "content": {}})
        self.assertEqual(emitted, [])

    def test_guardian_denial_is_kept_for_one_exact_override(self):
        s, _ = session()
        review = types.SimpleNamespace(
            status=types.SimpleNamespace(value="denied"), rationale="unsafe",
            risk_level=types.SimpleNamespace(value="high"),
        )
        payload = type("ItemGuardianApprovalReviewCompletedNotification", (), {
            "review_id": "review-1", "review": review,
            "action": {"type": "command", "command": "danger"},
        })()
        out = s._translate(payload)
        self.assertTrue(out[0]["is_error"])
        self.assertEqual(s._guardian_denials[0]["review_id"], "review-1")
        self.assertEqual(s._guardian_denials[0]["rationale"], "unsafe")

    def test_security_config_is_persisted(self):
        s, _ = session()
        s.codex_config["approvals_reviewer"] = "auto_review"
        s.codex_config["permission_profile"] = ":workspace"
        saved = s.to_persist()["codex_config"]
        self.assertEqual(saved["approvalsReviewer"], "auto_review")
        self.assertEqual(saved["permissionProfile"], ":workspace")

    def test_missing_profile_catalog_does_not_hide_reviewer(self):
        class Unsupported(RuntimeError):
            code = -32601

        class Raw:
            async def request(self, *_args, **_kwargs):
                raise Unsupported("no permissionProfile/list")

        async def main():
            s, _ = session()
            s.codex_config["approvals_reviewer"] = "auto_review"
            s._client = types.SimpleNamespace(_client=Raw())
            generated = types.ModuleType("openai_codex.generated.v2_all")
            generated.PermissionProfileListResponse = object
            package = types.ModuleType("openai_codex"); package.__path__ = []
            generated_package = types.ModuleType("openai_codex.generated"); generated_package.__path__ = []
            with mock.patch.dict(sys.modules, {
                "openai_codex": package,
                "openai_codex.generated": generated_package,
                "openai_codex.generated.v2_all": generated,
            }):
                result = await s.security_status()
            self.assertTrue(result["ok"])
            self.assertEqual(result["reviewer"], "auto_review")
            self.assertEqual(result["profile_reason"], "unsupported")

        asyncio.run(main())

    def test_command_allow_once_and_session(self):
        async def main(always):
            s, emitted = session()
            task = asyncio.create_task(s._await_sdk_request(
                "item/commandExecution/requestApproval",
                {"itemId": "cmd-1", "threadId": "thread-1", "command": "npm test"},
            ))
            await asyncio.sleep(0)
            self.assertEqual(emitted[0]["event"], "permission_request")
            self.assertNotIn("threadId", emitted[0]["input"])
            s.respond_permission("cmd-1", True, always)
            return await task

        self.assertEqual(asyncio.run(main(False)), {"decision": "accept"})
        self.assertEqual(asyncio.run(main(True)), {"decision": "acceptForSession"})

    def test_file_deny_and_requested_permission_subset(self):
        async def main():
            s, _ = session()
            denied = asyncio.create_task(s._await_sdk_request(
                "item/fileChange/requestApproval", {"itemId": "edit-1"},
            ))
            await asyncio.sleep(0)
            s.respond_permission("edit-1", False)
            self.assertEqual(await denied, {"decision": "decline"})

            requested = {"network": {"enabled": True}}
            granted = asyncio.create_task(s._await_sdk_request(
                "item/permissions/requestApproval",
                {"itemId": "perm-1", "permissions": requested},
            ))
            await asyncio.sleep(0)
            s.respond_permission("perm-1", True, True)
            self.assertEqual(await granted, {"permissions": requested, "scope": "session"})

        asyncio.run(main())

    def test_request_user_input_maps_dashboard_answers(self):
        async def main():
            s, emitted = session()
            task = asyncio.create_task(s._await_sdk_request(
                "item/tool/requestUserInput",
                {"requestId": "q-1", "questions": [{
                    "id": "choice", "header": "Pick", "question": "Which?",
                    "options": [{"label": "A"}, {"label": "B"}],
                }]},
            ))
            await asyncio.sleep(0)
            self.assertEqual(emitted[0]["event"], "user_question")
            s.respond_question("q-1", {"Which?": "A"})
            self.assertEqual(await task, {"answers": {"choice": {"answers": ["A"]}}})

        asyncio.run(main())

    def test_shutdown_unblocks_pending_reader_request(self):
        async def main():
            s, _ = session()
            task = asyncio.create_task(s._await_sdk_request(
                "item/commandExecution/requestApproval", {"itemId": "cmd-stop"},
            ))
            await asyncio.sleep(0)
            s._cancel_pending_requests()
            self.assertEqual(await task, {"decision": "decline"})

        asyncio.run(main())

    def test_timeout_emits_durable_expiry_after_deadlined_request(self):
        async def main():
            s, emitted = session()
            with mock.patch(
                "charon_agent.codex_session.asyncio.wait_for",
                side_effect=asyncio.TimeoutError,
            ):
                result = await s._await_sdk_request(
                    "item/commandExecution/requestApproval",
                    {"itemId": "cmd-timeout", "command": "npm test"},
                )
            self.assertEqual(result, {"decision": "cancel"})
            self.assertEqual(emitted[0]["event"], "permission_request")
            self.assertGreater(emitted[0]["expires_at"], int(time.time()))
            self.assertEqual(emitted[1], {
                "event": "interaction_resolved", "session_id": "codex-perms",
                "id": "cmd-timeout",
                "kind": "permission", "outcome": "expired",
            })
            self.assertFalse(s.respond_permission("cmd-timeout", True))

        asyncio.run(main())

    def test_mcp_form_uses_question_card_and_returns_content(self):
        async def main():
            s, emitted = session()
            task = asyncio.create_task(s._await_sdk_request(
                "mcpServer/elicitation/request",
                {"requestId": "mcp-1", "mode": "form", "serverName": "docs",
                 "requestedSchema": {"properties": {"project": {"title": "Project"}}}},
            ))
            await asyncio.sleep(0)
            self.assertEqual(emitted[0]["event"], "user_question")
            s.respond_question("mcp-1", {"Project": "Charon"})
            self.assertEqual(await task, {"action": "accept", "content": {"project": "Charon"}})

        asyncio.run(main())

    # ── Read-only runs in Codex's Plan collaboration mode ────────────────────
    # Codex only offers the blocking request_user_input tool in Plan. Without
    # it a Codex session can never raise item/tool/requestUserInput, so the
    # question card is unreachable. Verified against codex 0.154.0: the same
    # prompt produces the server request in Plan and plain text in Default.

    def test_only_read_only_plans(self):
        self.assertEqual(
            _collaboration_mode_wire("read-only", "gpt-x", None),
            {"mode": "plan", "settings": {"model": "gpt-x"}},
        )
        # Every other rung sends Default EXPLICITLY: leaving read-only must also
        # leave Plan, and the thread would otherwise keep the last mode it saw.
        for mode in ("workspace-write", "full-access", "accept-all"):
            self.assertEqual(_collaboration_mode_wire(mode, "gpt-x", None)["mode"], "default")

    def test_collaboration_settings_carry_effort(self):
        # The settings override the turn's own effort; dropping it would
        # silently reset the user's choice whenever the mode is sent.
        self.assertEqual(
            _collaboration_mode_wire("read-only", "gpt-x", "high")["settings"],
            {"model": "gpt-x", "reasoning_effort": "high"},
        )

    def test_no_model_omits_collaboration_mode(self):
        # settings.model is required on the wire; an unsendable mode must not
        # fail the turn.
        self.assertIsNone(_collaboration_mode_wire("read-only", None, "high"))

    def _turn_params(self, mode, *, model=None, resume=False, codex_config=None, effort=None):
        """Run thread start/resume then one turn; return the turn params."""
        async def main():
            calls = {}

            class Raw:
                async def thread_start(self, params):
                    return types.SimpleNamespace(
                        thread=types.SimpleNamespace(id="thread-new"), model="gpt-started")

                async def request(self, method, params, response_model):
                    return response_model({"thread": {"id": "thread-1"}, "model": "gpt-resumed"})

                async def turn_start(self, thread_id, content, params):
                    calls["turn"] = params
                    return types.SimpleNamespace(turn=types.SimpleNamespace(id="turn-new"))

            class AsyncThread:
                def __init__(self, _client, thread_id):
                    self.id = thread_id

            class AsyncTurnHandle:
                def __init__(self, _client, thread_id, turn_id):
                    pass

            package = types.ModuleType("openai_codex"); package.__path__ = []
            api = types.ModuleType("openai_codex.api")
            api.AsyncThread = AsyncThread
            api.AsyncTurnHandle = AsyncTurnHandle
            client = types.SimpleNamespace(_client=Raw())
            s = CodexSession(
                "codex-plan", cwd="/tmp", name="test", permission_mode=mode,
                claude_session_id="thread-1", emit=lambda _event: None,
                on_state_change=lambda: None, model=model, codex_config=codex_config,
            )
            # Set after construction: an endpoint session validates effort
            # against the endpoint's parameters in __init__.
            s.effort = effort
            s._client = client
            with mock.patch.dict(sys.modules, {"openai_codex": package, "openai_codex.api": api}):
                thread = await s._sdk_thread_start(client, resume=resume)
                await s._sdk_turn(thread, "go")
            return calls["turn"]

        return asyncio.run(main())

    def test_read_only_turn_plans_with_the_started_thread_model(self):
        # The common case: no explicit model, so the only source for the
        # required settings.model is what thread/start resolved.
        params = self._turn_params("read-only")
        self.assertEqual(params["collaborationMode"],
                         {"mode": "plan", "settings": {"model": "gpt-started"}})
        self.assertEqual(params["sandboxPolicy"], {"type": "readOnly"})

    def test_read_only_turn_plans_after_resume(self):
        # A session resumed after an agent restart has no thread/start response;
        # the model must come from thread/resume or Plan silently turns off.
        params = self._turn_params("read-only", resume=True)
        self.assertEqual(params["collaborationMode"]["mode"], "plan")
        self.assertEqual(params["collaborationMode"]["settings"]["model"], "gpt-resumed")

    def test_explicit_model_wins_over_thread_model(self):
        params = self._turn_params("read-only", model="gpt-picked")
        self.assertEqual(params["collaborationMode"]["settings"]["model"], "gpt-picked")

    def test_plan_settings_carry_effort_on_the_turn(self):
        params = self._turn_params("read-only", effort="high")
        self.assertEqual(params["collaborationMode"]["settings"]["reasoning_effort"], "high")

    def test_custom_endpoint_plan_settings_withhold_effort(self):
        # A custom endpoint applies effort in its proxy and deliberately sends
        # none to Codex. The collaboration settings override the turn, so
        # carrying effort there would re-inject what the turn withholds.
        params = self._turn_params(
            "read-only", effort="high",
            codex_config={"customEndpoint": {"baseUrl": "http://127.0.0.1:9", "model": "m", "auth": "none"}},
        )
        self.assertNotIn("effort", params)
        self.assertEqual(params["collaborationMode"]["mode"], "plan")
        self.assertNotIn("reasoning_effort", params["collaborationMode"]["settings"])

    def test_writable_turn_sends_default(self):
        params = self._turn_params("workspace-write")
        self.assertEqual(params["collaborationMode"]["mode"], "default")

if __name__ == "__main__":
    unittest.main()
