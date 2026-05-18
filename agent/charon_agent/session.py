"""Wrapper autour de ClaudeSDKClient — une instance par session.

Porté depuis lib/server/claude/bridge.py de Charon. Les events ne sortent plus
sur stdout : ils sont passés à un callback `emit` fourni par le server (qui les
tagge avec session_id et les broadcast à tous les clients subscribés).

Lifecycle :
  s = AgentSession(session_id, cwd, ..., emit_callback)
  await s.start()              # connecte au SDK
  await s.send_input("hello")  # push une query
  await s.stop()               # ferme proprement
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import traceback
from typing import Any, Awaitable, Callable

try:
    from claude_agent_sdk import (
        ClaudeAgentOptions,
        ClaudeSDKClient,
        HookMatcher,
    )
    SDK_AVAILABLE = True
    SDK_IMPORT_ERROR: str | None = None
except ImportError as e:  # pragma: no cover - dépend de l'env distant
    ClaudeAgentOptions = None  # type: ignore
    ClaudeSDKClient = None  # type: ignore
    HookMatcher = None  # type: ignore
    SDK_AVAILABLE = False
    SDK_IMPORT_ERROR = str(e)


EmitCallback = Callable[[dict[str, Any]], None]
StateSaveCallback = Callable[[], Awaitable[None] | None]


# Outils auto-allowed universellement (toutes modes)
AUTO_ALLOW_TOOLS = {"TodoWrite", "ExitPlanMode"}

# Outils auto-allowed en plan mode seulement
PLAN_MODE_SAFE_TOOLS = {
    "Read", "Grep", "Glob", "LS", "NotebookRead",
    "WebFetch", "WebSearch",
    "TodoWrite",
}

# Commandes Bash read-only auto-allow en plan mode (premier mot après strip path)
PLAN_MODE_SAFE_BASH = {
    "ls", "dir", "cat", "head", "tail", "more", "less", "find",
    "pwd", "echo", "printf", "date", "whoami", "hostname", "id", "uname",
    "grep", "egrep", "fgrep", "rg", "ag",
    "wc", "file", "du", "df", "stat", "basename", "dirname", "realpath", "readlink",
    "ps", "top", "free", "uptime", "env", "printenv",
    "which", "type", "command", "whereis",
    "sort", "uniq", "cut", "tr", "awk",
    "jq", "yq", "xmllint", "column",
    "true", "false", ":",
    "tree",
    "git",
    "node", "python", "python3", "pip", "pip3", "npm", "yarn", "pnpm",
}

GIT_READ_SUBCMDS = {
    "log", "diff", "status", "show", "branch", "remote", "config",
    "blame", "describe", "rev-parse", "ls-files", "ls-tree", "tag",
    "shortlog",
}

# Patterns dangereux : si présent, on refuse l'auto-allow Bash
DANGEROUS_PATTERNS = (
    " rm ", " rm\t", " rm -", "; rm", "|rm", "&& rm", "rm -rf",
    " mv ", " cp ", " dd ", " mkfs", " chmod ", " chown ",
    " mount ", " umount ", " sudo ", " su ", " kill ", " pkill ",
    ">/dev/", " tee ", "tee ", "curl ", "wget ",
    "-i ",
    " >> ", " > ",
)

# Outils de snapshot avant/après édition (le client UI affiche un diff)
SNAPSHOT_TOOLS = {"Edit", "Write", "MultiEdit"}
SNAPSHOT_MAX = 256 * 1024  # 256KB par snapshot

# file_path toujours auto-allowed sur Write/Edit (plans Claude, /tmp)
AUTO_ALLOW_WRITE_PREFIXES = (
    "/root/.claude/plans/",
    "/tmp/",
)


def _is_safe_bash(command: str | None) -> bool:
    """Heuristique : la commande est-elle entièrement read-only ?"""
    if not isinstance(command, str) or not command.strip():
        return False
    c = " " + command.strip() + " "
    # Tolère 2>/dev/null et > /dev/null
    c_clean = c.replace("2>/dev/null", " ").replace("2> /dev/null", " ")
    c_clean = c_clean.replace(" > /dev/null", " ").replace(" >/dev/null", " ")
    for pat in DANGEROUS_PATTERNS:
        if pat in c_clean:
            return False
    segments = re.split(r"\|\||&&|;|\|", command)
    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        tokens = seg.split()
        if not tokens:
            continue
        # Skip env=val prefix
        i = 0
        while i < len(tokens) and "=" in tokens[i] and not tokens[i].startswith("-"):
            i += 1
        if i >= len(tokens):
            return False
        first = tokens[i].rsplit("/", 1)[-1]
        if first not in PLAN_MODE_SAFE_BASH:
            return False
        if first == "git" and i + 1 < len(tokens):
            sub = tokens[i + 1]
            if sub not in GIT_READ_SUBCMDS:
                return False
        if first in ("node", "python", "python3"):
            rest = tokens[i + 1:]
            if any(t in ("-e", "-c", "--exec") for t in rest):
                return False
            if rest and not any(t.startswith("-") for t in rest):
                return False  # exécute un fichier
        if first in ("pip", "pip3", "npm", "yarn", "pnpm"):
            rest = tokens[i + 1:]
            read_only_sub = {"list", "show", "outdated", "info", "view", "ls", "search"}
            if not rest or rest[0] not in read_only_sub:
                return False
    return True


class AgentSession:
    """Une session Claude isolée dans l'agent. Vit indépendamment des clients."""

    def __init__(
        self,
        session_id: str,
        *,
        cwd: str,
        name: str | None,
        permission_mode: str,
        claude_session_id: str | None,
        emit: EmitCallback,
        on_state_change: StateSaveCallback,
    ) -> None:
        self.session_id = session_id
        self.cwd = cwd
        self.name = name
        self.permission_mode = permission_mode if permission_mode in (
            "normal", "acceptEdits", "bypass", "plan",
        ) else "normal"
        self.claude_session_id = claude_session_id
        self._emit_to_server = emit
        self._on_state_change = on_state_change

        self.status: str = "starting"
        self._client: Any = None  # ClaudeSDKClient
        self._client_ctx: Any = None
        self._main_task: asyncio.Task | None = None
        self._stdin_queue: asyncio.Queue = asyncio.Queue()
        self._pending_perms: dict[str, asyncio.Future] = {}
        self._session_id_emitted = False
        self._current_assistant = ""
        self._claude_stderr_lines: list[str] = []
        self._plan_accepted = False
        self._stopped = asyncio.Event()
        self._ready_evt = asyncio.Event()
        self._error_msg: str | None = None

    # ── Public API ───────────────────────────────────────────────────────────
    async def start(self) -> None:
        """Lance la session : démarre une task qui maintient le SDK ouvert."""
        if self._main_task is not None:
            return
        if not SDK_AVAILABLE:
            self.status = "error"
            self._error_msg = f"claude_agent_sdk non importable: {SDK_IMPORT_ERROR}"
            self._emit("error", msg=self._error_msg, fatal=True)
            self._emit("status", status="error")
            await self._save_state()
            return
        self._main_task = asyncio.create_task(self._run(), name=f"session-{self.session_id}")

    async def stop(self, *, mark: str = "sleeping") -> None:
        """Arrête proprement la session (mark : 'sleeping' ou 'killed')."""
        self.status = mark
        self._emit("status", status=mark)
        # Annule les promesses en cours pour ne pas laisser le main loop pendu
        for fut in self._pending_perms.values():
            if not fut.done():
                fut.cancel()
        self._pending_perms.clear()
        await self._stdin_queue.put(None)  # EOF
        if self._main_task is not None:
            try:
                await asyncio.wait_for(self._main_task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._main_task.cancel()
        self._main_task = None
        self._stopped.set()
        await self._save_state()

    async def send_input(self, content: str) -> None:
        if self.status not in ("active", "thinking", "starting"):
            raise RuntimeError(f"session {self.session_id} not running (status={self.status})")
        await self._stdin_queue.put({"type": "user_message", "content": content})

    async def interrupt(self) -> None:
        if self._client is None:
            return
        try:
            await self._client.interrupt()
            self._emit("interrupted")
        except Exception as e:
            self._emit("error", msg=f"interrupt: {e}")

    async def set_permission_mode(self, mode: str) -> None:
        if mode not in ("normal", "acceptEdits", "bypass", "plan"):
            mode = "normal"
        self.permission_mode = mode
        # Skip mode "auto" (bypass interne) : le CLI refuse --dangerously en root.
        # On reste "default" côté SDK et nos hooks PreToolUse font l'auto-allow.
        sdk_mode = "plan" if mode == "plan" else "default"
        if self._client is not None:
            try:
                await self._client.set_permission_mode(sdk_mode)
            except Exception as e:
                self._emit("error", msg=f"set_permission_mode SDK: {e}")
        self._emit("mode_changed", mode=mode)
        await self._save_state()

    def respond_permission(self, perm_id: str, allow: bool) -> None:
        fut = self._pending_perms.pop(perm_id, None)
        if fut is not None and not fut.done():
            fut.set_result(bool(allow))

    def respond_question(self, q_id: str, answers: dict | None) -> None:
        fut = self._pending_perms.pop(q_id, None)
        if fut is not None and not fut.done():
            fut.set_result(answers)

    def respond_exit_plan(self, q_id: str, decision: str, feedback: str = "") -> None:
        fut = self._pending_perms.pop(q_id, None)
        if fut is not None and not fut.done():
            fut.set_result({"decision": decision, "feedback": feedback})

    def to_info(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "claude_session_id": self.claude_session_id,
            "cwd": self.cwd,
            "name": self.name,
            "permission_mode": self.permission_mode,
            "status": self.status,
        }

    def to_persist(self) -> dict[str, Any]:
        # Statut persisté : reflète l'état actuel. Au boot, _restore_existing
        # ne restaure PAS les sessions "killed" ni "sleeping" (pause explicite),
        # mais reprend "active" / "thinking" / "starting" / "error".
        persist_status = self.status
        if persist_status in ("starting", "thinking"):
            persist_status = "active"
        return {
            "session_id": self.session_id,
            "claude_session_id": self.claude_session_id,
            "cwd": self.cwd,
            "name": self.name,
            "permission_mode": self.permission_mode,
            "status": persist_status,
        }

    # ── Internals ────────────────────────────────────────────────────────────
    def _emit(self, event: str, **fields: Any) -> None:
        msg = {"event": event, "session_id": self.session_id}
        msg.update(fields)
        try:
            self._emit_to_server(msg)
        except Exception:
            traceback.print_exc(file=sys.stderr)

    async def _save_state(self) -> None:
        try:
            res = self._on_state_change()
            if asyncio.iscoroutine(res):
                await res
        except Exception:
            traceback.print_exc(file=sys.stderr)

    def _on_claude_stderr(self, line: str) -> None:
        s = line.rstrip("\n")
        if not s:
            return
        self._claude_stderr_lines.append(s)
        if len(self._claude_stderr_lines) > 120:
            self._claude_stderr_lines = self._claude_stderr_lines[-120:]
        # Mirror dans notre stderr pour debug local
        print(f"[claude {self.session_id}] {s}", file=sys.stderr, flush=True)

    def _captured_stderr(self) -> str:
        return "\n".join(self._claude_stderr_lines).strip()

    def _format_err(self, label: str, e: Exception) -> str:
        parts = [f"{label}: {e}"]
        for attr in ("exit_code", "cmd"):
            v = getattr(e, attr, None)
            if v is not None:
                parts.append(f"{attr}={v}")
        captured = self._captured_stderr()
        if captured:
            parts.append("--- stderr du claude CLI ---\n" + captured[-3000:])
        sdk_stderr = getattr(e, "stderr", None)
        if sdk_stderr and "Check stderr output for details" not in str(sdk_stderr):
            parts.append("--- SDK.e.stderr ---\n" + str(sdk_stderr)[:1000])
        parts.append("--- traceback ---\n" + traceback.format_exc())
        return "\n".join(parts)

    # ── Hooks ────────────────────────────────────────────────────────────────
    def _snapshot_file(self, file_path: str, phase: str, tool_use_id: str | None) -> None:
        try:
            with open(file_path, "r", errors="replace") as f:
                content = f.read()
            size = len(content)
            truncated = False
            if size > SNAPSHOT_MAX:
                content = content[:SNAPSHOT_MAX]
                truncated = True
            self._emit(
                "edit_snapshot",
                phase=phase,
                tool_use_id=tool_use_id or "",
                file_path=file_path,
                content=content,
                size=size,
                truncated=truncated,
            )
        except FileNotFoundError:
            self._emit(
                "edit_snapshot",
                phase=phase,
                tool_use_id=tool_use_id or "",
                file_path=file_path,
                content=None,
                size=0,
                truncated=False,
            )
        except Exception as e:
            self._emit("error", msg=f"snapshot {phase}: {e}")

    def _is_auto_allowed(self, tool_name: str, tool_input: dict) -> bool:
        if tool_name in AUTO_ALLOW_TOOLS:
            return True
        if tool_name in SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path") if isinstance(tool_input, dict) else None
            if isinstance(fp, str):
                for p in AUTO_ALLOW_WRITE_PREFIXES:
                    if fp.startswith(p):
                        return True
        return False

    async def _pre_tool_use(self, input_data, tool_use_id, context):
        tool_name = (input_data or {}).get("tool_name", "?")
        tool_input = (input_data or {}).get("tool_input", {}) or {}

        # AskUserQuestion → laisse can_use_tool gérer (UI dédiée)
        if tool_name == "AskUserQuestion":
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": "dashboard handles AskUserQuestion",
            }}

        # ExitPlanMode : auto-allow + switch implicite vers bypass
        if tool_name == "ExitPlanMode":
            asyncio.create_task(self._switch_to_bypass_after_exit_plan())
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }}

        # Plan mode : auto-allow read-only safe tools
        if self.permission_mode == "plan" and tool_name in PLAN_MODE_SAFE_TOOLS:
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }}

        # Plan mode : auto-allow Bash si commande read-only
        if self.permission_mode == "plan" and tool_name == "Bash":
            cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
            if _is_safe_bash(cmd):
                return {"hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                }}

        # Auto-allow universel (TodoWrite, écriture de plan, /tmp)
        if self._is_auto_allowed(tool_name, tool_input):
            if tool_name in SNAPSHOT_TOOLS:
                fp = tool_input.get("file_path")
                if fp:
                    self._snapshot_file(fp, "before", tool_use_id)
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }}

        # acceptEdits : auto-allow uniquement les outils d'édition de fichier
        if self.permission_mode == "acceptEdits" and tool_name in SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path")
            if fp:
                self._snapshot_file(fp, "before", tool_use_id)
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }}

        # Permission flow (skip si bypass)
        if self.permission_mode != "bypass":
            pid = "perm_" + str(tool_use_id or id(input_data))
            loop = asyncio.get_event_loop()
            fut = loop.create_future()
            self._pending_perms[pid] = fut
            self._emit("permission_request", id=pid, tool=tool_name, input=tool_input)
            try:
                allowed = await asyncio.wait_for(fut, timeout=600)
            except asyncio.TimeoutError:
                self._pending_perms.pop(pid, None)
                return {"hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "timeout (10min sans réponse du dashboard)",
                }}
            except asyncio.CancelledError:
                self._pending_perms.pop(pid, None)
                return {"hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "session pausée",
                }}
            if not allowed:
                return {"hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "refusé par le dashboard",
                }}

        # Snapshot AVANT edition (si permission accordée)
        if tool_name in SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path")
            if fp:
                self._snapshot_file(fp, "before", tool_use_id)

        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
        }}

    async def _can_use_tool(self, tool_name, tool_input, context):
        from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny  # type: ignore

        if tool_name == "AskUserQuestion":
            questions = (tool_input or {}).get("questions") or []
            qid = "q_" + str(getattr(context, "tool_use_id", None) or id(tool_input))
            loop = asyncio.get_event_loop()
            fut = loop.create_future()
            self._pending_perms[qid] = fut
            self._emit("user_question", id=qid, questions=questions)
            try:
                answers = await asyncio.wait_for(fut, timeout=1800)
            except asyncio.TimeoutError:
                self._pending_perms.pop(qid, None)
                return PermissionResultDeny(message="timeout (30min sans réponse du dashboard)")
            except asyncio.CancelledError:
                self._pending_perms.pop(qid, None)
                return PermissionResultDeny(message="session pausée")
            if not isinstance(answers, dict):
                return PermissionResultDeny(message="réponse invalide du dashboard")
            return PermissionResultAllow(
                updated_input={"questions": questions, "answers": answers}
            )
        return PermissionResultAllow()

    async def _switch_to_bypass_after_exit_plan(self) -> None:
        if self._plan_accepted:
            return
        self._plan_accepted = True
        try:
            await asyncio.sleep(0.05)
            self.permission_mode = "bypass"
            if self._client is not None:
                try:
                    await self._client.set_permission_mode("default")
                except Exception as e:
                    print(f"set_permission_mode(default) post-exit-plan: {e}", file=sys.stderr)
            self._emit("mode_changed", mode=self.permission_mode)
            await self._save_state()
        except Exception as e:
            print(f"_switch_to_bypass_after_exit_plan: {e}", file=sys.stderr)

    async def _post_tool_use(self, input_data, tool_use_id, context):
        tool_name = (input_data or {}).get("tool_name", "?")
        tool_input = (input_data or {}).get("tool_input", {}) or {}
        if tool_name in SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path")
            if fp:
                self._snapshot_file(fp, "after", tool_use_id)
        return {}

    # ── Translate SDK events → notre protocole ───────────────────────────────
    def _translate(self, ev) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        try:
            # Session id (souvent dans SystemMessage data['session_id'])
            try:
                data = getattr(ev, "data", None)
                if isinstance(data, dict):
                    sid = data.get("session_id")
                    if sid and not self._session_id_emitted:
                        self.claude_session_id = sid
                        out.append({"event": "session_id", "claude_session_id": sid})
                        self._session_id_emitted = True
                        # Save async — fire and forget
                        asyncio.create_task(self._save_state())
            except Exception:
                pass
            session_attr = getattr(ev, "session_id", None)
            if session_attr and not self._session_id_emitted:
                self.claude_session_id = session_attr
                out.append({"event": "session_id", "claude_session_id": session_attr})
                self._session_id_emitted = True
                asyncio.create_task(self._save_state())

            ev_type = type(ev).__name__
            if ev_type == "AssistantMessage":
                for block in getattr(ev, "content", []) or []:
                    bt = type(block).__name__
                    if bt == "TextBlock":
                        text = getattr(block, "text", "")
                        if text:
                            out.append({"event": "assistant_text", "delta": text})
                    elif bt == "ThinkingBlock":
                        thinking = getattr(block, "thinking", "")
                        if thinking:
                            out.append({"event": "thinking", "text": thinking})
                    elif bt == "ToolUseBlock":
                        tname = getattr(block, "name", "")
                        tinput = getattr(block, "input", {}) or {}
                        out.append({
                            "event": "tool_use",
                            "id": getattr(block, "id", ""),
                            "name": tname,
                            "input": tinput,
                        })
                        if tname == "TodoWrite":
                            todos = tinput.get("todos") if isinstance(tinput, dict) else None
                            if todos is not None:
                                out.append({"event": "todo_update", "todos": todos})
            elif ev_type == "UserMessage":
                for block in getattr(ev, "content", []) or []:
                    bt = type(block).__name__
                    if bt == "ToolResultBlock":
                        content = getattr(block, "content", "")
                        if isinstance(content, list):
                            parts = []
                            for b in content:
                                if isinstance(b, dict):
                                    parts.append(b.get("text", json.dumps(b)))
                                else:
                                    parts.append(getattr(b, "text", str(b)))
                            content = "".join(parts)
                        out.append({
                            "event": "tool_result",
                            "tool_use_id": getattr(block, "tool_use_id", ""),
                            "content": content if isinstance(content, str) else json.dumps(content),
                            "is_error": bool(getattr(block, "is_error", False)),
                        })
            elif ev_type == "ResultMessage":
                subtype = getattr(ev, "subtype", "")
                out.append({"event": "stop", "subtype": subtype or ""})
            elif ev_type == "SystemMessage":
                pass  # déjà géré ci-dessus
        except Exception as e:
            out.append({"event": "error", "msg": f"translate: {e}"})
        return out

    # ── Main loop ────────────────────────────────────────────────────────────
    async def _run(self) -> None:
        # Mode SDK : "plan" si on est en plan mode, sinon "default".
        # Le "bypass" interne passe par nos hooks PreToolUse (jamais via le flag
        # --dangerously-skip-permissions du SDK : il refuse en root).
        sdk_mode = "plan" if self.permission_mode == "plan" else "default"
        try:
            options_kwargs: dict[str, Any] = dict(
                cwd=self.cwd,
                setting_sources=["project"],
                permission_mode=sdk_mode,
                hooks={
                    "PreToolUse": [HookMatcher(hooks=[self._pre_tool_use])],
                    "PostToolUse": [HookMatcher(hooks=[self._post_tool_use])],
                },
                stderr=self._on_claude_stderr,
                can_use_tool=self._can_use_tool,
            )
            if self.claude_session_id:
                options_kwargs["resume"] = self.claude_session_id
            options = ClaudeAgentOptions(**options_kwargs)
        except TypeError as e:
            self.status = "error"
            self._error_msg = f"ClaudeAgentOptions: {e}"
            self._emit("error", msg=self._error_msg, fatal=True)
            self._emit("status", status="error")
            return

        try:
            async with ClaudeSDKClient(options=options) as client:
                self._client = client
                self.status = "active"
                self._emit("ready")
                self._emit("mode_changed", mode=self.permission_mode)
                self._emit("status", status="active")
                self._ready_evt.set()
                while True:
                    msg = await self._stdin_queue.get()
                    if msg is None:
                        # Arrêt demandé
                        break
                    if msg.get("type") != "user_message":
                        continue
                    content = msg.get("content") or ""
                    self.status = "thinking"
                    self._emit("status", status="thinking")
                    try:
                        await client.query(content)
                        async for ev in client.receive_response():
                            for out in self._translate(ev):
                                self._emit_to_server({
                                    "session_id": self.session_id, **out
                                })
                    except Exception as e:
                        self._emit("error", msg=self._format_err("query", e))
                    self.status = "active"
                    self._emit("status", status="active")
        except Exception as e:
            self.status = "error"
            self._error_msg = self._format_err("client", e)
            self._emit("error", msg=self._error_msg, fatal=True)
            self._emit("status", status="error")
        finally:
            self._client = None
            self._client_ctx = None
            if self.status not in ("error", "killed", "sleeping"):
                self.status = "sleeping"
                self._emit("status", status="sleeping")
            await self._save_state()
