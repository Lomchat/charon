"""Codex app-server notification translation stays visible and bounded."""
import contextlib
import io
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.codex_session import CodexSession  # noqa: E402


def ev(class_name, **attrs):
    return type(class_name, (), attrs)()


def session():
    s = CodexSession.__new__(CodexSession)
    s._streamed_items = set()
    s._last_usage = None
    s._effective_model = None
    s._plan_deltas = {}
    return s


class CodexNotificationTranslation(unittest.TestCase):
    def test_command_output_is_live_progress(self):
        out = session()._translate(ev(
            "CommandExecutionOutputDeltaNotification", item_id="cmd-1", delta="building\n"
        ))
        self.assertEqual(out, [{"event": "tool_progress", "tool_use_id": "cmd-1", "delta": "building\n"}])

    def test_patch_update_is_per_file(self):
        change = types.SimpleNamespace(path="src/a.ts", diff="@@ -1 +1 @@\n-a\n+b")
        out = session()._translate(ev(
            "FileChangePatchUpdatedNotification", item_id="edit-1", changes=[change]
        ))
        self.assertEqual(out[0]["event"], "edit_progress")
        self.assertEqual(out[0]["file_path"], "src/a.ts")

    def test_structured_plan_keeps_statuses(self):
        steps = [types.SimpleNamespace(step="Inspect", status=types.SimpleNamespace(value="completed"))]
        out = session()._translate(ev(
            "TurnPlanUpdatedNotification", turn_id="t1", explanation="why", plan=steps
        ))
        self.assertEqual(out[0]["id"], "turn-t1")
        self.assertEqual(out[0]["steps"], [{"step": "Inspect", "status": "completed"}])

    def test_compaction_and_reroute_use_existing_events(self):
        s = session()
        self.assertEqual(s._translate(ev("ContextCompactedNotification"))[0]["event"], "compaction")
        reroute = s._translate(ev("ModelReroutedNotification", to_model="gpt-5.4", from_model="gpt-5.3"))
        self.assertEqual(reroute, [{"event": "effective_model", "model": "gpt-5.4"}])

    def test_unknown_notification_is_logged(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(session()._translate(ev("FutureNotification")), [])
        self.assertIn("unhandled notification FutureNotification", err.getvalue())

    def test_global_status_mcp_and_invalidations_are_live_signals(self):
        s = session()
        status = types.SimpleNamespace(model_dump=lambda **_kw: {
            "type": "active", "activeFlags": ["waitingOnApproval"],
        })
        events = []
        for payload in (
            ev("ThreadStatusChangedNotification", thread_id="t1", status=status),
            ev("McpServerStatusUpdatedNotification", thread_id="t1", name="docs",
               status=types.SimpleNamespace(value="failed"), error="timeout",
               failure_reason=None),
            ev("SkillsChangedNotification"),
            ev("FsChangedNotification", watch_id="w1", changed_paths=["/tmp/a"]),
        ):
            events.extend(s._translate(payload))
        self.assertEqual([e["event"] for e in events], ["codex_signal"] * 4)
        self.assertEqual(events[0]["status"], "active")
        self.assertEqual(events[1]["kind"], "mcp_status")
        self.assertEqual(events[3]["detail"]["paths"], ["/tmp/a"])

    def test_turn_diff_splits_files(self):
        diff = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n"
        self.assertEqual(CodexSession._split_turn_diff(diff)[0][0], "a.txt")

    def test_dynamic_tool_is_rendered(self):
        s = session()
        item = ev("DynamicToolCallThreadItem", id="d1", tool="lookup", namespace="repo",
                  arguments={"q": "x"}, success=True, content_items=[{"text": "ok"}])
        out = []
        s._on_item(item, phase="started", out=out)
        s._on_item(item, phase="completed", out=out)
        self.assertEqual(out[0]["name"], "repo/lookup")
        self.assertEqual(out[1]["event"], "tool_result")

    def test_collab_agents_have_visible_lifecycle(self):
        s = session()
        item = ev("CollabAgentToolCallThreadItem", id="c1", tool=types.SimpleNamespace(value="spawn"),
                  receiver_thread_ids=["child"], sender_thread_id="parent", prompt="inspect",
                  model="gpt", agents_states={"child": {"status": "completed", "message": "done"}},
                  status=types.SimpleNamespace(value="completed"))
        out = []
        s._on_item(item, phase="started", out=out)
        s._on_item(item, phase="completed", out=out)
        self.assertTrue(any(e.get("event") == "bg_task" and e.get("kind") == "started" for e in out))
        self.assertTrue(any(e.get("event") == "bg_task" and e.get("kind") == "finished" for e in out))

    def test_review_image_sleep_and_hook_prompt_are_not_dropped(self):
        s = session()
        items = [
            ev("EnteredReviewModeThreadItem", id="r", review="changes"),
            ev("ImageGenerationThreadItem", id="i", status="completed", saved_path="/tmp/i.png", result=""),
            ev("SleepThreadItem", id="s", duration_ms=50),
            ev("HookPromptThreadItem", id="h", fragments=[types.SimpleNamespace(text="rule")]),
        ]
        out = []
        for item in items:
            s._on_item(item, phase="completed", out=out)
        self.assertEqual([e["event"] for e in out], ["tool_activity", "tool_result", "tool_activity", "tool_activity"])


if __name__ == "__main__":
    unittest.main()
