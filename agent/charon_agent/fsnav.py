"""Filesystem navigation: the hub's path autocomplete and its file tree.

Three RPCs, all stdlib-only and all returning JSON-native values only:

- `list_dir` (agent >= 0.17.0) — subdirectories of a path, for the
  NewSessionWizard autocomplete. Riding the persistent RPC pipe makes it ~1ms;
  the hub falls back to a one-shot ssh `ls` (~0.5s of sshd session setup) for
  older agents.
- `fs_list` / `fs_read` (agent >= 0.25.0) — the read-only file tree in the
  ToolPanel. Deliberately separate from `list_dir` rather than an extension of
  it: that one is on the hot path of every keystroke in the wizard and returns
  directories only, and widening its contract would make a typo in the tree
  break session creation.

Both tree RPCs are CONTAINED under a caller-supplied root (the session's cwd).
The ssh user can already read anything — the hub hands out shells — so this is
not a privilege boundary; it is there so that a `..` in a path can't quietly
turn a file browser into a way to page through `/etc` by accident.
"""
from __future__ import annotations

import base64
import os
import subprocess
from typing import Any

MAX_ENTRIES = 400
# One directory at a time, so this is a per-directory cap, not a repo cap.
MAX_TREE_ENTRIES = 2000
# Text is inlined in the JSON response; binaries are base64'd (+33%). Both are
# well under the 32MB send-queue budget, and a file bigger than this is not
# something a read-only viewer should be shipping over an ssh pipe anyway.
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_BINARY_BYTES = 8 * 1024 * 1024


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


# ── File tree (agent >= 0.25.0) ─────────────────────────────────────────────
def _contained(root: str, target: str) -> str | None:
    """Realpath of `target` if it stays under `root`, else None.

    realpath on BOTH sides so a symlink pointing out of the tree is caught —
    the check has to be on where the path lands, not on how it is spelled.
    """
    try:
        real_root = os.path.realpath(os.path.expanduser(root))
        real = os.path.realpath(os.path.join(real_root, os.path.expanduser(target or "")))
    except (OSError, ValueError):
        return None
    if real != real_root and not real.startswith(real_root + os.sep):
        return None
    return real


def _ignored_names(directory: str, names: list[str]) -> set[str]:
    """Subset of `names` that git ignores, or empty when that can't be answered.

    One `check-ignore` for the whole directory rather than one per entry. Never
    raises and never blocks: a missing git, a non-repo or a slow disk just
    means the tree renders without the dimming.
    """
    if not names:
        return set()
    try:
        env = os.environ.copy()
        env["GIT_OPTIONAL_LOCKS"] = "0"
        env["LC_ALL"] = "C"
        p = subprocess.run(
            ["git", "-C", directory, "check-ignore", "--stdin", "-z"],
            input="\0".join(names).encode() + b"\0",
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=env, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    # exit 0 = some ignored, 1 = none, 128 = not a repo.
    if p.returncode not in (0, 1):
        return set()
    return {n for n in p.stdout.decode("utf-8", "replace").split("\0") if n}


def fs_list(root: str, path: str = "", with_git: bool = False) -> dict[str, Any]:
    """Entries of ONE directory under `root` — the file tree's expand step.

    Lazy per-directory rather than a whole-tree walk: a repo with a
    node_modules would otherwise cost megabytes and seconds on every open, and
    the UI only ever renders what is expanded.

    `with_git` adds the gitignored flag. It is opt-in because it costs a
    subprocess and only the caller knows whether this cwd is in a repo.
    """
    try:
        target = _contained(root, path)
        if target is None:
            return {"ok": False, "error": "path outside the root", "entries": []}
        if not os.path.isdir(target):
            return {"ok": False, "error": "not a directory", "entries": []}

        entries: list[dict[str, Any]] = []
        with os.scandir(target) as it:
            for e in it:
                try:
                    is_dir = e.is_dir(follow_symlinks=True)
                    st = e.stat(follow_symlinks=False)
                    entries.append({
                        "name": e.name,
                        "dir": is_dir,
                        "size": 0 if is_dir else st.st_size,
                        "mtime": int(st.st_mtime),
                        "symlink": e.is_symlink(),
                    })
                except OSError:
                    continue  # broken symlink / racing unlink
        total = len(entries)
        # Directories first, then dotfiles last within each group — the same
        # ordering VS Code's explorer uses, so the tree reads the way people
        # expect without a sort control.
        entries.sort(key=lambda x: (not x["dir"], x["name"].startswith("."), x["name"].lower()))
        entries = entries[:MAX_TREE_ENTRIES]

        if with_git:
            ignored = _ignored_names(target, [e["name"] for e in entries])
            for e in entries:
                e["ignored"] = e["name"] in ignored

        return {
            "ok": True,
            "root": os.path.realpath(os.path.expanduser(root)),
            "path": os.path.relpath(target, os.path.realpath(os.path.expanduser(root))),
            "entries": entries,
            "count": total,
            "truncated": total > MAX_TREE_ENTRIES,
        }
    except PermissionError:
        return {"ok": False, "error": "permission denied", "entries": []}
    except OSError as e:
        return {"ok": False, "error": str(e), "entries": []}


def _looks_binary(head: bytes) -> bool:
    # git's own heuristic: a NUL in the first block.
    return b"\0" in head


def fs_read(root: str, path: str) -> dict[str, Any]:
    """Read ONE file under `root`, for the viewer.

    Text comes back as utf-8 in the JSON; anything with a NUL in its first
    block is base64'd and left for the browser to render (image, audio, video,
    pdf). `truncated` is honest rather than silent — a viewer that shows the
    first 2MB of a 40MB log and says so beats one that appears to show all of it.
    """
    try:
        target = _contained(root, path)
        if target is None:
            return {"ok": False, "error": "path outside the root"}
        if os.path.isdir(target):
            return {"ok": False, "error": "that is a directory"}
        if not os.path.isfile(target):
            return {"ok": False, "error": "not found"}

        size = os.path.getsize(target)
        with open(target, "rb") as f:
            head = f.read(8000)
            binary = _looks_binary(head)
            cap = MAX_BINARY_BYTES if binary else MAX_TEXT_BYTES
            if size > cap:
                return {"ok": True, "path": path, "size": size, "binary": binary,
                        "too_large": True, "content": None, "encoding": None,
                        "truncated": True}
            rest = f.read(cap - len(head) + 1)
        data = head + rest
        truncated = len(data) > cap
        data = data[:cap]

        if binary:
            return {"ok": True, "path": path, "size": size, "binary": True,
                    "encoding": "base64", "content": base64.b64encode(data).decode(),
                    "truncated": truncated, "too_large": False}
        return {"ok": True, "path": path, "size": size, "binary": False,
                "encoding": "utf8", "content": data.decode("utf-8", "replace"),
                "truncated": truncated, "too_large": False}
    except PermissionError:
        return {"ok": False, "error": "permission denied"}
    except OSError as e:
        return {"ok": False, "error": str(e)}
