"""A Claude session's `/goal`, read from its transcript (CLAUDE.md §14.119).

The CLI keeps the goal in its own app state and never streams it to an SDK
host (its `active_goal` message is UI-only). What it does write, to the
session's JSONL transcript, is one `goal_status` attachment per change — the
same records it restores the goal from on resume:

  sentinel, met:false  → a goal was set (`/goal <condition>`)
  sentinel, met:true   → it was cleared (`/goal clear`)
  met:false            → the evaluator said "not yet", with its reason
  met:true             → reached (iterations, duration, tokens)
  failed:true          → judged impossible

So this module folds those lines, read incrementally by byte cursor, into
the wire shape the hub stores (lib/sessionGoal.ts). Stdlib only.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

GOAL_MARK = b'"goal_status"'
_MAX_REASON = 2000
_MAX_OBJECTIVE = 4000
_CHUNK = 1 << 20


def _ts_ms(raw: Any, fallback: int) -> int:
    if isinstance(raw, str) and raw:
        try:
            return int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            pass
    return fallback


def fold_goal(goal: dict[str, Any] | None, att: dict[str, Any], ts_ms: int) -> dict[str, Any] | None:
    """The goal after one `goal_status` attachment."""
    cond = att.get("condition")
    if not isinstance(cond, str) or not cond.strip():
        return goal
    cond = cond[:_MAX_OBJECTIVE]
    met = att.get("met") is True
    if att.get("sentinel") is True:
        if met:
            return None  # `/goal clear`
        return {"objective": cond, "status": "active", "iterations": 0,
                "reason": None, "set_at": ts_ms, "updated_at": ts_ms}
    same = goal is not None and goal.get("objective") == cond
    out: dict[str, Any] = dict(goal) if same else {
        "objective": cond, "status": "active", "iterations": 0, "reason": None, "set_at": ts_ms,
    }
    out["updated_at"] = ts_ms
    reason = att.get("reason")
    out["reason"] = reason[:_MAX_REASON] if isinstance(reason, str) and reason else None
    iterations = att.get("iterations")
    out["iterations"] = (iterations if isinstance(iterations, int) and not isinstance(iterations, bool)
                         else int(out.get("iterations") or 0) + 1)
    if att.get("failed") is True:
        out["status"] = "failed"
    elif met:
        out["status"] = "met"
    else:
        out["status"] = "active"
    for src, dst in (("durationMs", "duration_ms"), ("tokens", "tokens_used")):
        v = att.get(src)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[dst] = int(v)
    return out


def goal_lines(data: bytes) -> list[tuple[dict[str, Any], int]]:
    """The `goal_status` attachments in complete JSONL lines, with their time."""
    out: list[tuple[dict[str, Any], int]] = []
    for line in data.split(b"\n"):
        if GOAL_MARK not in line:
            continue
        try:
            d = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(d, dict) or d.get("type") != "attachment":
            continue
        att = d.get("attachment")
        if isinstance(att, dict) and att.get("type") == "goal_status":
            out.append((att, _ts_ms(d.get("timestamp"), 0)))
    return out


def claude_transcript(home: Path, session_id: str) -> Path | None:
    """`<home>/projects/<cwd slug>/<session id>.jsonl`, wherever the slug is."""
    if not session_id or "/" in session_id or session_id.startswith("."):
        return None
    for p in (home / "projects").glob(f"*/{session_id}.jsonl"):
        return p
    return None


class GoalReader:
    """Incremental reader of one transcript's goal records.

    `scan()` reads only the bytes appended since the last call; a replaced or
    truncated file (new inode, smaller size) is read again from the start, as
    a new epoch, never merged with the old one."""

    def __init__(self) -> None:
        self.path: Path | None = None
        self.pos = 0
        self.ino: int | None = None
        self.tail = b""
        self.goal: dict[str, Any] | None = None

    def reset(self, path: Path | None) -> None:
        self.path, self.pos, self.ino, self.tail, self.goal = path, 0, None, b"", None

    def scan(self) -> bool:
        """Read what was appended; True when the goal changed."""
        path = self.path
        if path is None:
            return False
        try:
            st = os.stat(path)
        except OSError:
            return False
        before = self.goal
        if self.ino != st.st_ino or st.st_size < self.pos:
            self.pos, self.ino, self.tail, self.goal = 0, st.st_ino, b"", None
        if st.st_size == self.pos:
            return self.goal != before
        try:
            with open(path, "rb") as f:
                f.seek(self.pos)
                while True:
                    chunk = f.read(_CHUNK)
                    if not chunk:
                        break
                    self.pos += len(chunk)
                    data = self.tail + chunk
                    cut = data.rfind(b"\n")
                    if cut < 0:
                        self.tail = data
                        continue
                    self.tail = data[cut + 1:]
                    for att, ts in goal_lines(data[:cut]):
                        self.goal = fold_goal(self.goal, att, ts or int(st.st_mtime * 1000))
        except OSError:
            return False
        return self.goal != before
