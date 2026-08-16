import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.codex_session import CodexSession  # noqa: E402


def session():
    emitted = []
    s = CodexSession(
        "codex-perms", cwd="/tmp", name="test", permission_mode="workspace-write",
        claude_session_id="thread-1", emit=emitted.append,
        on_state_change=lambda: None,
    )
    return s, emitted


class TestCodexPermissions(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
