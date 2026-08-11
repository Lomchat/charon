"""Language servers, hosted next to the code (agent >= 0.33.0). CLAUDE.md §14.89

An editor that only colours text is a lexer with a theme: it does not know
that `getSession` lives in another file, that this argument is the wrong type,
or that you just misspelled a name. Everything that makes an IDE an IDE comes
from a LANGUAGE SERVER — `pyright`, `typescript-language-server`, `gopls`,
`rust-analyzer` — a separate program that parses the project and answers
questions over the Language Server Protocol.

That program has to run WHERE THE CODE IS: it needs the node_modules, the
tsconfig, the venv. That is this machine. And the daemon already is what a
language server needs — a long-lived process host with a multiplexed pipe back
to the hub — so hosting them here costs no new connection and no open port.

Design notes, all of them load-bearing:

  * LSP frames are `Content-Length: N\\r\\n\\r\\n<json>` over stdio, NOT lines.
    A reader that splits on newlines corrupts every payload containing one.
  * The hub is HTTP request/response, so this module OWNS the correlation:
    `lsp_request` sends and waits for the matching response id; server->client
    notifications (diagnostics!) are accumulated here and collected by polling.
    Relaying raw LSP over our event bus was the alternative and it is worse:
    diagnostics are per-file and bursty, and the browser needs them for ONE
    file at a time.
  * Everything is bounded: a cap on servers, an idle timeout, a request
    timeout, a diagnostics cap per file. A language server is the heaviest
    thing this daemon will ever spawn (pyright is 200-400MB on a big repo) and
    it must never be able to accumulate.
  * Nothing raises. A missing binary, a crashed server, a malformed frame all
    come back as `ok: False` with a reason the UI can show.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from typing import Any

# One server per (root, language). Beyond this, the oldest idle one is stopped:
# a fleet VPS is not a workstation and a runaway set of language servers is the
# fastest way to OOM a small box.
MAX_SERVERS = 4
IDLE_STOP_S = 900.0          # no request for 15 min → stop it
REQUEST_TIMEOUT_S = 20.0     # a single LSP request
START_TIMEOUT_S = 60.0       # initialize handshake
MAX_DIAGNOSTICS = 300        # per file
MAX_FRAME_BYTES = 16 * 1024 * 1024

# What we know how to start, in preference order. `args` is appended to the
# binary; every one of these speaks stdio LSP.
#
# NOT installed by Charon on purpose: a language server is a project-level
# choice (a pinned typescript, a project's own pyright) and silently pulling
# one in would be both surprising and frequently wrong. If it isn't there we
# say so, with the command to install it.
SERVERS: dict[str, list[dict[str, Any]]] = {
    "typescript": [
        {"bin": "typescript-language-server", "args": ["--stdio"],
         "install": "npm i -g typescript-language-server typescript"},
        {"bin": "vtsls", "args": ["--stdio"], "install": "npm i -g @vtsls/language-server"},
    ],
    "python": [
        {"bin": "pyright-langserver", "args": ["--stdio"], "install": "npm i -g pyright"},
        {"bin": "pylsp", "args": [], "install": "pip install python-lsp-server"},
        {"bin": "jedi-language-server", "args": [], "install": "pip install jedi-language-server"},
    ],
    "go": [{"bin": "gopls", "args": ["serve"], "install": "go install golang.org/x/tools/gopls@latest"}],
    "rust": [{"bin": "rust-analyzer", "args": [], "install": "rustup component add rust-analyzer"}],
    "c": [{"bin": "clangd", "args": [], "install": "apt install clangd"}],
    "cpp": [{"bin": "clangd", "args": [], "install": "apt install clangd"}],
    "php": [{"bin": "intelephense", "args": ["--stdio"], "install": "npm i -g intelephense"}],
    "ruby": [{"bin": "solargraph", "args": ["stdio"], "install": "gem install solargraph"}],
    "bash": [{"bin": "bash-language-server", "args": ["start"], "install": "npm i -g bash-language-server"}],
    "json": [{"bin": "vscode-json-language-server", "args": ["--stdio"],
              "install": "npm i -g vscode-langservers-extracted"}],
    "yaml": [{"bin": "yaml-language-server", "args": ["--stdio"], "install": "npm i -g yaml-language-server"}],
}

# Extension → LSP language id. The id matters: servers key their behaviour on
# it (a .tsx is `typescriptreact`, not `typescript`).
EXT_LANG: dict[str, str] = {
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "javascriptreact",
    ".py": "python", ".pyi": "python",
    ".go": "go",
    ".rs": "rust",
    ".c": "c", ".h": "c",
    ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".php": "php",
    ".rb": "ruby",
    ".sh": "shellscript", ".bash": "shellscript",
    ".json": "json", ".jsonc": "json",
    ".yaml": "yaml", ".yml": "yaml",
}

# Which SERVERS entry serves a given LSP language id.
LANG_FAMILY: dict[str, str] = {
    "typescript": "typescript", "typescriptreact": "typescript",
    "javascript": "typescript", "javascriptreact": "typescript",
    "python": "python", "go": "go", "rust": "rust",
    "c": "c", "cpp": "cpp", "php": "php", "ruby": "ruby",
    "shellscript": "bash", "json": "json", "yaml": "yaml",
}


def language_for(path: str) -> str | None:
    return EXT_LANG.get(os.path.splitext(path)[1].lower())


def _find_server(family: str) -> dict[str, Any] | None:
    for cand in SERVERS.get(family, []):
        found = shutil.which(cand["bin"])
        if found:
            return {**cand, "path": found}
    return None


def path_to_uri(p: str) -> str:
    from urllib.parse import quote
    return "file://" + quote(os.path.abspath(p))


def uri_to_path(u: str) -> str:
    from urllib.parse import unquote, urlparse
    if not u.startswith("file://"):
        return u
    return unquote(urlparse(u).path)


class _Server:
    """One language server process, plus the bookkeeping to talk to it."""

    def __init__(self, key: str, root: str, family: str, spec: dict[str, Any]) -> None:
        self.key = key
        self.root = root
        self.family = family
        self.spec = spec
        self.proc: subprocess.Popen[bytes] | None = None
        self.next_id = 1
        self.lock = threading.Lock()
        self.pending: dict[int, dict[str, Any]] = {}      # id → {"ev", "result", "error"}
        # uri → the last publishDiagnostics payload, plus a monotonic version
        # so a poller can tell "nothing new" from "no diagnostics".
        self.diagnostics: dict[str, list[dict[str, Any]]] = {}
        self.diag_version = 0
        self.open_docs: dict[str, int] = {}               # uri → document version
        self.capabilities: dict[str, Any] = {}
        self.started_at = 0.0
        self.last_used = time.monotonic()
        self.dead_reason: str | None = None
        self._reader: threading.Thread | None = None

    # ── framing ─────────────────────────────────────────────────────────────
    def _write(self, msg: dict[str, Any]) -> bool:
        p = self.proc
        if p is None or p.stdin is None or p.poll() is not None:
            return False
        body = json.dumps(msg).encode("utf-8")
        head = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        try:
            with self.lock:
                p.stdin.write(head + body)
                p.stdin.flush()
            return True
        except (OSError, ValueError):
            return False

    def _read_loop(self) -> None:
        """Frames, not lines: an LSP payload contains newlines constantly."""
        p = self.proc
        assert p is not None and p.stdout is not None
        stream = p.stdout
        try:
            while True:
                length = 0
                # Headers, terminated by a blank line.
                while True:
                    line = stream.readline()
                    if not line:
                        raise EOFError
                    if line in (b"\r\n", b"\n"):
                        break
                    if line.lower().startswith(b"content-length:"):
                        try:
                            length = int(line.split(b":", 1)[1].strip())
                        except ValueError:
                            length = 0
                if length <= 0 or length > MAX_FRAME_BYTES:
                    # Unusable frame: resyncing on a byte stream is guesswork,
                    # so treat it as fatal and let the hub restart us.
                    raise EOFError
                buf = stream.read(length)
                if buf is None or len(buf) < length:
                    raise EOFError
                try:
                    msg = json.loads(buf.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    continue
                self._dispatch(msg)
        except Exception as ex:                     # noqa: BLE001 - never raise off-thread
            self.dead_reason = self.dead_reason or f"language server stopped ({type(ex).__name__})"
            # Wake everyone waiting, or they'd sit until their timeout.
            for slot in list(self.pending.values()):
                slot.setdefault("error", {"message": self.dead_reason})
                slot["ev"].set()

    def _dispatch(self, msg: dict[str, Any]) -> None:
        mid = msg.get("id")
        if mid is not None and ("result" in msg or "error" in msg):
            slot = self.pending.get(mid)
            if slot is not None:
                slot["result"] = msg.get("result")
                slot["error"] = msg.get("error")
                slot["ev"].set()
            return
        method = msg.get("method")
        if method == "textDocument/publishDiagnostics":
            params = msg.get("params") or {}
            uri = str(params.get("uri") or "")
            diags = params.get("diagnostics")
            if uri:
                self.diagnostics[uri] = (diags or [])[:MAX_DIAGNOSTICS]
                self.diag_version += 1
            return
        # Server->client REQUESTS (workspace/configuration,
        # client/registerCapability, workDoneProgress/create…). Answering
        # something bland keeps servers happy; ignoring them makes several of
        # them stall waiting for a reply that never comes.
        if mid is not None and method:
            if method == "workspace/configuration":
                items = ((msg.get("params") or {}).get("items") or [])
                self._write({"jsonrpc": "2.0", "id": mid, "result": [{} for _ in items]})
            else:
                self._write({"jsonrpc": "2.0", "id": mid, "result": None})

    # ── lifecycle ───────────────────────────────────────────────────────────
    def start(self) -> dict[str, Any]:
        env = os.environ.copy()
        env.setdefault("NODE_OPTIONS", "--max-old-space-size=1024")
        try:
            self.proc = subprocess.Popen(
                [self.spec["path"], *self.spec["args"]],
                cwd=self.root, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )
        except OSError as ex:
            return {"ok": False, "error": f"could not start {self.spec['bin']}: {ex}", "reason": "spawn"}
        self.started_at = time.monotonic()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

        init = self.request("initialize", {
            "processId": os.getpid(),
            "rootUri": path_to_uri(self.root),
            "workspaceFolders": [{"uri": path_to_uri(self.root), "name": os.path.basename(self.root)}],
            "capabilities": {
                "textDocument": {
                    "synchronization": {"didSave": True, "dynamicRegistration": False},
                    "publishDiagnostics": {"relatedInformation": False},
                    "hover": {"contentFormat": ["markdown", "plaintext"]},
                    "definition": {"linkSupport": False},
                    "completion": {
                        "completionItem": {"snippetSupport": False, "documentationFormat": ["plaintext"]},
                        "contextSupport": True,
                    },
                },
                "workspace": {"configuration": True, "workspaceFolders": True},
            },
            "initializationOptions": {},
        }, timeout=START_TIMEOUT_S)
        if not init.get("ok"):
            self.stop()
            return {"ok": False, "error": init.get("error") or "initialize failed", "reason": "init"}
        self.capabilities = (init.get("result") or {}).get("capabilities") or {}
        self.notify("initialized", {})
        return {"ok": True}

    def stop(self) -> None:
        p = self.proc
        self.proc = None
        if p is None:
            return
        try:
            p.terminate()
            p.wait(timeout=3)
        except Exception:                            # noqa: BLE001
            try:
                p.kill()
            except Exception:                        # noqa: BLE001
                pass

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    # ── talking ─────────────────────────────────────────────────────────────
    def request(self, method: str, params: Any, timeout: float = REQUEST_TIMEOUT_S) -> dict[str, Any]:
        self.last_used = time.monotonic()
        mid = self.next_id
        self.next_id += 1
        ev = threading.Event()
        slot: dict[str, Any] = {"ev": ev}
        self.pending[mid] = slot
        try:
            if not self._write({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}):
                return {"ok": False, "error": self.dead_reason or "language server is not running",
                        "reason": "dead"}
            if not ev.wait(timeout):
                return {"ok": False, "error": f"{method} timed out after {int(timeout)}s", "reason": "timeout"}
            if slot.get("error"):
                return {"ok": False, "error": str((slot["error"] or {}).get("message") or "lsp error"),
                        "reason": "lsp"}
            return {"ok": True, "result": slot.get("result")}
        finally:
            self.pending.pop(mid, None)

    def notify(self, method: str, params: Any) -> bool:
        self.last_used = time.monotonic()
        return self._write({"jsonrpc": "2.0", "method": method, "params": params})


# key = f"{root}\x00{family}"
_servers: dict[str, _Server] = {}
_servers_lock = threading.Lock()


def _reap_idle(now: float | None = None) -> None:
    now = now if now is not None else time.monotonic()
    for key, s in list(_servers.items()):
        if not s.alive() or now - s.last_used > IDLE_STOP_S:
            s.stop()
            _servers.pop(key, None)


def _get(root: str, family: str, spawn: bool) -> tuple[_Server | None, dict[str, Any] | None]:
    key = f"{root}\x00{family}"
    with _servers_lock:
        _reap_idle()
        s = _servers.get(key)
        if s is not None and s.alive():
            return s, None
        if s is not None:
            _servers.pop(key, None)
        if not spawn:
            return None, {"ok": False, "error": "no language server running", "reason": "not_started"}
        spec = _find_server(family)
        if spec is None:
            cands = SERVERS.get(family, [])
            return None, {
                "ok": False, "reason": "missing",
                "error": f"no language server for {family} on this VPS",
                "install": cands[0]["install"] if cands else None,
                "binaries": [c["bin"] for c in cands],
            }
        if len(_servers) >= MAX_SERVERS:
            oldest = min(_servers.values(), key=lambda x: x.last_used)
            oldest.stop()
            _servers.pop(oldest.key, None)
        s = _Server(key, root, family, spec)
        r = s.start()
        if not r.get("ok"):
            return None, r
        _servers[key] = s
        return s, None


def _resolve(root: str, path: str, spawn: bool = True) -> tuple[_Server | None, str, str, dict[str, Any] | None]:
    """(server, language id, uri, error)."""
    lang = language_for(path)
    if lang is None:
        return None, "", "", {"ok": False, "reason": "unsupported",
                              "error": f"no language server maps to {os.path.splitext(path)[1] or 'this file'}"}
    family = LANG_FAMILY.get(lang)
    if family is None:
        return None, lang, "", {"ok": False, "reason": "unsupported", "error": f"unsupported language {lang}"}
    s, err = _get(root, family, spawn)
    if s is None:
        return None, lang, "", err
    return s, lang, path_to_uri(path), None


# ── RPCs ────────────────────────────────────────────────────────────────────
def lsp_status(params: dict[str, Any]) -> dict[str, Any]:
    """What is available and what is running — for the editor's status line.

    Answers WITHOUT spawning anything: the editor asks this on every file it
    opens, and starting a language server because someone glanced at a file is
    exactly the behaviour that eats a small VPS.
    """
    root = str(params.get("root") or "")
    path = str(params.get("path") or "")
    lang = language_for(path) if path else None
    family = LANG_FAMILY.get(lang or "")
    spec = _find_server(family) if family else None
    key = f"{root}\x00{family}"
    with _servers_lock:
        _reap_idle()
        running = key in _servers and _servers[key].alive()
    cands = SERVERS.get(family or "", [])
    return {
        "ok": True,
        "language": lang,
        "family": family,
        "available": spec is not None,
        "server": spec["bin"] if spec else None,
        "running": running,
        "install": (cands[0]["install"] if cands else None) if spec is None else None,
        "servers": [
            {"root": s.root, "family": s.family, "bin": s.spec["bin"], "idle_s": int(time.monotonic() - s.last_used)}
            for s in _servers.values()
        ],
    }


def lsp_open(params: dict[str, Any]) -> dict[str, Any]:
    """didOpen (or didChange) a document, and return the current diagnostics.

    One entry point for both because the editor's need is the same: "here is
    the text, tell me what's wrong with it". The server answers asynchronously,
    so the diagnostics returned here are whatever it has said SO FAR — the
    editor polls `lsp_diagnostics` for the rest.
    """
    root = str(params.get("root") or "")
    path = str(params.get("path") or "")
    text = params.get("text")
    s, lang, uri, err = _resolve(root, path)
    if s is None:
        return err or {"ok": False, "error": "no server", "reason": "missing"}
    if not isinstance(text, str):
        return {"ok": False, "error": "text required", "reason": "bad_params"}

    version = s.open_docs.get(uri, 0) + 1
    s.open_docs[uri] = version
    if version == 1:
        s.notify("textDocument/didOpen", {
            "textDocument": {"uri": uri, "languageId": lang, "version": version, "text": text},
        })
    else:
        s.notify("textDocument/didChange", {
            "textDocument": {"uri": uri, "version": version},
            "contentChanges": [{"text": text}],       # full sync: simple and correct
        })
    return {"ok": True, "version": version, "diagnostics": s.diagnostics.get(uri, []),
            "diag_version": s.diag_version, "server": s.spec["bin"]}


def lsp_close(params: dict[str, Any]) -> dict[str, Any]:
    root = str(params.get("root") or "")
    path = str(params.get("path") or "")
    s, _lang, uri, err = _resolve(root, path, spawn=False)
    if s is None:
        return {"ok": True}                          # nothing open, nothing to do
    if uri in s.open_docs:
        s.notify("textDocument/didClose", {"textDocument": {"uri": uri}})
        s.open_docs.pop(uri, None)
        s.diagnostics.pop(uri, None)
    return {"ok": True}


def lsp_diagnostics(params: dict[str, Any]) -> dict[str, Any]:
    """The diagnostics a server has pushed for one file.

    LONG-POLLS: with `wait` seconds and a `since` version, this returns as soon
    as something changes, so squiggles appear without a 300ms polling loop
    hammering the ssh pipe. It always returns — a timeout is `changed: False`,
    not an error.
    """
    root = str(params.get("root") or "")
    path = str(params.get("path") or "")
    since = int(params.get("since") or 0)
    wait = max(0.0, min(float(params.get("wait") or 0), 25.0))
    s, _lang, uri, err = _resolve(root, path, spawn=False)
    if s is None:
        return {"ok": True, "diagnostics": [], "diag_version": 0, "changed": False, "running": False}

    deadline = time.monotonic() + wait
    while s.diag_version <= since and time.monotonic() < deadline and s.alive():
        time.sleep(0.15)
    return {
        "ok": True,
        "diagnostics": s.diagnostics.get(uri, []),
        "diag_version": s.diag_version,
        "changed": s.diag_version > since,
        "running": s.alive(),
    }


def lsp_request(params: dict[str, Any]) -> dict[str, Any]:
    """One position-based LSP request: hover, definition, completion, …

    An allow-list, not a pass-through. The hub is not a VPN into somebody's
    language server: `workspace/executeCommand` can run arbitrary code in
    several of them.
    """
    ALLOWED = {
        "textDocument/hover",
        "textDocument/definition",
        "textDocument/typeDefinition",
        "textDocument/implementation",
        "textDocument/references",
        "textDocument/completion",
        "textDocument/documentSymbol",
        "textDocument/signatureHelp",
        "completionItem/resolve",
    }
    method = str(params.get("method") or "")
    if method not in ALLOWED:
        return {"ok": False, "error": f"method not allowed: {method}", "reason": "bad_params"}
    root = str(params.get("root") or "")
    path = str(params.get("path") or "")
    s, _lang, uri, err = _resolve(root, path)
    if s is None:
        return err or {"ok": False, "error": "no server", "reason": "missing"}

    body: dict[str, Any] = {"textDocument": {"uri": uri}}
    pos = params.get("position")
    if isinstance(pos, dict):
        body["position"] = {"line": int(pos.get("line") or 0), "character": int(pos.get("character") or 0)}
    extra = params.get("extra")
    if isinstance(extra, dict):
        body.update(extra)
    if method == "completionItem/resolve":
        item = params.get("item")
        if not isinstance(item, dict):
            return {"ok": False, "error": "item required", "reason": "bad_params"}
        body = item

    r = s.request(method, body)
    if not r.get("ok"):
        return r
    return {"ok": True, "result": r.get("result"), "server": s.spec["bin"]}


def lsp_stop(params: dict[str, Any]) -> dict[str, Any]:
    """Stop the server(s) for a root, or every one of them."""
    root = str(params.get("root") or "")
    with _servers_lock:
        for key, s in list(_servers.items()):
            if not root or s.root == root:
                s.stop()
                _servers.pop(key, None)
    return {"ok": True}


def shutdown_all() -> None:
    """Called on daemon exit — a language server must not outlive us."""
    with _servers_lock:
        for s in list(_servers.values()):
            s.stop()
        _servers.clear()
