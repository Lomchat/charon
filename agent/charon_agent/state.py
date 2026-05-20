"""Persistence of the list of known sessions (~/.charon/state.json).

Format v1:
{
  "version": 1,
  "sessions": [
    {"session_id": "abc",
     "claude_session_id": "uuid",        # nullable until the 1st query has been made
     "cwd": "/path",
     "name": null,
     "permission_mode": "normal",
     "status": "sleeping"}                # sleeping | error
  ]
}

The agent does NOT store messages — Charon has its DB. We keep just enough
to resume at boot.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


STATE_VERSION = 1


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": STATE_VERSION, "sessions": []}
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            return {"version": STATE_VERSION, "sessions": []}
        # Tolerant: fills in missing fields
        data.setdefault("version", STATE_VERSION)
        sessions = data.get("sessions")
        if not isinstance(sessions, list):
            data["sessions"] = []
        return data
    except (OSError, json.JSONDecodeError):
        return {"version": STATE_VERSION, "sessions": []}


def save_state(path: Path, sessions: list[dict[str, Any]]) -> None:
    """Atomic write: tmp + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {"version": STATE_VERSION, "sessions": sessions}
    fd, tmp_path = tempfile.mkstemp(
        prefix=".state.", suffix=".json.tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
