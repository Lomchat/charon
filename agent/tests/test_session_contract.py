"""Every session class must carry the private surface `server.py` drives.

`server.py` is the ONE driver for all backends, and it reaches past the public
methods: `resume_session` clears `_stopped` / `_ready_evt` / `_session_id_emitted`
before calling `start()` — those are READS (`.clear()`), so a class that never
created them explodes. Plain assignments are excluded on purpose: `s._x = v`
works on any object and proves nothing.

A class missing one of those does not fail at import or at start — it fails
mid-RESUME with an AttributeError, leaving the session stuck in 'starting'
with no visible error. That shipped: Cursor sessions stopped coming back after
a VPS update, and looked "running" forever, for exactly this reason.

The contract was implicit until then. This test makes it explicit by scraping
what the driver actually touches, so a fourth backend cannot rediscover it the
same way.
"""
import ast
import sys
import unittest
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENT_DIR))

SERVER = AGENT_DIR / "charon_agent" / "server.py"

# What `server.py` calls a session it is holding.
SESSION_VARS = {"s", "s_", "sess", "session", "target", "other"}

SESSION_CLASSES = [
    ("charon_agent/session.py", "AgentSession"),
    ("charon_agent/codex_session.py", "CodexSession"),
    ("charon_agent/cursor_session.py", "CursorSession"),
]


def driver_attributes() -> set[str]:
    """Private attributes the driver reads off a session on a SHARED path.

    Helpers whose name names one provider (`_rewind_claude_session`) are
    skipped: they are that backend's own mechanism, and the attributes they
    reset (`_client_ctx`, `_cli_title_value`) legitimately exist on Claude
    alone. Requiring them everywhere would push a stub onto every backend to
    satisfy a path it can never reach — the opposite of the §14.102 rule that
    only a decision EVERY provider owes belongs in the shared contract.
    """
    tree = ast.parse(SERVER.read_text("utf-8"))
    provider_ids = ("claude", "codex", "cursor")
    found: set[str] = set()

    def scan(node: ast.AST) -> None:
        for child in ast.walk(node):
            if not isinstance(child, ast.Attribute) or not child.attr.startswith("_"):
                continue
            # READS only. `s._foo = x` creates the attribute on any object, so
            # a store proves nothing; `s._foo.clear()` is what explodes when
            # __init__ never made it. That distinction is the whole test.
            if not isinstance(child.ctx, ast.Load):
                continue
            base = child.value
            if isinstance(base, ast.Name) and base.id in SESSION_VARS:
                found.add(child.attr)

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if any(pid in node.name.lower() for pid in provider_ids):
                continue
            # Scan the body only, so a nested provider-specific helper is
            # skipped by its own iteration rather than through its parent.
            for stmt in node.body:
                if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                scan(stmt)
    return found


def class_surface(rel: str, name: str) -> set[str]:
    """Everything an instance of this class exposes: methods, class attrs, and
    whatever `__init__` assigns to `self`."""
    tree = ast.parse((AGENT_DIR / rel).read_text("utf-8"))
    cls = next(n for n in ast.walk(tree)
               if isinstance(n, ast.ClassDef) and n.name == name)
    surface: set[str] = set()
    for node in cls.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            surface.add(node.name)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            surface.add(node.target.id)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    surface.add(t.id)
    init = next((n for n in cls.body
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and n.name == "__init__"), None)
    if init is not None:
        for node in ast.walk(init):
            targets = []
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, ast.AnnAssign):
                targets = [node.target]
            for t in targets:
                if (isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name)
                        and t.value.id == "self"):
                    surface.add(t.attr)
    return surface


class SessionContractTest(unittest.TestCase):
    def test_the_driver_touches_something(self):
        attrs = driver_attributes()
        # If this ever empties, the scrape went stale and every assertion below
        # would pass vacuously — the §14.89 failure mode. The named three are
        # the ones the resume path actually reads back.
        self.assertGreaterEqual(len(attrs), 3, f"scraped almost nothing: {attrs}")
        for required in ("_stopped", "_ready_evt", "_client"):
            self.assertIn(required, attrs)

    def test_every_backend_carries_it(self):
        attrs = driver_attributes()
        for rel, name in SESSION_CLASSES:
            surface = class_surface(rel, name)
            missing = sorted(a for a in attrs if a not in surface)
            self.assertEqual(
                missing, [],
                f"{name} ({rel}) is missing {missing} — `server.py` resets these "
                f"by name during resume, so the session would stick in 'starting'",
            )

    def test_every_backend_carries_the_public_lifecycle(self):
        # The public half of the same contract. `to_persist` is what puts a
        # session back after a daemon restart; without it a backend silently
        # loses every session on reboot.
        required = {
            "start", "stop", "force_stop", "send_input", "interrupt",
            "set_permission_mode", "set_model", "set_effort",
            "respond_permission", "respond_question", "respond_exit_plan",
            "to_info", "to_persist",
        }
        for rel, name in SESSION_CLASSES:
            surface = class_surface(rel, name)
            missing = sorted(required - surface)
            self.assertEqual(missing, [], f"{name} is missing {missing}")


if __name__ == "__main__":
    unittest.main()
