"""Codex app-server notification translation stays visible and bounded."""
import contextlib
import io
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.codex_session import CodexSession  # noqa: E402


def ev(name, **attrs):
    return type(name, (), attrs)()


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

    def test_turn_diff_splits_files(self):
        diff = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n"
        self.assertEqual(CodexSession._split_turn_diff(diff)[0][0], "a.txt")


if __name__ == "__main__":
    unittest.main()
