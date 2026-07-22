"""Filesystem navigation for the hub's path autocomplete.

`list_dir` backs the `list_dir` RPC (agent >= 0.17.0): the NewSessionWizard
autocomplete lists subdirectories live while the user types a path. Riding
the persistent RPC pipe makes it ~1ms; the hub falls back to a one-shot ssh
`ls` (~0.5s of sshd per-exec session setup) for older agents. Stdlib-only,
JSON-native return values only.
"""
from __future__ import annotations

import os
from typing import Any

MAX_ENTRIES = 400


def list_dir(raw: str) -> dict[str, Any]:
    """Directories directly under `raw` (absolute or ~-prefixed).

    Mirrors the hub's ssh-fallback shape: exists=False when the target is
    not a listable directory; `resolved` = canonical absolute path
    (~ expanded, `..` collapsed logically — symlinks kept as typed).
    Sorted plain dirs first, dotdirs last. Never raises.
    """
    try:
        p = os.path.expanduser((raw or "").strip() or "~")
        resolved = os.path.abspath(p)
        if not os.path.isdir(resolved):
            return {"ok": True, "exists": False, "resolved": None, "dirs": []}
        names: list[str] = []
        with os.scandir(resolved) as it:
            for e in it:
                try:
                    if e.is_dir(follow_symlinks=True):
                        names.append(e.name)
                except OSError:
                    continue  # broken symlink / racing unlink
        names.sort(key=lambda n: (n.startswith("."), n))
        return {
            "ok": True,
            "exists": True,
            "resolved": resolved,
            "dirs": names[:MAX_ENTRIES],
            "truncated": len(names) > MAX_ENTRIES,
        }
    except PermissionError:
        return {"ok": True, "exists": False, "resolved": None, "dirs": []}
    except OSError as e:
        return {"ok": False, "error": str(e), "exists": False, "dirs": []}
