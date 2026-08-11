"""Git working tree inspection + commit/push, for the hub's Source Control panel.

Backs the `git_*` RPCs (agent >= 0.24.0). The hub shows a dirty-count chip next
to a session's cwd and a `git` tab in the ToolPanel; both read `git_status`,
which is polled while a session is on screen. Riding the persistent RPC pipe
makes that ~free (one already-open ssh multiplex, no per-call sshd session
setup), which is the whole reason this lives agent-side rather than as a pile
of `sshExec` calls: there is deliberately NO ssh fallback, because duplicating
the porcelain-v2 parser hub-side is the actual cost (cf. CLAUDE.md §14.76).

Stdlib only. Every entry point returns a JSON-native dict and NEVER raises —
a broken repo, a missing binary or a hung hook must degrade into `ok: False`
with a machine-readable `reason`, never into a -32603 the UI can't explain.

Safety rules baked in here, not in the caller:
  * WRITE surface is an allow-list: add+commit, push, pull --rebase, discard.
    No `reset --hard`, no force push, no rebase -i, no branch switching. The
    working tree is one an agent may be writing to RIGHT NOW, so a discard is
    not the locally-reversible thing it is in an editor.
  * Every caller-supplied path is validated to stay inside the repo root
    (`_safe_rel`), then passed after `--`. No shell anywhere: argv only.
  * Nothing may block forever. Git can wait on a credential prompt, an ssh
    passphrase or a pre-commit hook; the env below turns the first two into
    immediate errors and every run is `timeout=`-bounded.
"""
from __future__ import annotations

import os
import subprocess
import time
from typing import Any, Iterable

# Read ops are local and fast; a commit may run hooks; push/pull hit the
# network. Exceeding these returns reason='timeout' rather than wedging the
# RPC (the hub's own call timeout is 60s — keep READ ops well under it).
READ_TIMEOUT_S = 20
COMMIT_TIMEOUT_S = 120
# > the hub's 60s RPC timeout on purpose: a slow push must keep going and
# LAND, even though the hub stops waiting for the answer. Losing the answer is
# recoverable (the next status poll shows ahead=0), killing the push is not.
NET_TIMEOUT_S = 170

MAX_FILES = 2000            # entries returned by git_status
MAX_PATCH_BYTES = 1_500_000  # per-file patch cap (git_diff)
MAX_MESSAGE_CHARS = 8000
MAX_UNTRACKED_SCAN = 500     # untracked files we bother line-counting
MAX_UNTRACKED_SCAN_BYTES = 1_000_000

# ── Multi-repo workspace (git_workspace) ────────────────────────────────────
# A session is frequently opened on a folder OF projects (`/srv`,
# `/var/www/html`) rather than on a checkout. `rev-parse --show-toplevel` only
# walks UP, so that folder answered "not a repo" with ten repos underneath it.
# These bound the scan that fixes it — the panel polls every 30s, so the cost
# has to be a known constant, not "however big this tree is".
SCAN_MAX_DEPTH = 3           # levels below cwd we look for a .git
SCAN_MAX_DIRS = 4000         # hard stop on directories visited per scan
MAX_REPOS = 20               # repos reported for one workspace
MULTI_MAX_FILES = 400        # per-repo file entries when there are several
SCAN_TTL_S = 60.0            # discovery is cached; `refresh` bypasses it

# Directories never worth descending into looking for a project. Not a
# correctness boundary (a repo inside node_modules is a vendored copy, not
# your work) — a cost one: these are where a recursive walk goes to die.
SCAN_SKIP_DIRS = frozenset({
    ".git", "node_modules", ".venv", "venv", "env", "__pycache__",
    ".next", ".nuxt", "dist", "build", "target", "vendor", "bower_components",
    ".cache", ".terraform", ".gradle", ".tox", ".mypy_cache", ".pytest_cache",
    "site-packages", ".svn", ".hg",
})

# cwd -> (deadline, [roots], truncated)
_scan_cache: dict[str, tuple[float, list[str], bool]] = {}


def _env() -> dict[str, str]:
    """Environment that makes git fail fast instead of waiting on a human."""
    e = os.environ.copy()
    # https creds: error out instead of prompting on the (absent) terminal.
    e["GIT_TERMINAL_PROMPT"] = "0"
    e["GIT_ASKPASS"] = ""
    e["SSH_ASKPASS"] = ""
    e["GIT_PAGER"] = "cat"
    # Don't take the index lock just to refresh stat info: `git status` must
    # never contend with a coding agent running git in the same repo.
    e["GIT_OPTIONAL_LOCKS"] = "0"
    # Stable, parseable English messages (we pattern-match stderr for `reason`).
    e["LC_ALL"] = "C"
    e["LANG"] = "C"
    # ssh remotes: never hang on a passphrase or an unknown host key.
    e.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
    return e


def _run(cwd: str, args: list[str], timeout: int = READ_TIMEOUT_S) -> tuple[int, str, str]:
    """Run `git <args>` in `cwd`. Returns (code, stdout, stderr).

    code 124 = timed out, 127 = git not installed. Output is decoded with
    errors='replace': git paths are bytes and a non-UTF-8 filename must not
    take down JSON serialization of the whole listing.
    """
    try:
        p = subprocess.run(
            ["git", "--no-pager", "-c", "color.ui=false", *args],
            cwd=cwd, env=_env(), timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except subprocess.TimeoutExpired:
        return 124, "", f"git {args[0] if args else ''}: timed out after {timeout}s"
    except FileNotFoundError:
        return 127, "", "git is not installed on this VPS"
    except OSError as ex:
        return 125, "", str(ex)
    return (
        p.returncode,
        p.stdout.decode("utf-8", "replace"),
        p.stderr.decode("utf-8", "replace"),
    )


def _first_line(s: str) -> str:
    for ln in s.splitlines():
        ln = ln.strip()
        if ln:
            return ln[:400]
    return ""


def _classify(stderr: str, stdout: str = "") -> str:
    """Map git's stderr onto a `reason` the UI can turn into a fix button.

    The strings are matched against LC_ALL=C output (see `_env`).
    """
    t = (stderr + "\n" + stdout).lower()
    if "dubious ownership" in t:
        return "ownership"          # → suggest safe.directory
    if "please tell me who you are" in t or "empty ident" in t or "unable to auto-detect email" in t:
        return "identity"           # → suggest user.name / user.email
    if ("could not read username" in t or "authentication failed" in t
            or "permission denied (publickey" in t or "permission denied (public" in t
            or "terminal prompts disabled" in t or "access denied" in t
            or "invalid username or" in t):
        return "auth"
    if "does not appear to be a git repository" in t or "no such remote" in t or "no configured push destination" in t:
        return "no_remote"
    if "non-fast-forward" in t or "fetch first" in t or "updates were rejected" in t or "behind its remote" in t:
        return "rejected"
    if "conflict" in t or "could not apply" in t:
        return "conflict"
    if "nothing to commit" in t or "no changes added" in t or "nothing added to commit" in t:
        return "no_changes"
    if "timed out after" in t:
        return "timeout"
    if "not installed" in t:
        return "no_git"
    if "hook" in t and ("declined" in t or "failed" in t):
        return "hook"
    return "error"


def _fail(msg: str, reason: str | None = None, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": False, "error": msg[:400], "reason": reason or _classify(msg)}
    out.update(extra)
    return out


# ── Repo resolution + path safety ───────────────────────────────────────────
def _root(cwd: str) -> tuple[str | None, dict[str, Any] | None]:
    """Repo toplevel containing `cwd`, or (None, <response to return>).

    The panel is scoped to the REPO, not to the session's cwd: a session
    started in `src/` must still show (and commit) the whole changeset, the
    way any editor does.
    """
    path = os.path.expanduser((cwd or "").strip())
    if not path or not os.path.isdir(path):
        return None, {"ok": True, "is_repo": False, "root": None, "files": [],
                      "reason": "no_cwd", "error": "directory not found"}
    code, out, err = _run(path, ["rev-parse", "--show-toplevel"])
    if code != 0:
        low = (err or "").lower()
        if "not a git repository" in low:
            return None, {"ok": True, "is_repo": False, "root": None, "files": []}
        # git missing / dubious ownership / anything else is a REAL failure:
        # the UI must say why instead of silently pretending "not a repo".
        return None, _fail(_first_line(err) or "git failed", None, is_repo=False, root=None, files=[])
    root = out.strip()
    if not root:
        return None, {"ok": True, "is_repo": False, "root": None, "files": []}
    return root, None


def _safe_rel(root: str, p: str) -> str | None:
    """Repo-relative form of `p`, or None if it escapes the repo.

    Accepts either a repo-relative path or an absolute path inside the repo.
    `realpath` is compared against the realpath'd root so a symlink pointing
    out of the tree can't be used to read or delete an arbitrary file.
    """
    p = (p or "").strip()
    if not p or "\0" in p:
        return None
    cand = p if os.path.isabs(p) else os.path.join(root, p)
    real_root = os.path.realpath(root)
    # The file itself may not exist (deleted entry) → resolve its parent.
    real = os.path.realpath(cand)
    if real != real_root and not real.startswith(real_root + os.sep):
        return None
    rel = os.path.relpath(real, real_root)
    if rel == "." or rel.startswith(".."):
        return None
    return rel


def _safe_rels(root: str, paths: Iterable[Any]) -> tuple[list[str], str | None]:
    out: list[str] = []
    for raw in paths or []:
        rel = _safe_rel(root, str(raw))
        if rel is None:
            return [], f"path outside the repository: {str(raw)[:120]}"
        out.append(rel)
    return out, None


# ── porcelain v2 / numstat parsing ──────────────────────────────────────────
def _num(s: str) -> int | None:
    # git prints '-' for binary files in --numstat.
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


def _parse_numstat_z(out: str) -> dict[str, tuple[int | None, int | None]]:
    """`git diff --numstat -z` → {path: (added, deleted)}.

    Two record shapes: plain `A\\tD\\tpath\\0`, and for renames
    `A\\tD\\t\\0from\\0to\\0` (the -z form splits the paths out so they need
    no quoting). Stats are attributed to the destination path.
    """
    toks = out.split("\0")
    res: dict[str, tuple[int | None, int | None]] = {}
    i = 0
    while i < len(toks):
        t = toks[i]
        if not t:
            i += 1
            continue
        parts = t.split("\t")
        if len(parts) >= 3 and parts[2] != "":
            res["\t".join(parts[2:])] = (_num(parts[0]), _num(parts[1]))
            i += 1
        elif len(parts) >= 2:
            to = toks[i + 2] if i + 2 < len(toks) else ""
            if to:
                res[to] = (_num(parts[0]), _num(parts[1]))
            i += 3
        else:
            i += 1
    return res


def _letter(x: str, y: str) -> str:
    """One-letter summary for the file list. Index status wins when set."""
    return x if x and x != "." else (y or "?")


def _count_untracked_lines(abs_path: str) -> tuple[int | None, bool]:
    """(line count, is_binary) for an untracked file — cheap, best effort.

    Untracked files have no numstat (git has nothing to diff against), but
    showing `+0` for a brand new 400-line file reads as a bug. NUL in the
    first block ⇒ binary ⇒ no count, matching git's own heuristic.
    """
    try:
        if os.path.getsize(abs_path) > MAX_UNTRACKED_SCAN_BYTES:
            return None, False
        with open(abs_path, "rb") as f:
            head = f.read(8000)
            if b"\0" in head:
                return None, True
            n = head.count(b"\n")
            while True:
                chunk = f.read(262144)
                if not chunk:
                    break
                n += chunk.count(b"\n")
        return n, False
    except OSError:
        return None, False


# ── RPCs ────────────────────────────────────────────────────────────────────
def git_status(cwd: str, include_recent: bool = False,
               max_files: int = MAX_FILES) -> dict[str, Any]:
    """Working-tree summary for the repo containing `cwd`.

    One `git status --porcelain=v2 -b -z -uall` + one `git diff --numstat`.
    `ok: True, is_repo: False` is the normal answer for a non-repo cwd — the
    hub renders nothing at all in that case, so it must not look like an error.

    `include_recent` adds the last few commit subjects. It is OPT-IN because
    this call is polled: the subjects are only wanted when drafting a commit
    message (they are what makes a generated message match the repo's own
    conventions), and paying an extra subprocess on every poll to carry them
    would be waste 99% of the time.
    """
    root, bail = _root(cwd)
    if bail is not None:
        return bail
    assert root is not None

    code, out, err = _run(root, [
        "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all",
    ])
    if code != 0:
        return _fail(_first_line(err) or "git status failed", None, is_repo=True, root=root, files=[])

    branch: str | None = None
    upstream: str | None = None
    head: str | None = None
    ahead = behind = 0
    detached = False
    entries: list[dict[str, Any]] = []

    toks = out.split("\0")
    i = 0
    while i < len(toks):
        t = toks[i]
        i += 1
        if not t:
            continue
        if t.startswith("# "):
            k, _, v = t[2:].partition(" ")
            if k == "branch.head":
                if v == "(detached)":
                    detached = True
                else:
                    branch = v
            elif k == "branch.upstream":
                upstream = v
            elif k == "branch.oid":
                head = None if v == "(initial)" else v[:12]
            elif k == "branch.ab":
                for part in v.split():
                    if part.startswith("+"):
                        ahead = _num(part[1:]) or 0
                    elif part.startswith("-"):
                        behind = _num(part[1:]) or 0
            continue

        kind, _, rest = t.partition(" ")
        if kind == "1":
            f = rest.split(" ", 7)
            if len(f) < 8:
                continue
            xy, path = f[0], f[7]
            entries.append({"path": path, "x": xy[0], "y": xy[1:2] or ".",
                            "status": _letter(xy[0], xy[1:2]), "untracked": False})
        elif kind == "2":
            f = rest.split(" ", 8)
            if len(f) < 9:
                continue
            xy, path = f[0], f[8]
            orig = toks[i] if i < len(toks) else ""
            i += 1
            entries.append({"path": path, "orig_path": orig or None, "x": xy[0],
                            "y": xy[1:2] or ".", "status": _letter(xy[0], xy[1:2]),
                            "untracked": False})
        elif kind == "u":
            f = rest.split(" ", 10)
            if len(f) < 11:
                continue
            entries.append({"path": f[10], "x": "U", "y": "U", "status": "U",
                            "untracked": False, "conflict": True})
        elif kind == "?":
            entries.append({"path": rest, "x": "?", "y": "?", "status": "?", "untracked": True})
        # '!' (ignored) is never requested.

    # Line counts. `git diff --numstat HEAD` covers every TRACKED change in
    # one shot (staged + unstaged), which is exactly the set `git_commit`
    # would record. Unborn HEAD ⇒ nothing is tracked yet, skip it.
    stats: dict[str, tuple[int | None, int | None]] = {}
    has_head = _run(root, ["rev-parse", "--verify", "--quiet", "HEAD"])[0] == 0
    if has_head and any(not e["untracked"] for e in entries):
        c2, o2, _ = _run(root, ["diff", "--numstat", "-z", "-M", "HEAD", "--"])
        if c2 == 0:
            stats = _parse_numstat_z(o2)

    untracked_seen = 0
    total_add = total_del = 0
    conflicts = 0
    for e in entries:
        if e.get("conflict"):
            conflicts += 1
        if e["untracked"]:
            e["added"], e["deleted"], e["binary"] = None, None, False
            if untracked_seen < MAX_UNTRACKED_SCAN:
                untracked_seen += 1
                n, is_bin = _count_untracked_lines(os.path.join(root, e["path"]))
                e["added"], e["binary"] = (None if is_bin else n), is_bin
                if n:
                    total_add += n
        else:
            a, d = stats.get(e["path"], (None, None))
            e["added"], e["deleted"] = a, d
            e["binary"] = e["path"] in stats and a is None and d is None
            total_add += a or 0
            total_del += d or 0

    entries.sort(key=lambda e: (e["untracked"], e["path"]))
    # `remote -v` rather than `remote`: same one subprocess, but it also carries
    # the URLs, which is what the hub turns into the "open on GitHub" link.
    remotes: list[str] = []
    origin_url: str | None = None
    first_url: str | None = None
    code_r, out_r, _ = _run(root, ["remote", "-v"])
    if code_r == 0:
        for line in out_r.split("\n"):
            parts = line.split()
            if len(parts) < 2:
                continue
            name, url = parts[0], parts[1]
            if name not in remotes:
                remotes.append(name)
            if name == "origin" and origin_url is None:
                origin_url = url
            if first_url is None:
                first_url = url
    remote_url = origin_url or first_url

    recent: list[str] = []
    if include_recent and has_head:
        c3, o3, _ = _run(root, ["log", "-8", "--no-merges", "--format=%s"])
        if c3 == 0:
            recent = [ln for ln in o3.split("\n") if ln.strip()][:8]

    return {
        "recent_subjects": recent,
        "ok": True,
        "is_repo": True,
        "root": root,
        "branch": branch,
        "detached": detached,
        "head": head,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "remotes": remotes,
        "remote_url": remote_url,
        "files": entries[:max_files],
        "file_count": len(entries),
        "truncated": len(entries) > max_files,
        "added": total_add,
        "deleted": total_del,
        "conflicts": conflicts,
    }


def _discover_repos(base: str, max_depth: int) -> tuple[list[str], bool]:
    """Repo toplevels at most `max_depth` levels BELOW `base`.

    Returns (roots, truncated). Sorted, so the panel's order is stable between
    polls instead of following directory-entry order.

    Deliberate rules:
      * a directory containing `.git` is a root and we DO NOT descend into it.
        Its submodules are its business; listing them as peers of the projects
        you opened the folder for is noise, and it is what makes the walk cheap.
      * symlinked directories are never followed — one loop back up the tree
        would turn a bounded scan into an unbounded one.
      * `SCAN_SKIP_DIRS` and `SCAN_MAX_DIRS` bound the cost; hitting the latter
        sets `truncated` so the UI can say the list may be incomplete rather
        than quietly pretending it is exhaustive.
    """
    roots: list[str] = []
    visited = 0
    truncated = False
    # (path, depth). Iterative: a deep tree must not depend on the recursion
    # limit, and the caps are easier to read as loop conditions.
    stack: list[tuple[str, int]] = [(base, 0)]
    while stack:
        path, depth = stack.pop()
        if visited >= SCAN_MAX_DIRS:
            truncated = True
            break
        visited += 1
        try:
            with os.scandir(path) as it:
                children: list[str] = []
                is_repo = False
                for e in it:
                    name = e.name
                    if name == ".git":
                        # A file named .git is a worktree/submodule pointer —
                        # still a checkout as far as `git -C` is concerned.
                        is_repo = True
                        continue
                    if depth >= max_depth or name in SCAN_SKIP_DIRS:
                        continue
                    try:
                        if e.is_dir(follow_symlinks=False):
                            children.append(e.path)
                    except OSError:
                        continue
        except (OSError, PermissionError):
            continue
        if is_repo and path != base:
            roots.append(path)
            if len(roots) >= MAX_REPOS:
                truncated = True
                break
            continue                    # never descend into a checkout
        # A `.git` at the BASE is not a stop sign: `_root()` is the authority
        # there and it already said no, so this marker is one git itself
        # rejected (an empty or half-created .git, a stale worktree pointer, a
        # repo whose ownership git refuses). Treating it as a checkout hid
        # every project underneath — measured on a real /srv.
        stack.extend((c, depth + 1) for c in children)
    roots.sort()
    return roots, truncated


def git_workspace(cwd: str, scan_depth: int = SCAN_MAX_DEPTH,
                  include_recent: bool = False, refresh: bool = False) -> dict[str, Any]:
    """Every repo this session can see, as ONE answer.

    `mode`:
      * `single` — `cwd` is inside a checkout. Exactly today's behaviour, one
        entry, scoped to the toplevel (a session started in `src/` still sees
        the whole changeset).
      * `multi`  — `cwd` is NOT a checkout but contains some. One entry per
        discovered repo. Reported even when there is exactly one, because the
        panel then has to say WHICH folder it is talking about.
      * `none`   — a plain folder with nothing underneath it.

    One RPC rather than "discover, then N status calls": the hub polls this
    while a session is on screen, and N round trips per tick over one ssh pipe
    is N chances to half-fail. The per-repo payload is the `git_status` shape
    verbatim, so the hub reuses one decoder.
    """
    path = os.path.expanduser((cwd or "").strip())
    if not path or not os.path.isdir(path):
        return {"ok": True, "mode": "none", "repos": [],
                "reason": "no_cwd", "error": "directory not found"}

    root, bail = _root(path)
    if root:
        st = git_status(root, include_recent=include_recent)
        st["root"] = st.get("root") or root
        return {"ok": True, "mode": "single", "repos": [_tag(st, path)]}
    # A real failure (git missing, dubious ownership on the cwd itself) is not
    # "no repo here" — scanning would just repeat it once per subdirectory.
    if bail is not None and bail.get("ok") is False:
        return {"ok": False, "mode": "none", "repos": [],
                "error": bail.get("error"), "reason": bail.get("reason")}

    depth = max(1, min(int(scan_depth or SCAN_MAX_DEPTH), 6))
    now = time.monotonic()
    hit = _scan_cache.get(path)
    if refresh or hit is None or hit[0] < now:
        roots, truncated = _discover_repos(path, depth)
        _scan_cache[path] = (now + SCAN_TTL_S, roots, truncated)
        if len(_scan_cache) > 200:      # bounded: one entry per watched cwd
            for k in [k for k, v in _scan_cache.items() if v[0] < now]:
                _scan_cache.pop(k, None)
    else:
        roots, truncated = hit[1], hit[2]

    if not roots:
        return {"ok": True, "mode": "none", "repos": []}

    repos = []
    for r in roots:
        st = git_status(r, include_recent=include_recent, max_files=MULTI_MAX_FILES)
        st["root"] = st.get("root") or r
        repos.append(_tag(st, path))
    return {"ok": True, "mode": "multi", "repos": repos,
            "scanned": len(roots), "truncated": truncated}


def _tag(status: dict[str, Any], base: str) -> dict[str, Any]:
    """Add the two display keys the hub would otherwise recompute per render."""
    root = status.get("root") or base
    rel = os.path.relpath(root, base)
    status["rel"] = "" if rel == "." else rel
    status["name"] = os.path.basename(root.rstrip("/")) or root
    return status


def git_diff(cwd: str, path: str) -> dict[str, Any]:
    """Unified patch for ONE path — worktree vs HEAD (i.e. what a commit
    of that path would record), or vs /dev/null when untracked.

    One file at a time on purpose: the panel is an index, the reader opens a
    single file, and a whole-changeset patch is exactly the kind of payload
    that once cost 16.5 GB/day of egress (CLAUDE.md §14.41).
    """
    root, bail = _root(cwd)
    if bail is not None:
        return bail
    assert root is not None
    rel = _safe_rel(root, path)
    if rel is None:
        return _fail("path outside the repository", "bad_path")

    abs_p = os.path.join(root, rel)
    tracked = _run(root, ["ls-files", "--error-unmatch", "-z", "--", rel])[0] == 0
    if not tracked and os.path.exists(abs_p):
        # --no-index exits 1 when the files differ: that IS the success case.
        code, out, err = _run(root, ["diff", "--no-color", "--no-index", "--", os.devnull, rel])
        if code not in (0, 1):
            return _fail(_first_line(err) or "git diff failed")
    else:
        code, out, err = _run(root, ["diff", "--no-color", "-M", "HEAD", "--", rel])
        if code != 0:
            # Unborn HEAD: nothing to diff against, the file is wholly new.
            if _run(root, ["rev-parse", "--verify", "--quiet", "HEAD"])[0] != 0:
                code, out, err = _run(root, ["diff", "--no-color", "--no-index", "--", os.devnull, rel])
                if code not in (0, 1):
                    return _fail(_first_line(err) or "git diff failed")
            else:
                return _fail(_first_line(err) or "git diff failed")

    truncated = len(out.encode("utf-8", "replace")) > MAX_PATCH_BYTES
    if truncated:
        out = out[: MAX_PATCH_BYTES // 2]
    return {"ok": True, "root": root, "path": rel, "patch": out,
            "truncated": truncated, "tracked": tracked}


def _resolve_targets(root: str, params: dict[str, Any]) -> tuple[list[str] | None, str | None]:
    """`all: true` → None (whole tree), else the validated path list."""
    if params.get("all"):
        return None, None
    raw = params.get("paths")
    if not isinstance(raw, list) or not raw:
        return None, "no files selected"
    rels, err = _safe_rels(root, raw)
    if err:
        return None, err
    return rels, None


def git_commit(cwd: str, params: dict[str, Any]) -> dict[str, Any]:
    """Stage the selected paths and commit them.

    Deliberately index-free from the user's point of view: the panel has
    checkboxes, not a staging area. `add -A -- <paths>` then
    `commit -- <paths>` records the WORKTREE state of exactly those paths and
    leaves anything else already staged untouched (a partial commit), so two
    agents working in the same repo can't sweep each other's work into a
    commit — the concurrency footgun this whole feature has to avoid.
    """
    message = str(params.get("message") or "").strip()
    if not message:
        return _fail("empty commit message", "no_message")
    if len(message) > MAX_MESSAGE_CHARS:
        message = message[:MAX_MESSAGE_CHARS]

    root, bail = _root(cwd)
    if bail is not None:
        return bail
    assert root is not None
    targets, err = _resolve_targets(root, params)
    if err:
        return _fail(err, "bad_paths")

    add_args = ["add", "-A", "--"] + (targets if targets is not None else ["."])
    code, _, aerr = _run(root, add_args, timeout=COMMIT_TIMEOUT_S)
    if code != 0:
        return _fail(_first_line(aerr) or "git add failed")

    commit_args = ["commit", "-m", message]
    if targets is not None:
        commit_args += ["--"] + targets
    code, out, cerr = _run(root, commit_args, timeout=COMMIT_TIMEOUT_S)
    if code != 0:
        return _fail(_first_line(cerr) or _first_line(out) or "git commit failed",
                     _classify(cerr, out))

    _, sha_out, _ = _run(root, ["log", "-1", "--format=%h"])
    sha = sha_out.strip() or None
    result: dict[str, Any] = {"ok": True, "committed": True, "sha": sha,
                              "subject": message.split("\n", 1)[0][:200], "pushed": False}
    if params.get("push"):
        pushed = git_push(cwd)
        result["pushed"] = bool(pushed.get("ok"))
        if not pushed.get("ok"):
            # The commit LANDED. Surfacing this as a failure would push the
            # user to re-commit; it's a push problem and says so.
            result["push_error"] = pushed.get("error")
            result["push_reason"] = pushed.get("reason")
        else:
            result["push_output"] = pushed.get("output")
    return result


def git_push(cwd: str) -> dict[str, Any]:
    """`git push`, or `push -u <remote> HEAD` for a branch with no upstream.

    Never `--force`, never `--force-with-lease`: a rejected push is reported
    as reason='rejected' and the user pulls.
    """
    root, bail = _root(cwd)
    if bail is not None:
        return bail
    assert root is not None

    code, up, _ = _run(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    has_upstream = code == 0 and up.strip() != ""
    args = ["push"]
    if not has_upstream:
        _, rem_out, _ = _run(root, ["remote"])
        remotes = [r for r in rem_out.split("\n") if r.strip()]
        if not remotes:
            return _fail("this repository has no remote", "no_remote")
        target = "origin" if "origin" in remotes else remotes[0]
        args += ["--set-upstream", target, "HEAD"]

    code, out, err = _run(root, args, timeout=NET_TIMEOUT_S)
    if code != 0:
        return _fail(_first_line(err) or _first_line(out) or "git push failed", _classify(err, out))
    # git push reports progress on stderr even on success.
    return {"ok": True, "output": (_first_line(err) or _first_line(out) or "pushed")}


def git_pull(cwd: str) -> dict[str, Any]:
    """`git pull --rebase --autostash` — the recovery path for a rejected push.

    --autostash so a dirty tree (the normal state here) isn't a blocker; a
    real conflict comes back as reason='conflict' and is the user's to resolve
    in a shell or with an agent.
    """
    root, bail = _root(cwd)
    if bail is not None:
        return bail
    assert root is not None
    code, out, err = _run(root, ["pull", "--rebase", "--autostash"], timeout=NET_TIMEOUT_S)
    if code != 0:
        return _fail(_first_line(err) or _first_line(out) or "git pull failed", _classify(err, out))
    return {"ok": True, "output": (_first_line(out) or _first_line(err) or "up to date")}


# ── Branches (agent >= 0.31.0) ──────────────────────────────────────────────
# The panel used to show a branch NAME and nothing else: you could see you were
# on `main`, not what else existed, how far it had drifted, or how to move. A
# checkout is also the one write here that is not an allow-listed edit of the
# working tree — hence the rules below.
MAX_BRANCHES = 200

# One call for everything the modal shows. \x1f between fields and \x1e between
# records because a commit subject can contain anything, tabs and pipes
# included, and a branch listing that breaks on somebody's subject line is
# worse than no listing.
_BR_FIELDS = (
    "%(refname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f"
    "%(ahead-behind:HEAD)%1f%(committerdate:unix)%1f%(HEAD)%1f%(worktreepath)%1f"
    "%(contents:subject)%1e"
)
# Same, minus ahead-behind: that field needs git >= 2.41 and a whole `git
# for-each-ref` fails with 128 on an unknown field, so an old VPS would get an
# empty branch list rather than one missing a column.
_BR_FIELDS_OLD = _BR_FIELDS.replace("%(ahead-behind:HEAD)", "")


def _parse_track(track: str) -> tuple[int, int, bool]:
    """`upstream:track,nobracket` → (ahead, behind, gone)."""
    t = (track or "").strip()
    if t == "gone":
        return 0, 0, True
    ahead = behind = 0
    for part in t.split(","):
        part = part.strip()
        if part.startswith("ahead "):
            ahead = int(part[6:] or 0)
        elif part.startswith("behind "):
            behind = int(part[7:] or 0)
    return ahead, behind, False


def git_branches(cwd: str, include_remote: bool = True) -> dict[str, Any]:
    """Every branch, with how far each one has drifted.

    Two different ahead/behind pairs, because they answer different questions:
      * vs UPSTREAM  — "is my branch in sync with the remote" (what the pull
        and push buttons are about);
      * vs HEAD      — "what would switching to this cost me", which is the
        only number that turns a branch list into a navigation tool rather
        than a list of names.
    """
    root, bail = _root(cwd)
    if bail is not None:
        return bail
    assert root is not None

    # Local names first: it is what tells a remote-only branch (offer it) from
    # a remote ref that merely mirrors a branch you already have (hide it, or
    # the list shows `main` twice and picking the wrong one detaches HEAD).
    code, out, _ = _run(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    local_names = {ln.strip() for ln in out.split("\n") if ln.strip()} if code == 0 else set()

    refs = ["refs/heads/"] + (["refs/remotes/"] if include_remote else [])
    args = ["for-each-ref", "--format=" + _BR_FIELDS, "--sort=-committerdate",
            f"--count={MAX_BRANCHES * 2}", *refs]
    code, out, err = _run(root, args)
    if code != 0:
        # `ahead-behind` needs git >= 2.41 and an unknown field fails the WHOLE
        # command with 128 — an old VPS would get an empty list instead of one
        # missing a column.
        args[1] = "--format=" + _BR_FIELDS_OLD
        code, out, err = _run(root, args)
        if code != 0:
            return _fail(_first_line(err) or "git for-each-ref failed", None,
                         branches=[], current=None)

    branches: list[dict[str, Any]] = []
    for rec in out.split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        f = rec.split("\x1f")
        if len(f) < 8:
            continue
        name, upstream, track, ahead_behind, cdate, head, worktree, subject = f[:8]
        if not name or name.endswith("/HEAD"):
            continue
        is_remote = name not in local_names
        short = name.split("/", 1)[1] if (is_remote and "/" in name) else name
        if is_remote and short in local_names:
            continue                      # already checked out locally
        ahead, behind, gone = _parse_track(track)
        ah = bh = None
        bits = ahead_behind.split()
        if len(bits) == 2:
            try:
                ah, bh = int(bits[0]), int(bits[1])
            except ValueError:
                ah = bh = None
        branches.append({
            "name": name,
            "short": short,
            "remote": is_remote,
            "current": head.strip() == "*",
            "upstream": upstream or None,
            "ahead": ahead, "behind": behind, "gone": gone,
            "ahead_head": ah, "behind_head": bh,
            "committed_at": int(cdate) if cdate.isdigit() else None,
            "subject": subject[:200],
            # A branch checked out in another worktree cannot be switched to;
            # saying so beats letting git refuse with a puzzling message.
            "worktree": worktree or None,
        })
        if len(branches) >= MAX_BRANCHES:
            break

    current = next((b["name"] for b in branches if b["current"]), None)
    return {
        "ok": True, "root": root, "current": current, "detached": current is None,
        "branches": branches,
        "truncated": len(branches) >= MAX_BRANCHES,
    }


def git_fetch(cwd: str, prune: bool = False) -> dict[str, Any]:
    """`git fetch --all` — what makes `behind` a real number.

    Ahead/behind come from comparing a local ref to its tracking ref, and that
    tracking ref only moves on a fetch. Without this the pull button never
    appears, because nothing ever told the VPS the remote had moved.
    """
    root, bail = _root(cwd)
    if bail is not None:
        return bail
    assert root is not None
    args = ["fetch", "--all", "--quiet"]
    if prune:
        args.append("--prune")
    code, out, err = _run(root, args, timeout=NET_TIMEOUT_S)
    if code != 0:
        return _fail(_first_line(err) or _first_line(out) or "git fetch failed", _classify(err, out))
    return {"ok": True, "output": _first_line(out) or _first_line(err) or "fetched"}


def git_checkout(cwd: str, params: dict[str, Any]) -> dict[str, Any]:
    """Switch to a branch, optionally creating it.

    `git switch`, not `git checkout`: switch refuses to touch a path by
    accident, and it refuses outright when the move would overwrite local
    changes — which is the behaviour we want, since another agent may be
    writing here. NEVER `--force`, NEVER `--discard-changes`: a dirty tree
    comes back as reason='dirty' with the paths git named, and the user
    decides. No autostash either — stashing a tree an agent is mid-write in is
    a silent way to lose work.

    Creating carries the working tree over, which is the normal "I started
    editing on the wrong branch" recovery, so create is allowed while dirty.
    """
    root, bail = _root(cwd)
    if bail is not None:
        return bail
    assert root is not None

    name = str(params.get("branch") or "").strip()
    if not name or name.startswith("-") or ".." in name or name.endswith("/"):
        return _fail("invalid branch name", "bad_branch")
    create = bool(params.get("create"))
    start = str(params.get("start_point") or "").strip()
    if start.startswith("-"):
        return _fail("invalid start point", "bad_branch")

    if create:
        args = ["switch", "--create", name]
        if start:
            args.append(start)
    else:
        # A name that only exists on a remote: create the local branch that
        # tracks it (what `switch <name>` does on its own when exactly one
        # remote has it), rather than detaching HEAD onto the remote ref.
        short = name.split("/", 1)[1] if name.startswith("origin/") else name
        args = ["switch", short]
        if short != name:
            args = ["switch", "--create", short, "--track", name]

    code, out, err = _run(root, args, timeout=COMMIT_TIMEOUT_S)
    if code != 0:
        text = (err + "\n" + out).lower()
        if "would be overwritten" in text or "local changes" in text or "please commit" in text:
            files = [ln.strip() for ln in (err + "\n" + out).splitlines()
                     if ln.startswith("\t") or ln.startswith("        ")]
            return _fail(_first_line(err) or "local changes would be overwritten",
                         "dirty", conflicts=[f for f in files][:40])
        if "already exists" in text:
            return _fail(_first_line(err) or "branch already exists", "exists")
        return _fail(_first_line(err) or _first_line(out) or "git switch failed", _classify(err, out))

    if create and bool(params.get("push")):
        pcode, pout, perr = _run(root, ["push", "--set-upstream", "origin", name],
                                 timeout=NET_TIMEOUT_S)
        if pcode != 0:
            # The branch EXISTS and we are on it; only the publish failed.
            return {"ok": True, "branch": name, "created": True, "pushed": False,
                    "push_error": _first_line(perr) or "push failed",
                    "push_reason": _classify(perr, pout)}
        return {"ok": True, "branch": name, "created": True, "pushed": True}
    return {"ok": True, "branch": name, "created": create, "pushed": False}


def git_delete_branch(cwd: str, params: dict[str, Any]) -> dict[str, Any]:
    """`git branch -d` — the SAFE delete, never `-D`.

    -d refuses a branch whose commits are not merged anywhere, which is exactly
    the guard we want; reason='unmerged' tells the user why instead of quietly
    dropping work. Remote branches are not deletable from here at all: that is
    a push to someone else's server.
    """
    root, bail = _root(cwd)
    if bail is not None:
        return bail
    assert root is not None
    name = str(params.get("branch") or "").strip()
    if not name or name.startswith("-"):
        return _fail("invalid branch name", "bad_branch")
    code, out, err = _run(root, ["branch", "--delete", "--", name])
    if code != 0:
        text = (err + out).lower()
        if "not fully merged" in text:
            return _fail(f"{name} has commits that are not merged anywhere", "unmerged")
        if "checked out" in text:
            return _fail(_first_line(err) or "that branch is checked out", "current")
        return _fail(_first_line(err) or "git branch -d failed", _classify(err, out))
    return {"ok": True, "deleted": name}


def git_discard(cwd: str, params: dict[str, Any]) -> dict[str, Any]:
    """Throw away local changes for the given paths. Never repo-wide.

    Tracked → `checkout HEAD --` (drops staged AND unstaged changes for that
    path). Untracked → unlink the file. `all` is NOT accepted: a one-click
    "discard everything" on a tree a coding agent is actively writing to is
    the single most destructive thing this panel could offer.
    """
    root, bail = _root(cwd)
    if bail is not None:
        return bail
    assert root is not None
    raw = params.get("paths")
    if not isinstance(raw, list) or not raw:
        return _fail("no files selected", "bad_paths")
    rels, err = _safe_rels(root, raw)
    if err:
        return _fail(err, "bad_paths")

    _, ls_out, _ = _run(root, ["ls-files", "-z", "--"] + rels)
    tracked = {p for p in ls_out.split("\0") if p}
    to_checkout = [p for p in rels if p in tracked]
    to_unlink = [p for p in rels if p not in tracked]

    discarded: list[str] = []
    if to_checkout:
        code, _, cerr = _run(root, ["checkout", "HEAD", "--"] + to_checkout, timeout=COMMIT_TIMEOUT_S)
        if code != 0:
            return _fail(_first_line(cerr) or "git checkout failed")
        discarded += to_checkout
    for p in to_unlink:
        try:
            target = os.path.join(root, p)
            if os.path.isfile(target) or os.path.islink(target):
                os.unlink(target)
                discarded.append(p)
        except OSError as ex:
            return _fail(f"{p}: {ex}", "error", discarded=discarded)
    return {"ok": True, "discarded": discarded}
