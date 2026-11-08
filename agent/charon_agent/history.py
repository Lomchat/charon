"""This box's session history, indexed — the resume modal's source (agent >= 0.124.0).

Two RPCs:

- ``history_index`` lists every Claude transcript (``<claude home>/projects/
  <slug>/<id>.jsonl``) and Codex rollout (``<codex home>/sessions/**`` and
  ``archived_sessions/``) as one row each: title, first and last prompt,
  folder, branch, model, prompt count, size, mtime.
- ``history_preview`` reads ONE of them for the panel: the first request and
  the last few exchanges, with what the agent did (files edited, commands).

Why an index: a box holds gigabytes of transcripts, and the old scan re-read
them all on every open. Here a cache (``<agent home>/history-index.json``)
keeps one entry per file keyed by inode + size + mtime:

- unchanged file → its cached row, no read at all;
- a file that only GREW (transcripts are append-only) → only the new bytes;
- a small new file (≤ ``FULL_PARSE_MAX``) → read once, exact counts;
- a big new file → its HEAD (first request, first folder, early title) and
  TAIL (current title, last prompt, model, branch); its prompt count is then
  only what those two samples saw, flagged ``approx``.

Each call works newest-first within a time budget and answers what it has:
``pending`` > 0 tells the hub to call again, so the very first build shows up
in a few seconds and fills in, instead of blocking on the whole disk.

Stdlib only; every read is bounded; nothing here writes outside the cache file.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable

INDEX_VERSION = 1
FULL_PARSE_MAX = 2 * 1024 * 1024
HEAD_BYTES = 256 * 1024
TAIL_BYTES = 512 * 1024
# A file that grew by more than this since the last call is re-sampled
# (head + tail) instead of read through: one active session must not stall
# the whole listing.
INCREMENT_MAX = 8 * 1024 * 1024
DEFAULT_BUDGET_S = 2.5
MAX_BUDGET_S = 20.0
TEXT_MAX = 400
PREVIEW_TEXT_MAX = 2000
PREVIEW_TOOLS_MAX = 12
PREVIEW_CHUNKS = (1 << 20, 4 << 20, 16 << 20)
_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

_lock = threading.Lock()
_cache: dict[str, Any] | None = None


def _agent_home() -> Path:
    return Path(os.environ.get("CHARON_AGENT_HOME") or str(Path.home() / ".charon"))


def _provider_home(kind: str) -> Path:
    # Same rule as global_accounts.default_home: the shared home every
    # account's history is linked into (§14.115).
    var = "CLAUDE_CONFIG_DIR" if kind == "claude" else "CODEX_HOME"
    return Path(os.environ.get(var) or str(Path.home() / f".{kind}"))


def _cache_file() -> Path:
    return _agent_home() / "history-index.json"


# ── Text helpers ────────────────────────────────────────────────────────────

def _as_text(v: Any) -> str:
    """Codex pydantic RootModels serialize as {'root': ...} in some builds."""
    if isinstance(v, str):
        return v
    if isinstance(v, dict) and "root" in v:
        return _as_text(v["root"])
    return ""


def _blocks_text(content: Any) -> str:
    """A message content: a string, or blocks carrying `text`."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text") or "" for b in content
                       if isinstance(b, dict) and isinstance(b.get("text"), str))
    return ""


def _is_injection(text: str) -> bool:
    """Harness-written 'user' turns: tags, interruptions, caveats."""
    s = (text or "").lstrip()
    return (not s or s.startswith("<") or s.startswith("[Request interrupted")
            or s.startswith("Caveat: The messages below")
            or s.startswith("# AGENTS.md instructions"))


def _codex_request(text: str) -> str:
    """The IDE extension prefixes its context; the request follows a marker."""
    marker = "## My request for Codex:"
    if text.lstrip().startswith("# Context from my IDE setup") and marker in text:
        return text.split(marker, 1)[1].strip()
    return text


def _clip(text: str, n: int = TEXT_MAX) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[:n - 1] + "…"


def _iter_lines(chunk: bytes, drop_first: bool) -> Iterable[dict]:
    """Complete JSON lines of a chunk. A tail chunk starts mid-line: its
    first line is dropped; the last line counts only if it is complete."""
    lines = chunk.split(b"\n")
    if drop_first and lines:
        lines = lines[1:]
    if lines and not chunk.endswith(b"\n"):
        lines = lines[:-1]
    for raw in lines:
        if not raw.strip():
            continue
        try:
            d = json.loads(raw)
        except Exception:
            continue
        if isinstance(d, dict):
            yield d


# ── Claude transcripts ──────────────────────────────────────────────────────

def _claude_prompt(d: dict) -> str | None:
    """The text a human typed, or None (tool results, meta, injections)."""
    if d.get("isSidechain") or d.get("isMeta"):
        return None
    msg = d.get("message")
    if not isinstance(msg, dict):
        return None
    content = msg.get("content")
    if isinstance(content, list) and any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return None
    text = _blocks_text(content)
    return None if _is_injection(text) else text


def _claude_feed(st: dict, d: dict) -> None:
    t = d.get("type")
    cwd = d.get("cwd")
    if isinstance(cwd, str) and cwd:
        st.setdefault("cwd0", cwd)
        st["cwd"] = cwd
    br = d.get("gitBranch")
    if isinstance(br, str) and br:
        st["branch"] = br
    if t == "custom-title" and isinstance(d.get("customTitle"), str):
        st["tc"] = d["customTitle"]
    elif t == "ai-title" and isinstance(d.get("aiTitle"), str):
        st["ta"] = d["aiTitle"]
    elif t == "summary" and isinstance(d.get("summary"), str):
        st["sm"] = d["summary"]
    elif t == "last-prompt" and isinstance(d.get("lastPrompt"), str):
        st["lp"] = _clip(d["lastPrompt"])
    elif t == "user":
        text = _claude_prompt(d)
        if text is not None:
            st["n"] = st.get("n", 0) + 1
            st.setdefault("first", _clip(text))
            st["lu"] = _clip(text)
    elif t == "assistant":
        msg = d.get("message")
        model = msg.get("model") if isinstance(msg, dict) else None
        if isinstance(model, str) and model and not model.startswith("<"):
            st["model"] = model


def _claude_row(st: dict) -> dict:
    first = st.get("first", "")
    return {
        "title": _clip(st.get("tc") or st.get("ta") or st.get("sm") or first, 200),
        "firstPrompt": first,
        "lastPrompt": st.get("lp") or st.get("lu", ""),
        # The folder the session STARTED in is the one its transcript slug
        # (and so its resume) belongs to.
        "cwd": st.get("cwd0") or "",
        "branch": st.get("branch", ""),
        "model": st.get("model", ""),
        "prompts": st.get("n", 0),
    }


# ── Codex rollouts ──────────────────────────────────────────────────────────

def _codex_normalize(d: dict) -> tuple[str | None, dict]:
    """(kind, payload) for both on-disk formats (modern and ≈2025-09)."""
    t = d.get("type")
    p = d.get("payload")
    if t and isinstance(p, dict):
        return t, p
    if t:
        return "response_item", d
    if d.get("id") and d.get("timestamp"):
        return "session_meta", d
    return None, {}


def _codex_is_subagent(src: Any) -> bool:
    """Only a POSITIVE sub-agent marker excludes a rollout."""
    if isinstance(src, str):
        return src.lower().replace("_", "").startswith("subagent")
    if isinstance(src, dict):
        return any(str(k).lower().replace("_", "").startswith("subagent") for k in src)
    return False


def _cwd_from_env_block(text: str) -> str:
    if not text or "<cwd>" not in text:
        return ""
    seg = text.split("<cwd>", 1)[1].split("</cwd>", 1)[0].strip()
    return seg if seg.startswith("/") else ""


def _codex_feed(st: dict, d: dict) -> None:
    kind, p = _codex_normalize(d)
    if kind == "session_meta":
        if _codex_is_subagent(p.get("source")):
            st["sub"] = True
        sid = p.get("session_id") or p.get("id")
        if isinstance(sid, str) and sid:
            st["id"] = sid
        cwd = _as_text(p.get("cwd"))
        if cwd:
            st["cwd"] = cwd
        g = p.get("git")
        if isinstance(g, dict) and isinstance(g.get("branch"), str):
            st["branch"] = g["branch"]
        if isinstance(p.get("name"), str) and p["name"]:
            st["name"] = p["name"]
    elif kind == "turn_context":
        if p.get("model"):
            st["model"] = _as_text(p.get("model")) or str(p.get("model"))
        if p.get("effort"):
            st["effort"] = _as_text(p.get("effort")) or str(p.get("effort"))
        cwd = _as_text(p.get("cwd"))
        if cwd and not st.get("cwd"):
            st["cwd"] = cwd
    elif kind == "event_msg":
        if p.get("type") == "user_message":
            st["ev"] = True
            text = _codex_request(p.get("message") or "") if isinstance(p.get("message"), str) else ""
            if text and not _is_injection(text):
                st["en"] = st.get("en", 0) + 1
                st.setdefault("ef", _clip(text))
                st["el"] = _clip(text)
    elif kind == "response_item" and p.get("type") == "message" and p.get("role") == "user":
        text = _blocks_text(p.get("content"))
        if not st.get("cwd"):
            c = _cwd_from_env_block(text)
            if c:
                st["cwd"] = c
        text = _codex_request(text)
        if not _is_injection(text):
            st["rn"] = st.get("rn", 0) + 1
            st.setdefault("rf", _clip(text))
            st["rl"] = _clip(text)


def _codex_row(st: dict) -> dict:
    ev = st.get("ev")
    first = st.get("ef" if ev else "rf", "")
    return {
        "title": _clip(st.get("name") or first, 200),
        "firstPrompt": first,
        "lastPrompt": st.get("el" if ev else "rl", ""),
        "cwd": st.get("cwd") or str(Path.home()),
        "branch": st.get("branch", ""),
        "model": st.get("model", ""),
        "effort": st.get("effort", ""),
        "prompts": st.get("en" if ev else "rn", 0),
    }


def _codex_names() -> dict[str, str]:
    """Thread names Codex keeps in session_index.jsonl (latest line wins)."""
    names: dict[str, str] = {}
    path = _provider_home("codex") / "session_index.jsonl"
    try:
        with open(path, "rb") as fh:
            for d in _iter_lines(fh.read(8 * 1024 * 1024), drop_first=False):
                if isinstance(d.get("id"), str) and isinstance(d.get("thread_name"), str):
                    names[d["id"]] = d["thread_name"]
    except OSError:
        pass
    return names


_FEED: dict[str, Callable[[dict, dict], None]] = {"claude": _claude_feed, "codex": _codex_feed}


# ── The file list ───────────────────────────────────────────────────────────

def _files(kinds: Iterable[str]) -> list[tuple[str, str, os.stat_result, bool]]:
    """(kind, path, stat, archived) of every transcript, newest first."""
    out: list[tuple[str, str, os.stat_result, bool]] = []

    def add(kind: str, path: str, archived: bool = False) -> None:
        try:
            st = os.stat(path)
        except OSError:
            return
        out.append((kind, path, st, archived))

    if "claude" in kinds:
        projects = _provider_home("claude") / "projects"
        try:
            dirs = [e for e in os.scandir(projects) if e.is_dir(follow_symlinks=True)]
        except OSError:
            dirs = []
        for d in dirs:
            try:
                # Top level only: sub-agent transcripts live one level down.
                for e in os.scandir(d.path):
                    if e.name.endswith(".jsonl") and e.is_file():
                        add("claude", e.path)
            except OSError:
                continue
    if "codex" in kinds:
        home = _provider_home("codex")
        for root, _dirs, names in os.walk(home / "sessions"):
            for n in names:
                if n.endswith(".jsonl"):
                    add("codex", os.path.join(root, n))
        try:
            for e in os.scandir(home / "archived_sessions"):
                if e.name.endswith(".jsonl") and e.is_file():
                    add("codex", e.path, archived=True)
        except OSError:
            pass
    out.sort(key=lambda x: -x[2].st_mtime_ns)
    return out


def _default_id(kind: str, path: str) -> str:
    stem = Path(path).stem
    if kind == "codex":
        # rollout-<ISO>-<uuid>: the uuid is the last 36 characters.
        return stem[-36:] if len(stem) >= 36 else stem
    return stem


# ── Parsing one file ────────────────────────────────────────────────────────

def _read(path: str, start: int, length: int) -> bytes:
    with open(path, "rb") as fh:
        fh.seek(start)
        return fh.read(length)


def _parse(kind: str, path: str, st: os.stat_result, prev: dict | None) -> dict:
    """A fresh cache entry for this file, reusing `prev` when it can."""
    feed = _FEED[kind]
    size = st.st_size
    same_file = prev is not None and prev.get("ino") == st.st_ino and prev.get("v") == INDEX_VERSION

    # Exact state + only the appended bytes.
    if same_file and prev.get("off") is not None and prev["off"] <= size and size - prev["off"] <= INCREMENT_MAX:
        state = dict(prev["st"])
        chunk = _read(path, prev["off"], size - prev["off"])
        consumed = chunk.rfind(b"\n") + 1
        for d in _iter_lines(chunk[:consumed], drop_first=False):
            feed(state, d)
        return {"v": INDEX_VERSION, "ino": st.st_ino, "size": size, "mt": st.st_mtime_ns,
                "off": prev["off"] + consumed, "st": state, "approx": False}

    if size <= FULL_PARSE_MAX:
        state: dict = {}
        chunk = _read(path, 0, size)
        consumed = chunk.rfind(b"\n") + 1
        for d in _iter_lines(chunk[:consumed], drop_first=False):
            feed(state, d)
        return {"v": INDEX_VERSION, "ino": st.st_ino, "size": size, "mt": st.st_mtime_ns,
                "off": consumed, "st": state, "approx": False}

    # Big: head (kept, it never changes) + a fresh tail.
    if same_file and isinstance(prev.get("hs"), dict):
        head_state = prev["hs"]
    else:
        head_state = {}
        for d in _iter_lines(_read(path, 0, HEAD_BYTES), drop_first=False):
            feed(head_state, d)
    # Prompts are too sparse to extrapolate from a sample (a tail can be one
    # long tool run): the count stays what was SEEN, flagged `approx`, and the
    # UI shows the size instead.
    state = dict(head_state)
    for d in _iter_lines(_read(path, max(HEAD_BYTES, size - TAIL_BYTES), TAIL_BYTES), drop_first=True):
        feed(state, d)
    return {"v": INDEX_VERSION, "ino": st.st_ino, "size": size, "mt": st.st_mtime_ns,
            "off": None, "hs": head_state, "st": state, "approx": True}


def _row(kind: str, path: str, entry: dict, archived: bool, names: dict[str, str]) -> dict | None:
    st = entry["st"]
    if kind == "codex" and st.get("sub"):
        return None
    row = (_claude_row if kind == "claude" else _codex_row)(st)
    sid = (st.get("id") if kind == "codex" else None) or _default_id(kind, path)
    if kind == "codex" and names.get(sid):
        row["title"] = _clip(names[sid], 200)
    row.update(kind=kind, sessionId=sid, size=entry["size"], mtime=entry["mt"] / 1e9,
               approx=bool(entry.get("approx")))
    if archived:
        row["archived"] = True
    return row


# ── Cache ───────────────────────────────────────────────────────────────────

def _load() -> dict:
    global _cache
    if _cache is not None:
        return _cache
    try:
        data = json.loads(_cache_file().read_text())
        if not isinstance(data, dict) or data.get("v") != INDEX_VERSION or not isinstance(data.get("files"), dict):
            raise ValueError("stale index")
    except Exception:
        data = {"v": INDEX_VERSION, "files": {}}
    _cache = data
    return data


def _save(data: dict) -> None:
    path = _cache_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + f".tmp{os.getpid()}")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, json.dumps(data, separators=(",", ":")).encode())
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except OSError:
        pass  # a cache that cannot be written is rebuilt next time


# ── RPCs ────────────────────────────────────────────────────────────────────

def index(params: dict) -> dict:
    """history_index {kinds?, budget_ms?} → {ok, sessions, pending, total, elapsed_ms}."""
    kinds = [k for k in (params.get("kinds") or ["claude", "codex"]) if k in _FEED]
    budget = params.get("budget_ms")
    budget_s = min(MAX_BUDGET_S, max(0.2, budget / 1000)) if isinstance(budget, (int, float)) else DEFAULT_BUDGET_S
    t0 = time.monotonic()
    with _lock:
        data = _load()
        files = data["files"]
        found = _files(kinds)
        names = _codex_names() if "codex" in kinds else {}
        rows: list[dict] = []
        pending = 0
        dirty = False
        seen: set[str] = set()
        for kind, path, st, archived in found:
            seen.add(path)
            entry = files.get(path)
            fresh = (entry is not None and entry.get("v") == INDEX_VERSION and entry.get("ino") == st.st_ino
                     and entry.get("size") == st.st_size and entry.get("mt") == st.st_mtime_ns)
            if not fresh:
                if time.monotonic() - t0 < budget_s:
                    try:
                        entry = _parse(kind, path, st, entry)
                        files[path] = entry
                        dirty = True
                    except OSError:
                        continue
                else:
                    pending += 1
            if entry is None:
                continue
            row = _row(kind, path, entry, archived, names)
            if row is not None:
                rows.append(row)
        for path in [p for p in files if p not in seen and _kind_of(p, kinds)]:
            del files[path]
            dirty = True
        if dirty:
            _save(data)
    return {"ok": True, "sessions": rows, "pending": pending, "total": len(found),
            "elapsed_ms": int((time.monotonic() - t0) * 1000)}


def _kind_of(path: str, kinds: Iterable[str]) -> bool:
    """Whether a cached path belongs to one of the kinds this call listed
    (a Claude-only call must not evict the Codex entries)."""
    for k in kinds:
        if path.startswith(str(_provider_home(k))):
            return True
    return False


def _locate(kind: str, sid: str) -> str | None:
    data = _load()
    for path, entry in data["files"].items():
        if not path.startswith(str(_provider_home(kind))):
            continue
        st = entry.get("st") or {}
        if (st.get("id") if kind == "codex" else None) == sid or _default_id(kind, path) == sid:
            return path
    if kind == "claude":
        for p in (_provider_home("claude") / "projects").glob(f"*/{sid}.jsonl"):
            return str(p)
    else:
        for root, _d, names in os.walk(_provider_home("codex")):
            for n in names:
                if n.endswith(f"{sid}.jsonl"):
                    return os.path.join(root, n)
    return None


def _tool(kind: str, text: str) -> dict:
    return {"k": kind, "t": _clip(text.replace("\n", " "), 160)}


def _claude_tool(block: dict) -> dict:
    name = str(block.get("name") or "tool")
    inp = block.get("input") if isinstance(block.get("input"), dict) else {}
    low = name.lower()
    if low in ("edit", "write", "multiedit", "notebookedit"):
        return _tool("edit", str(inp.get("file_path") or inp.get("notebook_path") or name))
    if low == "read":
        return _tool("read", str(inp.get("file_path") or name))
    if low == "bash":
        return _tool("cmd", str(inp.get("command") or name))
    if low in ("grep", "glob"):
        return _tool("search", str(inp.get("pattern") or name))
    if low in ("webfetch", "websearch"):
        return _tool("web", str(inp.get("url") or inp.get("query") or name))
    if low in ("task", "agent"):
        return _tool("agent", str(inp.get("description") or inp.get("prompt") or name))
    return _tool("other", name)


def _codex_tool(p: dict) -> list[dict]:
    t = p.get("type")
    name = str(p.get("name") or "")
    if t == "custom_tool_call" and name == "apply_patch":
        body = str(p.get("input") or "")
        files = re.findall(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", body, flags=re.M)
        return [_tool("edit", f) for f in files] or [_tool("edit", "apply_patch")]
    if t in ("function_call", "local_shell_call"):
        args: Any = p.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        if t == "local_shell_call":
            args = (p.get("action") or {}) if isinstance(p.get("action"), dict) else {}
        cmd = args.get("command") or args.get("cmd") if isinstance(args, dict) else None
        if isinstance(cmd, list):
            cmd = " ".join(str(c) for c in cmd[-1:] if c) if cmd[:2] == ["bash", "-lc"] else " ".join(map(str, cmd))
        if cmd:
            return [_tool("cmd", str(cmd))]
        return [_tool("other", name or t)]
    return []


def _turns(kind: str, lines: Iterable[dict]) -> list[dict]:
    """Exchanges in order: a human prompt, then what the agent said and did."""
    turns: list[dict] = []
    cur: dict | None = None
    lines = list(lines)
    events = kind == "codex" and any(
        _codex_normalize(d)[0] == "event_msg" and _codex_normalize(d)[1].get("type") == "user_message"
        for d in lines)
    for d in lines:
        if kind == "claude":
            t = d.get("type")
            if t == "user":
                text = _claude_prompt(d)
                if text is not None:
                    cur = {"user": _clip(text, PREVIEW_TEXT_MAX), "answer": "", "tools": [], "at": d.get("timestamp")}
                    turns.append(cur)
            elif t == "assistant" and cur is not None and not d.get("isSidechain"):
                msg = d.get("message") if isinstance(d.get("message"), dict) else {}
                for b in msg.get("content") or []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text" and (b.get("text") or "").strip():
                        cur["answer"] = _clip(b["text"], PREVIEW_TEXT_MAX)
                    elif b.get("type") == "tool_use":
                        cur["tools"].append(_claude_tool(b))
        else:
            k, p = _codex_normalize(d)
            pt = p.get("type")
            # Older rollouts mirror each message as an event (user_message /
            # agent_message); newer ones only write response items. Prefer the
            # events when the file has them, else read the messages.
            user = asst = None
            if events:
                if k == "event_msg" and pt == "user_message":
                    user = p.get("message")
                elif k == "event_msg" and pt == "agent_message":
                    asst = p.get("message")
            elif k == "response_item" and pt == "message":
                if p.get("role") == "user":
                    user = _blocks_text(p.get("content"))
                elif p.get("role") == "assistant":
                    asst = _blocks_text(p.get("content"))
            if isinstance(user, str):
                user = _codex_request(user)
            if isinstance(user, str) and not _is_injection(user):
                cur = {"user": _clip(user, PREVIEW_TEXT_MAX), "answer": "", "tools": [], "at": d.get("timestamp")}
                turns.append(cur)
            elif cur is not None and isinstance(asst, str) and asst.strip():
                cur["answer"] = _clip(asst, PREVIEW_TEXT_MAX)
            elif cur is not None and k == "response_item":
                cur["tools"].extend(_codex_tool(p))
    for t in turns:
        tools, seen = [], {}
        for x in t["tools"]:
            key = (x["k"], x["t"])
            if key in seen:
                seen[key]["n"] = seen[key].get("n", 1) + 1
                continue
            seen[key] = x
            tools.append(x)
        t["more_tools"] = max(0, len(tools) - PREVIEW_TOOLS_MAX)
        t["tools"] = tools[-PREVIEW_TOOLS_MAX:]
    return turns


def preview(params: dict) -> dict:
    """history_preview {kind, session_id, turns?} → {ok, first, turns, prompts}."""
    kind = str(params.get("kind") or "")
    sid = str(params.get("session_id") or "")
    want = params.get("turns")
    want = max(1, min(30, int(want))) if isinstance(want, (int, float)) else 3
    if kind not in _FEED or not _ID_RE.match(sid):
        return {"ok": False, "reason": "invalid", "error": "kind and session_id are required"}
    with _lock:
        path = _locate(kind, sid)
    if not path:
        return {"ok": False, "reason": "missing", "error": "no transcript for this session on the VPS"}
    # Containment on RESOLVED paths: an account home links its `projects`
    # to the shared one (§14.115), so the root is resolved too.
    real = os.path.realpath(path)
    home = _provider_home(kind)
    roots = [home / "projects"] if kind == "claude" else [home / "sessions", home / "archived_sessions"]
    if not any(real.startswith(os.path.realpath(str(r)) + os.sep) for r in roots):
        return {"ok": False, "reason": "invalid", "error": "outside the provider history"}
    try:
        size = os.path.getsize(path)
        head = _turns(kind, _iter_lines(_read(path, 0, min(size, HEAD_BYTES)), drop_first=False))
        turns: list[dict] = []
        for chunk in PREVIEW_CHUNKS:
            start = max(0, size - chunk)
            turns = _turns(kind, _iter_lines(_read(path, start, size - start), drop_first=start > 0))
            # The first turn of a mid-file chunk may be cut: keep it only
            # when the chunk is the whole file.
            if start > 0 and turns:
                turns = turns[1:]
            if len(turns) >= want + 1 or start == 0:
                break
    except OSError as e:
        return {"ok": False, "reason": "error", "error": str(e)}
    first = head[0] if head else (turns[0] if turns else None)
    shown = turns[-want:]
    # The first request has its own bubble: never repeat it as an exchange.
    if first is not None and shown and shown[0].get("at") == first.get("at") and shown[0]["user"] == first["user"]:
        shown = shown[1:]
    return {"ok": True, "first": first["user"] if first else "", "turns": shown}
