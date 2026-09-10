"""Filesystem navigation: the hub's path autocomplete and its file tree.

Three RPCs, all stdlib-only and all returning JSON-native values only:

- `list_dir` (agent >= 0.17.0) — subdirectories of a path, for the
  NewSessionWizard autocomplete. Riding the persistent RPC pipe makes it ~1ms;
  the hub falls back to a one-shot ssh `ls` (~0.5s of sshd session setup) for
  older agents.
- `fs_list` / `fs_read` (agent >= 0.25.0), `fs_write` (>= 0.26.0),
  `fs_stat` (>= 0.28.0), `fs_mkdir` / `fs_rename` / `fs_delete` (>= 0.27.0)
  and `fs_symlink` (>= 0.75.0) — the file tree in the
  ToolPanel, its editor, and its context menu. Deliberately separate from
  `list_dir` rather than an extension of it: that one is on the hot path of
  every keystroke in the wizard and returns directories only, and widening its
  contract would make a typo in the tree break session creation.
- `fs_search` (agent >= 0.29.0) — grep across the tree, and find a file by
  name. One RPC for both because they share every parameter that makes a
  search precise (the globs, the case/word/regex switches) and differ only in
  what the pattern is matched against.

All tree RPCs are CONTAINED under a caller-supplied root (the session's cwd),
and containment is judged on how a path is SPELLED (see `contained_path`).
The ssh user can already read anything — the hub hands out shells — so this is
not a privilege boundary; it is there so that a `..` in a path can't quietly
turn a file browser into a way to page through `/etc` by accident.
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
import zipfile
from typing import Any, BinaryIO

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
def contained_path(root: str, target: str) -> str | None:
    """`target` under `root`, or None when its SPELLING leaves the tree.

    Containment is judged on how the path is written — `..` collapsed
    lexically, an absolute path elsewhere refused — and NOT on where it finally
    lands. A symlink placed inside the tree is therefore FOLLOWED, wherever it
    points, which is the entire reason someone puts one in a project: a
    checkout linking to `/srv/shared` has to open, not read as an error.

    Until 0.85.0 this realpath'd both sides, which caught that link too. It
    never was a privilege boundary (the hub hands out shells on the same box),
    only a guard against a stray `..` turning the browser into a tour of
    `/etc` — and the lexical rule keeps exactly that guard. What is returned is
    what callers open, so the kernel resolves the same path judged here.
    """
    if "\0" in (root or "") or "\0" in (target or ""):
        return None
    try:
        real_root = os.path.realpath(os.path.expanduser(root))
        spelled = os.path.join(real_root, os.path.expanduser(target or ""))
    except (OSError, ValueError):
        return None
    resolved = os.path.normpath(spelled)
    if resolved != real_root and not resolved.startswith(real_root + os.sep):
        return None
    return resolved


def contained_entry(root: str, target: str) -> str | None:
    """`contained_path`, for a mutation that acts on ONE directory entry.

    Deleting or renaming must never resolve the final entry: doing so would
    unlink a symlink's target instead of the link, or rename the file behind
    it. Nothing is resolved here, so that holds by construction; this only
    adds the guard that the spelling names an entry at all. The root itself
    comes back — its callers refuse it with a message that says why.
    """
    resolved = contained_path(root, target)
    if resolved is None:
        return None
    name = os.path.basename(resolved)
    if name in ("", ".", ".."):
        return None
    return resolved


def _link_info(target: str) -> dict[str, Any]:
    """Where a symlink points, for the tree's tooltip and the editor header.

    The RAW `readlink` first: it is what the user wrote, what `ls -l` shows,
    and the only form that stays true when the checkout moves. The resolved
    absolute path rides along only when it says something the raw one doesn't
    — it is the answer to "which file am I actually editing".
    """
    if not os.path.islink(target):
        return {"symlink": False}
    try:
        raw = os.readlink(target)
    except OSError:
        return {"symlink": True}
    info: dict[str, Any] = {"symlink": True, "link_target": raw}
    resolved = os.path.realpath(target)
    if resolved != raw:
        info["link_resolved"] = resolved
    return info


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
        target = contained_path(root, path)
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
                    entry = {
                        "name": e.name,
                        "dir": is_dir,
                        "size": 0 if is_dir else st.st_size,
                        "mtime": int(st.st_mtime),
                        "symlink": e.is_symlink(),
                    }
                    if entry["symlink"]:
                        # One readlink per link, none per plain file: the tree
                        # names its destination without a call per hover.
                        try:
                            entry["link_target"] = os.readlink(e.path)
                        except OSError:
                            pass
                    entries.append(entry)
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


def _version_from_stat(st: os.stat_result) -> str:
    """Cheap change token — detects atomic replaces and in-place writes.

    This deliberately is not a content hash: the editor polls it while open,
    and re-reading megabytes every ten seconds to discover that nothing moved
    would turn synchronization into its own performance bug. Saves remain
    sha-gated, so this token is only an early-notification hint, never write
    authorization.
    """
    return f"{st.st_dev:x}:{st.st_ino:x}:{st.st_size:x}:{st.st_mtime_ns:x}"


def fs_stat(root: str, path: str) -> dict[str, Any]:
    """Cheap version probe for one open editor (agent >= 0.28.0)."""
    try:
        target = contained_path(root, path)
        if target is None:
            return {"ok": False, "error": "path outside the root"}
        # `lexists`, so a broken link still reports what it points at — that
        # is exactly the case where the editor has to explain itself.
        if not os.path.exists(target):
            return {"ok": True, "path": path, "exists": False, "version": None,
                    **_link_info(target)}
        if not os.path.isfile(target):
            return {"ok": False, "error": "not a file"}
        st = os.stat(target)
        return {
            "ok": True, "path": path, "exists": True,
            "size": st.st_size, "mtime_ns": st.st_mtime_ns,
            "version": _version_from_stat(st),
            **_link_info(target),
        }
    except PermissionError:
        return {"ok": False, "error": "permission denied"}
    except OSError as e:
        return {"ok": False, "error": str(e)}


def fs_read(root: str, path: str) -> dict[str, Any]:
    """Read ONE file under `root`, for the viewer.

    Text comes back as utf-8 in the JSON; anything with a NUL in its first
    block is base64'd and left for the browser to render (image, audio, video,
    pdf). `truncated` is honest rather than silent — a viewer that shows the
    first 2MB of a 40MB log and says so beats one that appears to show all of it.
    """
    try:
        target = contained_path(root, path)
        if target is None:
            return {"ok": False, "error": "path outside the root"}
        if os.path.isdir(target):
            return {"ok": False, "error": "that is a directory"}
        if not os.path.isfile(target):
            return {"ok": False, "error": "not found"}

        link = _link_info(target)
        size = os.path.getsize(target)
        with open(target, "rb") as f:
            head = f.read(8000)
            binary = _looks_binary(head)
            cap = MAX_BINARY_BYTES if binary else MAX_TEXT_BYTES
            if size > cap:
                st = os.stat(target)
                return {"ok": True, "path": path, "size": size, "binary": binary,
                        "too_large": True, "content": None, "encoding": None,
                        "truncated": True, "version": _version_from_stat(st), **link}
            rest = f.read(cap - len(head) + 1)
        data = head + rest
        truncated = len(data) > cap
        data = data[:cap]

        # The sha is of the BYTES ON DISK, not of what we return — a truncated
        # read must not be able to produce a token that would later authorise
        # overwriting the whole file with the prefix the editor showed.
        sha = _file_sha(target)
        version = _version_from_stat(os.stat(target))
        if binary:
            return {"ok": True, "path": path, "size": size, "binary": True,
                    "encoding": "base64", "content": base64.b64encode(data).decode(),
                    "truncated": truncated, "too_large": False, "sha256": sha,
                    "version": version, **link}
        return {"ok": True, "path": path, "size": size, "binary": False,
                "encoding": "utf8", "content": data.decode("utf-8", "replace"),
                "truncated": truncated, "too_large": False, "sha256": sha,
                "version": version, **link}
    except PermissionError:
        return {"ok": False, "error": "permission denied"}
    except OSError as e:
        return {"ok": False, "error": str(e)}


# Dedicated CLI streaming exit codes. This path deliberately does NOT ride
# the line-delimited JSON-RPC connection: base64/JSON would add 33% and force
# either the agent or hub to hold the file in memory, which is untenable for
# multi-gigabyte workspace artifacts.
STREAM_BAD_PATH = 20
STREAM_MISSING = 21
STREAM_NOT_FILE = 22
STREAM_STALE = 23
STREAM_BAD_RANGE = 24
STREAM_IO_ERROR = 25
STREAM_NOT_DIRECTORY = 26


def stream_file_to(
    root: str,
    path: str,
    output: BinaryIO,
    *,
    offset: int = 0,
    length: int | None = None,
    expected_version: str | None = None,
) -> tuple[int, str | None]:
    """Copy one contained file range to a binary output without buffering it.

    Used only by ``charon-agent --stream-file`` over a dedicated SSH channel.
    ``expected_version`` is the preceding ``fs_stat`` token: checking it after
    open keeps the HTTP Content-Length/Range metadata tied to the exact inode
    being streamed instead of silently serving a replacement with stale
    headers.
    """
    if offset < 0 or length is not None and length < 0:
        return STREAM_BAD_RANGE, "invalid byte range"
    target = contained_path(root, path)
    if target is None:
        return STREAM_BAD_PATH, "path outside the root"
    try:
        with open(target, "rb", buffering=0) as source:
            st = os.fstat(source.fileno())
            if not stat.S_ISREG(st.st_mode):
                return STREAM_NOT_FILE, "not a regular file"
            current_version = _version_from_stat(st)
            if expected_version is not None and current_version != expected_version:
                return STREAM_STALE, "file changed before the download started"
            if offset > st.st_size:
                return STREAM_BAD_RANGE, "range starts beyond end of file"
            remaining = st.st_size - offset if length is None else length
            if offset + remaining > st.st_size:
                return STREAM_BAD_RANGE, "range extends beyond end of file"

            source.seek(offset)
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    return STREAM_IO_ERROR, "file became shorter during download"
                try:
                    output.write(chunk)
                except BrokenPipeError:
                    # Browser cancellation closes SSH stdout. It is not an
                    # agent failure and must stop reading the disk promptly.
                    return 0, None
                remaining -= len(chunk)
            try:
                output.flush()
            except BrokenPipeError:
                return 0, None
            return 0, None
    except FileNotFoundError:
        return STREAM_MISSING, "file not found"
    except PermissionError:
        return STREAM_IO_ERROR, "permission denied"
    except IsADirectoryError:
        return STREAM_NOT_FILE, "not a regular file"
    except OSError as e:
        return STREAM_IO_ERROR, str(e)


def _zip_info(name: str, st: os.stat_result, *, directory: bool = False) -> zipfile.ZipInfo:
    """Build one Unix-aware, timestamp-safe archive member."""
    when = time.localtime(st.st_mtime)
    # ZIP's DOS timestamp has a deliberately narrow representable range.
    year = min(2107, max(1980, when.tm_year))
    member = name.rstrip("/") + "/" if directory else name
    info = zipfile.ZipInfo(
        member,
        (year, when.tm_mon, when.tm_mday, when.tm_hour, when.tm_min, when.tm_sec),
    )
    info.create_system = 3  # Unix: external_attr carries the real file type/mode.
    info.external_attr = (st.st_mode & 0xFFFF) << 16
    if directory:
        info.external_attr |= 0x10
        info.compress_type = zipfile.ZIP_STORED
    else:
        info.compress_type = zipfile.ZIP_DEFLATED
    return info


def stream_directory_zip_to(root: str, path: str, output: BinaryIO) -> tuple[int, str | None]:
    """Stream one contained directory as a ZIP without a temp archive.

    The selected directory is the archive's top-level member. Regular files
    are opened with ``O_NOFOLLOW`` where available; symlinks are stored as
    symlinks instead of dereferenced, so a link cannot pull an outside tree
    into the download or create a recursive walk. ``zipfile`` writes data
    descriptors when ``output`` is unseekable, which makes stdout a genuine
    streaming target even though the central directory lands at EOF.
    """
    target = contained_path(root, path)
    if target is None:
        return STREAM_BAD_PATH, "path outside the root"
    if not os.path.exists(target):
        return STREAM_MISSING, "directory not found"
    if not os.path.isdir(target):
        return STREAM_NOT_DIRECTORY, "not a directory"

    archive_root = os.path.basename(os.path.normpath(target)) or "archive"

    def add_tree(archive: zipfile.ZipFile, directory: str, archive_dir: str) -> None:
        try:
            directory_stat = os.stat(directory, follow_symlinks=False)
        except FileNotFoundError:
            return  # A concurrently removed subtree simply misses the snapshot.
        archive.writestr(_zip_info(archive_dir, directory_stat, directory=True), b"")
        try:
            with os.scandir(directory) as scan:
                entries = sorted(scan, key=lambda entry: entry.name)
        except FileNotFoundError:
            return

        for entry in entries:
            member = f"{archive_dir}/{entry.name}"
            try:
                entry_stat = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(entry_stat.st_mode):
                    info = _zip_info(member, entry_stat)
                    info.compress_type = zipfile.ZIP_STORED
                    archive.writestr(
                        info,
                        os.readlink(entry.path).encode("utf-8", "surrogateescape"),
                    )
                    continue
                if stat.S_ISDIR(entry_stat.st_mode):
                    add_tree(archive, entry.path, member)
                    continue
                if not stat.S_ISREG(entry_stat.st_mode):
                    continue  # Never read devices, sockets or FIFOs into a ZIP.

                flags = os.O_RDONLY
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                fd = os.open(entry.path, flags)
                try:
                    opened_stat = os.fstat(fd)
                    if not stat.S_ISREG(opened_stat.st_mode):
                        continue
                    info = _zip_info(member, opened_stat)
                    info.file_size = opened_stat.st_size
                    with os.fdopen(fd, "rb") as source:
                        fd = -1
                        with archive.open(
                            info, "w",
                            force_zip64=opened_stat.st_size >= 2 * 1024 * 1024 * 1024,
                        ) as destination:
                            while True:
                                chunk = source.read(1024 * 1024)
                                if not chunk:
                                    break
                                destination.write(chunk)
                finally:
                    if fd >= 0:
                        os.close(fd)
            except FileNotFoundError:
                continue

    try:
        with zipfile.ZipFile(
            output, mode="w", compression=zipfile.ZIP_DEFLATED,
            compresslevel=6, allowZip64=True,
        ) as archive:
            add_tree(archive, target, archive_root)
        output.flush()
        return 0, None
    except BrokenPipeError:
        # The HTTP client cancelled; stopping the disk walk is success from the
        # daemon's perspective and avoids a noisy agent error.
        return 0, None
    except PermissionError:
        return STREAM_IO_ERROR, "permission denied"
    except OSError as e:
        return STREAM_IO_ERROR, str(e)


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

    A symlink is written THROUGH, never over: the atomic rename would otherwise
    replace the link with a regular file, so saving `CLAUDE.md` would quietly
    unpair it from the `AGENTS.md` it was created to share (§14.80), and the
    bytes the editor showed would stop being the bytes anyone else reads.

    Text only. The editor is for text; shipping arbitrary bytes back through
    the JSON RPC is a different feature with different limits.
    """
    try:
        target = contained_path(root, path)
        if target is None:
            return {"ok": False, "error": "path outside the root", "reason": "bad_path"}
        if os.path.islink(target):
            target = os.path.realpath(target)
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

        st = os.stat(target)
        return {"ok": True, "path": path, "size": len(data),
                "sha256": _file_sha(target), "version": _version_from_stat(st)}
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
        target = contained_path(root, path)
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

    Like `fs_delete`, this moves the DIRECTORY ENTRY and nothing else: nothing
    is resolved, so renaming a symlink renames the link and leaves what it
    points at exactly where it is, under the name it already had. `lexists` on
    both ends for the same reason — a broken link is still an entry the user
    can see and move, and still one a rename must not silently eat.
    """
    try:
        src = contained_entry(root, path)
        if src is None:
            return {"ok": False, "error": "path outside the root", "reason": "bad_path"}
        if src == os.path.realpath(os.path.expanduser(root)):
            return {"ok": False, "error": "refusing to rename the root folder", "reason": "bad_path"}
        if not os.path.lexists(src):
            return {"ok": False, "error": "not found", "reason": "missing"}
        # The destination does not exist yet, so realpath can't resolve it —
        # contain its PARENT and rebuild, which is what actually bounds it.
        dest_rel = (to or "").strip()
        if not dest_rel or "\0" in dest_rel:
            return {"ok": False, "error": "invalid destination", "reason": "bad_path"}
        real_root = os.path.realpath(os.path.expanduser(root))
        dest_abs = os.path.join(real_root, dest_rel) if not os.path.isabs(dest_rel) else dest_rel
        parent = contained_path(root, os.path.dirname(os.path.relpath(dest_abs, real_root)) or ".")
        if parent is None or not os.path.isdir(parent):
            return {"ok": False, "error": "destination folder is outside the root", "reason": "bad_path"}
        dest = os.path.join(parent, os.path.basename(dest_abs))
        if os.path.lexists(dest):
            return {"ok": False, "error": "a file with that name already exists", "reason": "exists"}
        os.rename(src, dest)
        return {"ok": True, "path": os.path.relpath(dest, real_root)}
    except PermissionError:
        return {"ok": False, "error": "permission denied", "reason": "error"}
    except OSError as e:
        return {"ok": False, "error": str(e), "reason": "error"}


def fs_symlink(root: str, path: str, to: str) -> dict[str, Any]:
    """Create a relative same-directory symlink to one existing file.

    The explorer uses this for the conventional ``AGENTS.md`` / ``CLAUDE.md``
    pair.  The RPC stays generally useful, but deliberately permits only a
    file in the same directory: a relative target keeps the checkout movable,
    containment stays obvious, and a browser action cannot manufacture a link
    into another part of the workspace by mistake.  The destination is never
    replaced, including when it is already a broken symlink.
    """
    try:
        source_raw = (path or "").strip()
        link_raw = (to or "").strip()
        if not source_raw or not link_raw or "\0" in source_raw or "\0" in link_raw:
            return {"ok": False, "error": "invalid path", "reason": "bad_path"}

        real_root = os.path.realpath(os.path.expanduser(root))
        source_abs = source_raw if os.path.isabs(source_raw) else os.path.join(real_root, source_raw)
        link_abs = link_raw if os.path.isabs(link_raw) else os.path.join(real_root, link_raw)
        source_name = os.path.basename(source_abs)
        link_name = os.path.basename(link_abs)
        if source_name in ("", ".", "..") or link_name in ("", ".", ".."):
            return {"ok": False, "error": "invalid path", "reason": "bad_path"}

        source_parent_rel = os.path.dirname(os.path.relpath(source_abs, real_root)) or "."
        link_parent_rel = os.path.dirname(os.path.relpath(link_abs, real_root)) or "."
        source_parent = contained_path(root, source_parent_rel)
        link_parent = contained_path(root, link_parent_rel)
        if source_parent is None or link_parent is None:
            return {"ok": False, "error": "path outside the root", "reason": "bad_path"}
        if not os.path.isdir(source_parent) or not os.path.isdir(link_parent):
            return {"ok": False, "error": "folder not found", "reason": "missing"}
        if source_parent != link_parent:
            return {
                "ok": False,
                "error": "a symlink can only target a file in the same folder",
                "reason": "bad_path",
            }

        source_spelled = os.path.join(source_parent, source_name)
        source = contained_path(root, source_spelled)
        if source is None:
            return {"ok": False, "error": "symlink target is outside the root", "reason": "bad_path"}
        if not os.path.isfile(source):
            return {"ok": False, "error": "source file not found", "reason": "missing"}

        link = os.path.join(link_parent, link_name)
        if os.path.lexists(link):
            return {"ok": False, "error": "a file with that name already exists", "reason": "exists"}
        os.symlink(source_name, link)
        return {
            "ok": True,
            "path": os.path.relpath(link, real_root),
            "target": source_name,
        }
    except FileExistsError:
        return {"ok": False, "error": "a file with that name already exists", "reason": "exists"}
    except PermissionError:
        return {"ok": False, "error": "permission denied", "reason": "error"}
    except OSError as e:
        return {"ok": False, "error": str(e), "reason": "error"}


def fs_delete(root: str, path: str, recursive: bool = False,
              expected_sha256: str | None = None) -> dict[str, Any]:
    """Delete a file, or a directory when `recursive`.

    A non-empty directory without `recursive` is refused with
    `reason: 'not_empty'` so the caller can ask the question with the real
    stakes on screen rather than guessing them.

    `expected_sha256` gives file deletion the same stale-write protection as
    fs_write. It is used by edit revert: if an agent changed the file after the
    snapshot, the older UI action must not delete the newer work.
    """
    try:
        # Contained without resolving anything: `os.unlink` on the spelled
        # path removes the link itself, where following it would delete the
        # linked file and leave a broken link in the tree.
        target = contained_entry(root, path)
        if target is None:
            return {"ok": False, "error": "path outside the root", "reason": "bad_path"}
        # Deleting the root itself would take the session's cwd with it.
        if target == os.path.realpath(os.path.expanduser(root)):
            return {"ok": False, "error": "refusing to delete the root folder", "reason": "bad_path"}
        if expected_sha256 is not None:
            current = _file_sha(target) if os.path.isfile(target) else ""
            if current != expected_sha256:
                return {
                    "ok": False, "reason": "stale",
                    "error": ("the file was deleted on the VPS" if not os.path.exists(target)
                              else "the file changed on the VPS since the snapshot"),
                    "sha256": current,
                }
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


# ── Search (agent >= 0.29.0) ────────────────────────────────────────────────
# Every bound here exists so that one search can never become the reason a
# session stops answering: the hub gives up on an RPC after 60s, the walk runs
# in a thread, and a repo with a 40MB bundle in it is a normal repo.
SEARCH_BUDGET_S = 20.0
SEARCH_MAX_FILE_BYTES = 1024 * 1024
SEARCH_HEAD_BYTES = 8000
# Enumeration is cheap — 20k paths off a warm cache is under a second — so the
# real bound is the clock, not this. It is set high enough that a folder OF
# projects (/srv, /var/www) still gets a complete answer, because a cap hit
# during enumeration truncates in DIRECTORY order, which is nobody's idea of
# relevance: the first 20k version of this returned zero hits on a tree whose
# matches all lived past the cut.
SEARCH_MAX_SCAN = 200_000          # candidate files enumerated
SEARCH_MAX_FILES = 500             # files carried back in the answer
SEARCH_MAX_RESULTS = 2000          # matches carried back in the answer
SEARCH_MAX_PER_FILE = 100
SEARCH_MAX_PER_LINE = 20
SEARCH_LINE_CHARS = 320            # a minified bundle is one 2MB line
SEARCH_LEAD_CHARS = 40

# What a search means by "the project", when git is not there to say. Not a
# security list — a relevance one: nobody looking for their own code wants the
# first 2000 hits to come from a dependency they never wrote.
DEFAULT_EXCLUDE_DIRS = frozenset({
    ".git", ".hg", ".svn", "node_modules", "bower_components", ".next",
    "dist", "build", "out", "target", "vendor", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".cache", ".venv", "venv", "env",
    "site-packages", "coverage", ".nyc_output", ".idea", ".gradle",
    ".terraform", ".turbo", ".parcel-cache", ".svelte-kit",
})
# `.git` is excluded even with the defaults off: its contents are not text a
# human ever wants back from a search, and a packed repo alone would eat the
# whole scan budget.
ALWAYS_SKIP_DIRS = frozenset({".git"})


def _glob_to_regex(pat: str) -> str:
    """One glob segment → regex source (unanchored), `/`-aware.

    `*` and `?` stop at a separator, `**` crosses them: the rule from
    .gitignore and VS Code, which is the only one users have already learned.
    """
    out: list[str] = []
    i, n = 0, len(pat)
    while i < n:
        c = pat[i]
        if c == "*":
            if pat.startswith("**", i):
                j = i + 2
                if j < n and pat[j] == "/":
                    out.append("(?:[^/]+/)*")
                    i = j + 1
                else:
                    out.append(".*")
                    i = j
                continue
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "{":
            j = pat.find("}", i)
            if j == -1:
                out.append(re.escape(c))
                i += 1
                continue
            alts = pat[i + 1:j].split(",")
            out.append("(?:" + "|".join(_glob_to_regex(a) for a in alts) + ")")
            i = j + 1
        elif c == "[":
            j = pat.find("]", i + 1)
            if j == -1:
                out.append(re.escape(c))
                i += 1
                continue
            body = pat[i + 1:j]
            body = ("^" + body[1:]) if body.startswith("!") else body
            out.append("[" + body.replace("\\", "\\\\") + "]")
            i = j + 1
        else:
            out.append(re.escape(c))
            i += 1
    return "".join(out)


def _split_globs(spec: str) -> list[str]:
    """Split a glob list on the separators, NOT on the commas inside `{a,b}`.

    Both spellings are things people type — `*.ts, *.tsx` and `*.{ts,tsx}` —
    and a naive split turns the second one into two patterns that match
    nothing, which looks exactly like "your search found nothing".
    """
    out: list[str] = []
    buf: list[str] = []
    depth = 0
    for ch in (spec or "").replace("\n", ","):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            out.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    out.append("".join(buf))
    return out


def _compile_globs(spec: str) -> list[re.Pattern[str]]:
    """Comma- or newline-separated globs → matchers against a root-relative path.

    Two conveniences that are load-bearing for the field to feel like VS
    Code's: a pattern with no `/` matches at any depth (`*.ts`), and a pattern
    that names a folder also covers everything under it (`tests` finds
    `tests/a/b.py`). A malformed glob degrades to a literal and is never fatal
    — the user is still in the middle of typing it.
    """
    pats: list[re.Pattern[str]] = []
    for raw in _split_globs(spec):
        p = raw.strip().strip("/")
        if not p:
            continue
        body = _glob_to_regex(p)
        if "/" not in p:
            body = "(?:[^/]+/)*" + body
        try:
            pats.append(re.compile("(?s:" + body + r")(?:/.*)?\Z"))
        except re.error:
            continue
    return pats


def _matches_any(rel: str, pats: list[re.Pattern[str]]) -> bool:
    return any(p.match(rel) for p in pats)


def _walk_search_files(root: str, skip: frozenset[str],
                       deadline: float) -> tuple[list[str], set[str], bool]:
    """Every candidate file under `root`, plus the repo roots seen on the way.

    The walk is the ONLY enumeration, deliberately. `git ls-files` was the
    obvious shortcut and it is wrong here: it does not descend into a nested
    checkout, so a folder OF projects (/srv, /var/www — a normal cwd on these
    boxes, cf. §14.83) answered with the handful of files that happened to live
    outside the sub-repos. A search that quietly skips 95% of the tree is worse
    than a slow one.

    Repo roots are picked up for free — a directory holding a `.git` entry is
    one — and gitignore is applied afterwards, per repo, by `_drop_gitignored`.

    Symlinks are neither followed nor returned: a search that walks into a link
    either leaves the root or loops, and neither is worth a duplicate hit.
    """
    out: list[str] = []
    repos: set[str] = set()
    stack = [root]
    truncated = False
    while stack:
        if len(out) >= SEARCH_MAX_SCAN or time.monotonic() > deadline:
            truncated = True
            break
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    try:
                        if e.name == ".git":
                            # A file here means a worktree/submodule; both are
                            # repos as far as check-ignore is concerned.
                            repos.add(os.path.relpath(d, root))
                            continue
                        if e.is_dir(follow_symlinks=False):
                            if e.name in skip:
                                continue
                            stack.append(e.path)
                        elif e.is_file(follow_symlinks=False):
                            out.append(os.path.relpath(e.path, root))
                            if len(out) >= SEARCH_MAX_SCAN:
                                truncated = True
                                break
                    except OSError:
                        continue
        except OSError:
            continue
    return out, repos, truncated


def _check_ignore_batch(repo: str, rels: list[str], timeout: float) -> set[str] | None:
    """Which of `rels` git ignores in `repo`, or None when it can't answer."""
    if not rels:
        return set()
    try:
        env = os.environ.copy()
        env["GIT_OPTIONAL_LOCKS"] = "0"
        env["LC_ALL"] = "C"
        p = subprocess.run(
            ["git", "-C", repo, "check-ignore", "--stdin", "-z"],
            input="\0".join(rels).encode("utf-8", "surrogateescape") + b"\0",
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=env, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode not in (0, 1):  # 128 = not a repo, 127 = no git
        return None
    return {n for n in p.stdout.decode("utf-8", "replace").split("\0") if n}


def _nearest_repo(rel_dir: str, repos: set[str]) -> str | None:
    """The innermost repo containing `rel_dir` ('' = the search root itself)."""
    cur = rel_dir
    while True:
        if cur in repos:
            return cur
        if cur in ("", "."):
            return None
        nxt = os.path.dirname(cur)
        if nxt == cur:
            return None
        cur = nxt


def _drop_gitignored(root: str, rels: list[str], repos: set[str],
                     deadline: float) -> tuple[list[str], bool]:
    """Remove what git ignores, one `check-ignore` per repo. (kept, applied?)

    Applied AFTER the walk rather than instead of it: the walk is what
    guarantees completeness, and this is what makes a search inside a project
    return the code somebody wrote instead of whatever a build step left
    behind. .gitignore is the answer the project already gave to "what is
    mine", so it is not this feature's business to invent a second one.

    Any failure (no git, a timeout, a directory that stopped being a repo
    between the walk and now) keeps everything: dropping files because a
    subprocess misbehaved would be an invisible way to lose results.
    """
    if not repos or not rels:
        return rels, False
    # "" (the root is itself a repo) normalises out of relpath as "."
    repos = {("" if r in (".", "") else r) for r in repos}
    by_repo: dict[str, list[str]] = {}
    for rel in rels:
        repo = _nearest_repo(os.path.dirname(rel), repos)
        if repo is None:
            continue
        by_repo.setdefault(repo, []).append(rel)
    if not by_repo:
        return rels, False

    ignored: set[str] = set()
    applied = False
    for repo, paths in by_repo.items():
        left = deadline - time.monotonic()
        if left <= 0.5:
            break
        abs_repo = os.path.join(root, repo) if repo else root
        # check-ignore speaks the repo's own relative paths.
        inner = [p[len(repo) + 1:] if repo else p for p in paths]
        got = _check_ignore_batch(abs_repo, inner, min(left, 20.0))
        if got is None:
            continue
        applied = True
        if not got:
            continue
        prefix = f"{repo}/" if repo else ""
        ignored.update(prefix + n for n in got)
    if not applied:
        return rels, False
    return [r for r in rels if r not in ignored], True


def _build_matcher(query: str, regex: bool, case_sensitive: bool,
                   whole_word: bool) -> re.Pattern[str] | str:
    """Compiled pattern, or the error string to hand back to the user."""
    body = query if regex else re.escape(query)
    if whole_word:
        body = r"\b(?:" + body + r")\b"
    try:
        return re.compile(body, 0 if case_sensitive else re.IGNORECASE)
    except re.error as e:
        return f"invalid regular expression: {e}"


def _line_matches(line: str, rx: re.Pattern[str], lineno: int) -> dict[str, Any] | None:
    """One transcript line for the result list, windowed around the first hit."""
    cols: list[tuple[int, int]] = []
    for m in rx.finditer(line):
        if m.end() == m.start():
            continue  # a zero-width pattern would report every column
        cols.append((m.start(), m.end()))
        if len(cols) >= SEARCH_MAX_PER_LINE:
            break
    if not cols:
        return None
    start = max(0, cols[0][0] - SEARCH_LEAD_CHARS)
    end = start + SEARCH_LINE_CHARS
    return {
        "line": lineno,
        "col": cols[0][0] + 1,
        "text": line[start:end],
        "ranges": [[a - start, b - start] for a, b in cols if a >= start and b <= end],
        "clipped": start > 0,
    }


def fs_search(root: str, query: str, mode: str = "text", regex: bool = False,
              case_sensitive: bool = False, whole_word: bool = False,
              include: str = "", exclude: str = "",
              use_default_excludes: bool = True,
              max_results: int = SEARCH_MAX_RESULTS) -> dict[str, Any]:
    """Search the tree under `root`: text inside files, or file names.

    Contained exactly like the rest of this module, and read-only by
    construction. Everything it returns is bounded and every bound is reported,
    because a silently truncated search reads as "there is nothing else" — the
    one answer a search must never give by accident.
    """
    started = time.monotonic()
    deadline = started + SEARCH_BUDGET_S
    mode = "file" if mode == "file" else "text"

    def done(**extra: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "ok": True, "mode": mode, "files": [], "total_files": 0,
            "total_matches": 0, "scanned": 0, "truncated": False,
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
        base.update(extra)
        return base

    try:
        real_root = contained_path(root, "")
        if real_root is None or not os.path.isdir(real_root):
            return {"ok": False, "error": "the folder is not readable",
                    "reason": "bad_path", "files": []}
        if not query:
            return done(root=real_root)

        rx = _build_matcher(query, regex, case_sensitive, whole_word)
        if isinstance(rx, str):
            return {"ok": False, "error": rx, "reason": "bad_query", "files": []}

        inc = _compile_globs(include)
        exc = _compile_globs(exclude)
        skip = (DEFAULT_EXCLUDE_DIRS if use_default_excludes else frozenset()) | ALWAYS_SKIP_DIRS

        names, repos, truncated = _walk_search_files(real_root, skip, deadline)
        names, ignores_applied = _drop_gitignored(real_root, names, repos, deadline)
        source = "git" if ignores_applied else "walk"
        names.sort()

        cap = max(1, min(int(max_results or SEARCH_MAX_RESULTS), SEARCH_MAX_RESULTS))
        files: list[dict[str, Any]] = []
        total_matches = 0
        scanned = 0

        for rel in names:
            if rel.startswith(".." + os.sep) or rel.startswith("../"):
                continue
            if inc and not _matches_any(rel, inc):
                continue
            if exc and _matches_any(rel, exc):
                continue
            if time.monotonic() > deadline:
                truncated = True
                break
            if len(files) >= SEARCH_MAX_FILES or total_matches >= cap:
                truncated = True
                break

            target = os.path.join(real_root, rel)
            try:
                st = os.stat(target, follow_symlinks=False)
            except OSError:
                continue
            # lstat, so a symlink is not a regular file here — deliberate: a
            # link either points back inside (a duplicate hit) or outside the
            # root (a hit the caller never asked for).
            if not stat.S_ISREG(st.st_mode):
                continue

            if mode == "file":
                scanned += 1
                if rx.search(rel):
                    files.append({"path": rel, "size": st.st_size,
                                  "mtime": int(st.st_mtime), "count": 0,
                                  "matches": [], "truncated": False})
                    total_matches += 1
                continue

            if st.st_size > SEARCH_MAX_FILE_BYTES or st.st_size == 0:
                continue
            try:
                with open(target, "rb") as f:
                    head = f.read(SEARCH_HEAD_BYTES)
                    if _looks_binary(head):
                        continue
                    data = head + f.read(SEARCH_MAX_FILE_BYTES - len(head))
            except OSError:
                continue
            scanned += 1
            text = data.decode("utf-8", "replace")
            if not rx.search(text):
                continue  # one scan of the blob before paying for the split

            matches: list[dict[str, Any]] = []
            file_truncated = False
            for lineno, line in enumerate(text.splitlines(), 1):
                hit = _line_matches(line, rx, lineno)
                if hit is None:
                    continue
                matches.append(hit)
                total_matches += len(hit["ranges"]) or 1
                if len(matches) >= SEARCH_MAX_PER_FILE or total_matches >= cap:
                    file_truncated = len(matches) >= SEARCH_MAX_PER_FILE
                    break
            if matches:
                files.append({"path": rel, "size": st.st_size,
                              "mtime": int(st.st_mtime), "count": len(matches),
                              "matches": matches, "truncated": file_truncated})

        return done(root=real_root, files=files, total_files=len(files),
                    total_matches=total_matches, scanned=scanned,
                    truncated=truncated, source=source)
    except PermissionError:
        return {"ok": False, "error": "permission denied", "reason": "error", "files": []}
    except (OSError, ValueError, re.error) as e:
        return {"ok": False, "error": str(e), "reason": "error", "files": []}
