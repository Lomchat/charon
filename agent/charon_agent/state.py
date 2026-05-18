"""Persistance de la liste des sessions connues (~/.charon/state.json).

Format v1 :
{
  "version": 1,
  "sessions": [
    {"session_id": "abc",
     "claude_session_id": "uuid",        # nullable tant que la 1re query n'est pas faite
     "cwd": "/path",
     "name": null,
     "permission_mode": "normal",
     "status": "sleeping"}                # sleeping | error
  ]
}

L'agent ne stocke PAS les messages — Charon a sa DB. On garde juste assez
pour resume au boot.
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
        # Tolérant : remplit les champs manquants
        data.setdefault("version", STATE_VERSION)
        sessions = data.get("sessions")
        if not isinstance(sessions, list):
            data["sessions"] = []
        return data
    except (OSError, json.JSONDecodeError):
        return {"version": STATE_VERSION, "sessions": []}


def save_state(path: Path, sessions: list[dict[str, Any]]) -> None:
    """Écriture atomique : tmp + rename."""
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
