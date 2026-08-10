"""Filesystem navigation: the hub's path autocomplete and its file tree.

Three RPCs, all stdlib-only and all returning JSON-native values only:

- `list_dir` (agent >= 0.17.0) — subdirectories of a path, for the
  NewSessionWizard autocomplete. Riding the persistent RPC pipe makes it ~1ms;
  the hub falls back to a one-shot ssh `ls` (~0.5s of sshd session setup) for
  older agents.
- `fs_list` / `fs_read` (agent >= 0.25.0), `fs_write` (>= 0.26.0) and
  `fs_mkdir` / `fs_rename` / `fs_delete` (>= 0.27.0) — the file tree in the
  ToolPanel, its editor, and its context menu. Deliberately separate from
  `list_dir` rather than an extension of it: that one is on the hot path of
  every keystroke in the wizard and returns directories only, and widening its
  contract would make a typo in the tree break session creation.

All three tree RPCs are CONTAINED under a caller-supplied root (the session's cwd).
The ssh user can already read anything — the hub hands out shells — so this is
not a privilege boundary; it is there so that a `..` in a path can't quietly
turn a file browser into a way to page through `/etc` by accident.
"""
from __future__ import annotations

import base64
import hashlib
import os
import shutil
import subprocess
import tempfile
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

        # The sha is of the BYTES ON DISK, not of what we return — a truncated
        # read must not be able to produce a token that would later authorise
        # overwriting the whole file with the prefix the editor showed.
        sha = _file_sha(target)
        if binary:
            return {"ok": True, "path": path, "size": size, "binary": True,
                    "encoding": "base64", "content": base64.b64encode(data).decode(),
                    "truncated": truncated, "too_large": False, "sha256": sha}
        return {"ok": True, "path": path, "size": size, "binary": False,
                "encoding": "utf8", "content": data.decode("utf-8", "replace"),
                "truncated": truncated, "too_large": False, "sha256": sha}
    except PermissionError:
        return {"ok": False, "error": "permission denied"}
    except OSError as e:
        return {"ok": False, "error": str(e)}


def _file_sha(path: str) -> str | None:
    """sha256 of a file's bytes, or None if it can't be read."""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(262144), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def fs_write(root: str, path: str, content: str, expected_sha256: str | None = None) -> dict[str, Any]:
    """Write utf-8 text to ONE file under `root`. Agent >= 0.26.0.

    Two rules, both load-bearing on these boxes:

    * **`expected_sha256` is a precondition, not a hint.** A coding agent may
      be writing this very file while someone edits it in the browser; saving
      without checking would silently discard whichever side was slower. A
      mismatch returns `reason: 'stale'` WITHOUT writing, and the caller
      decides (reload / overwrite). Pass None only for a deliberate
      force-overwrite, and `""` for "this file must not exist yet".
    * **The write is atomic** — tmp file in the same directory, fsync, then
      rename. A half-written source file is worse than an unwritten one, and a
      rename within a directory is the only way to guarantee a reader sees
      either the old bytes or the new ones.

    Text only. The editor is for text; shipping arbitrary bytes back through
    the JSON RPC is a different feature with different limits.
    """
    try:
        target = _contained(root, path)
        if target is None:
            return {"ok": False, "error": "path outside the root", "reason": "bad_path"}
        if os.path.isdir(target):
            return {"ok": False, "error": "that is a directory", "reason": "bad_path"}
        if len(content.encode("utf-8", "surrogateescape")) > MAX_TEXT_BYTES:
            return {"ok": False, "error": "file too large to write", "reason": "too_large"}

        exists = os.path.exists(target)
        if expected_sha256 is not None:
            current = _file_sha(target) if exists else ""
            if current != expected_sha256:
                return {
                    "ok": False, "reason": "stale",
                    "error": ("the file was deleted on the VPS" if not exists
                              else "the file changed on the VPS since it was opened"),
                    "sha256": current,
                }

        data = content.encode("utf-8", "surrogateescape")
        directory = os.path.dirname(target) or "."
        fd, tmp = tempfile.mkstemp(prefix=".charon-w-", dir=directory)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            # Preserve the existing mode: an editor must not turn a 755 script
            # into a 600 file just because it saved it.
            if exists:
                try:
                    os.chmod(tmp, os.stat(target).st_mode & 0o7777)
                except OSError:
                    pass
            os.replace(tmp, target)
            tmp = None
        finally:
            if tmp is not None:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

        return {"ok": True, "path": path, "size": len(data), "sha256": _file_sha(target)}
    except PermissionError:
        return {"ok": False, "error": "permission denied", "reason": "error"}
    except OSError as e:
        return {"ok": False, "error": str(e), "reason": "error"}


# ── Tree mutations (agent >= 0.27.0) ────────────────────────────────────────
# The explorer's context menu. Every one of these is contained the same way as
# the reads, and none of them overwrites silently: creating something that
# exists, or renaming onto an existing name, is refused rather than resolved.
# On a box where a coding agent is working in the same tree, "it already
# existed" is information, not an obstacle to route around.

def fs_mkdir(root: str, path: str) -> dict[str, Any]:
    """Create a directory (and any missing parents) under `root`."""
    try:
        target = _contained(root, path)
        if target is None:
            return {"ok": False, "error": "path outside the root", "reason": "bad_path"}
        if os.path.exists(target):
            return {"ok": False, "error": "already exists", "reason": "exists"}
        os.makedirs(target, exist_ok=False)
        return {"ok": True, "path": path}
    except FileExistsError:
        return {"ok": False, "error": "already exists", "reason": "exists"}
    except PermissionError:
        return {"ok": False, "error": "permission denied", "reason": "error"}
    except OSError as e:
        return {"ok": False, "error": str(e), "reason": "error"}


def fs_rename(root: str, path: str, to: str) -> dict[str, Any]:
    """Rename / move within the tree. BOTH ends are contained.

    Refuses to clobber an existing destination: `os.replace` would silently
    delete it, and a rename that eats a file is not something a user can undo
    from here.
    """
    try:
        src = _contained(root, path)
        if src is None:
            return {"ok": False, "error": "path outside the root", "reason": "bad_path"}
        if not os.path.exists(src):
            return {"ok": False, "error": "not found", "reason": "missing"}
        # The destination does not exist yet, so realpath can't resolve it —
        # contain its PARENT and rebuild, which is what actually bounds it.
        dest_rel = (to or "").strip()
        if not dest_rel or "\0" in dest_rel:
            return {"ok": False, "error": "invalid destination", "reason": "bad_path"}
        real_root = os.path.realpath(os.path.expanduser(root))
        dest_abs = os.path.join(real_root, dest_rel) if not os.path.isabs(dest_rel) else dest_rel
        parent = _contained(root, os.path.dirname(os.path.relpath(dest_abs, real_root)) or ".")
        if parent is None or not os.path.isdir(parent):
            return {"ok": False, "error": "destination folder is outside the root", "reason": "bad_path"}
        dest = os.path.join(parent, os.path.basename(dest_abs))
        if os.path.exists(dest):
            return {"ok": False, "error": "a file with that name already exists", "reason": "exists"}
        os.rename(src, dest)
        return {"ok": True, "path": os.path.relpath(dest, real_root)}
    except PermissionError:
        return {"ok": False, "error": "permission denied", "reason": "error"}
    except OSError as e:
        return {"ok": False, "error": str(e), "reason": "error"}


def fs_delete(root: str, path: str, recursive: bool = False) -> dict[str, Any]:
    """Delete a file, or a directory when `recursive`.

    A non-empty directory without `recursive` is refused with
    `reason: 'not_empty'` so the caller can ask the question with the real
    stakes on screen rather than guessing them.
    """
    try:
        target = _contained(root, path)
        if target is None:
            return {"ok": False, "error": "path outside the root", "reason": "bad_path"}
        # Deleting the root itself would take the session's cwd with it.
        if target == os.path.realpath(os.path.expanduser(root)):
            return {"ok": False, "error": "refusing to delete the root folder", "reason": "bad_path"}
        if not os.path.exists(target) and not os.path.islink(target):
            return {"ok": False, "error": "not found", "reason": "missing"}

        if os.path.isdir(target) and not os.path.islink(target):
            if not recursive and os.listdir(target):
                return {"ok": False, "error": "the folder is not empty", "reason": "not_empty"}
            shutil.rmtree(target) if recursive else os.rmdir(target)
        else:
            os.unlink(target)
        return {"ok": True, "path": path}
    except PermissionError:
        return {"ok": False, "error": "permission denied", "reason": "error"}
    except OSError as e:
        return {"ok": False, "error": str(e), "reason": "error"}
