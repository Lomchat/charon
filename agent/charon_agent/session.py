"""Wrapper around ClaudeSDKClient — one instance per session.

Events do not go to stdout : they are passed to an ``emit`` callback supplied
by the server, which tags them with the session_id and broadcasts to every
subscribed client.

Lifecycle :
  s = AgentSession(session_id, cwd, ..., emit_callback)
  await s.start()              # connect to the SDK
  await s.send_input("hello")  # push a query
  await s.stop()               # graceful shutdown
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
except ImportError as e:  # pragma: no cover - depends on the remote env
    ClaudeAgentOptions = None  # type: ignore
    ClaudeSDKClient = None  # type: ignore
    HookMatcher = None  # type: ignore
    SDK_AVAILABLE = False
    SDK_IMPORT_ERROR = str(e)


EmitCallback = Callable[[dict[str, Any]], None]
StateSaveCallback = Callable[[], Awaitable[None] | None]


# Tools auto-allowed universally (all modes)
AUTO_ALLOW_TOOLS = {"TodoWrite", "ExitPlanMode"}

# Tools auto-allowed in plan mode only
PLAN_MODE_SAFE_TOOLS = {
    "Read", "Grep", "Glob", "LS", "NotebookRead",
    "WebFetch", "WebSearch",
    "TodoWrite",
}

# Read-only Bash commands auto-allowed in plan mode (first word after stripping path)
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

# Dangerous patterns: if present, we refuse the Bash auto-allow
DANGEROUS_PATTERNS = (
    " rm ", " rm\t", " rm -", "; rm", "|rm", "&& rm", "rm -rf",
    " mv ", " cp ", " dd ", " mkfs", " chmod ", " chown ",
    " mount ", " umount ", " sudo ", " su ", " kill ", " pkill ",
    ">/dev/", " tee ", "tee ", "curl ", "wget ",
    "-i ",
    " >> ", " > ",
)

# Snapshot tools before/after edit (the UI client displays a diff)
SNAPSHOT_TOOLS = {"Edit", "Write", "MultiEdit"}
SNAPSHOT_MAX = 256 * 1024  # 256KB per snapshot

# file_path always auto-allowed on Write/Edit (Claude plans, /tmp)
AUTO_ALLOW_WRITE_PREFIXES = (
    "/root/.claude/plans/",
    "/tmp/",
)


def _is_safe_bash(command: str | None) -> bool:
    """Heuristic: is the command entirely read-only?"""
    if not isinstance(command, str) or not command.strip():
        return False
    c = " " + command.strip() + " "
    # Tolerates 2>/dev/null and > /dev/null
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
                return False  # executes a file
        if first in ("pip", "pip3", "npm", "yarn", "pnpm"):
            rest = tokens[i + 1:]
            read_only_sub = {"list", "show", "outdated", "info", "view", "ls", "search"}
            if not rest or rest[0] not in read_only_sub:
                return False
    return True


# Keys that we'll drop one-by-one if the installed SDK doesn't know them.
# Order matters: drop the "newest" knobs first so we retain the most behavior
# when downgrading. effort is the newest (added in claude-agent-sdk ~0.2.80+),
# fallback_model is older, model is the oldest of the three.
_OPTIONAL_KEYS_FALLBACK_ORDER = ("effort", "fallback_model", "model")


def _build_options_with_fallback(
    kwargs: dict[str, Any],
    emit: EmitCallback,
) -> Any:
    """Instantiate ClaudeAgentOptions, dropping optional keys if unsupported.

    Old SDKs raise TypeError("unexpected keyword argument 'effort'") on
    unknown kwargs. We catch and retry, removing the offending optional key.
    This lets a single .pyz support a range of SDK versions on different VPSes
    without forcing a coordinated SDK upgrade.
    """
    attempt_kwargs = dict(kwargs)
    dropped: list[str] = []
    while True:
        try:
            options = ClaudeAgentOptions(**attempt_kwargs)
            if dropped:
                # Side-emit so the dashboard surfaces the degraded mode.
                # We don't have a session_id at this point (the wrapper is
                # called before the session emits anything else), but the
                # caller's emit binds session_id automatically via _emit.
                try:
                    emit({
                        "event": "error",
                        "msg": (
                            f"SDK on this VPS doesn't support: {dropped} — "
                            f"falling back to defaults for those fields. "
                            f"Upgrade claude-agent-sdk on the VPS to use them."
                        ),
                    })
                except Exception:
                    pass
            return options
        except TypeError as e:
            msg = str(e)
            # Find which optional key the SDK rejected. We only catch the
            # known-optional keys; other TypeErrors bubble up so the session
            # ends in 'error' (correct behavior for a genuinely broken call).
            for key in _OPTIONAL_KEYS_FALLBACK_ORDER:
                if key in attempt_kwargs and (
                    f"'{key}'" in msg or f'"{key}"' in msg
                ):
                    attempt_kwargs.pop(key, None)
                    dropped.append(key)
                    break
            else:
                raise


class AgentSession:
    """A Claude session isolated within the agent. Lives independently of clients."""

    # Valid effort levels (mirrors claude_agent_sdk.EffortLevel literal).
    # If the SDK installed on this VPS is older and doesn't know one of these,
    # _run will catch the TypeError on ClaudeAgentOptions(**kwargs) and retry
    # without the offending field — see EFFORT_OPTIONAL_KEYS below.
    VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max")

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
        model: str | None = None,
        fallback_model: str | None = None,
        effort: str | None = None,
    ) -> None:
        self.session_id = session_id
        self.cwd = cwd
        self.name = name
        self.permission_mode = permission_mode if permission_mode in (
            "normal", "acceptEdits", "auto", "plan",
        ) else "normal"
        self.claude_session_id = claude_session_id
        # Model / effort settings (all optional — fall through to SDK defaults
        # if None). model is a free string (the SDK accepts model IDs like
        # "claude-opus-4-7-..." / "claude-opus-4-8-..."). fallback_model is
        # used by the SDK if the primary is rate-limited. effort must be one
        # of VALID_EFFORTS or it's silently dropped.
        self.model = model or None
        self.fallback_model = fallback_model or None
        self.effort = effort if effort in self.VALID_EFFORTS else None
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
        # The model Anthropic actually used on the last AssistantMessage.
        # Differs from self.model when:
        #   - self.model is None (we passed nothing, SDK picked a default)
        #   - self.model is an alias ('opus' → resolved to claude-opus-4-8)
        #   - self.fallback_model kicked in (primary rate-limited)
        # Emitted as `effective_model` event whenever it CHANGES so Charon can
        # display "configured: opus / effective: claude-opus-4-8" — kills the
        # confusion where users ask Claude "what model are you" and get a
        # hallucinated wrong version (LLMs don't reliably know their own
        # version). Source of truth is the API metadata, not Claude's text.
        self._effective_model: str | None = None
        self._claude_stderr_lines: list[str] = []
        self._plan_accepted = False
        self._stopped = asyncio.Event()
        self._ready_evt = asyncio.Event()
        self._error_msg: str | None = None

    # ── Public API ───────────────────────────────────────────────────────────
    async def start(self) -> None:
        """Starts the session: launches a task that keeps the SDK open."""
        if self._main_task is not None:
            return
        if not SDK_AVAILABLE:
            self.status = "error"
            self._error_msg = f"claude_agent_sdk not importable: {SDK_IMPORT_ERROR}"
            self._emit("error", msg=self._error_msg, fatal=True)
            self._emit("status", status="error")
            await self._save_state()
            return
        self._main_task = asyncio.create_task(self._run(), name=f"session-{self.session_id}")

    async def stop(self, *, mark: str = "sleeping") -> None:
        """Cleanly stops the session (mark: 'sleeping' or 'killed')."""
        self.status = mark
        self._emit("status", status=mark)
        # Cancel in-flight promises so the main loop doesn't hang
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

    async def force_stop(self) -> None:
        """Brutally cancels the session without waiting for the SDK.

        Use case: the SDK is blocked (tool that doesn't return, the soft
        `interrupt` has no visible effect). We cancel the main task
        fire-and-forget: the session goes to 'sleeping' immediately and
        the user can resume. The cancelled task may continue to live
        for some time in the background until the SDK returns — its
        `finally` is guarded so it doesn't overwrite the state of a session
        we may have restarted in the meantime.
        """
        self.status = "sleeping"
        self._emit("status", status="sleeping")
        self._emit("interrupted", forced=True)
        for fut in self._pending_perms.values():
            if not fut.done():
                fut.cancel()
        self._pending_perms.clear()
        old_task = self._main_task
        self._main_task = None
        self._client = None
        self._client_ctx = None
        self._stopped.set()
        if old_task is not None and not old_task.done():
            old_task.cancel()  # fire-and-forget: we don't wait
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
        if mode not in ("normal", "acceptEdits", "auto", "plan"):
            mode = "normal"
        self.permission_mode = mode
        # SDK mapping: only "plan" is passed through as-is. The other modes
        # ("normal", "acceptEdits", "auto") are mapped to "default" and it's
        # our PreToolUse hooks that apply the logic (asking dashboard,
        # auto-allow file edits, total bypass respectively).
        sdk_mode = "plan" if mode == "plan" else "default"
        if self._client is not None:
            try:
                await self._client.set_permission_mode(sdk_mode)
            except Exception as e:
                self._emit("error", msg=f"set_permission_mode SDK: {e}")
        self._emit("mode_changed", mode=mode)
        await self._save_state()

    async def set_model(self, model: str | None, fallback_model: str | None = None) -> None:
        """Update the model for this session.

        Takes effect at the NEXT SDK start (sleep + resume, or next time the
        client is recreated). The live ClaudeSDKClient cannot swap models
        mid-flight — the underlying Claude session UUID is bound to a model.
        The event payload announces this with applied_at_next_start=true so the
        UI can label the change as deferred.
        """
        self.model = model or None
        if fallback_model is not None:
            self.fallback_model = fallback_model or None
        self._emit(
            "model_changed",
            model=self.model,
            fallback_model=self.fallback_model,
            applied_at_next_start=self._client is not None,
        )
        await self._save_state()

    async def set_effort(self, effort: str | None) -> None:
        """Update the effort level for this session.

        Like model, takes effect at the next SDK start. Effort is part of
        ClaudeAgentOptions, which the SDK reads at client construction —
        there is no SDK-side runtime setter.
        """
        if effort is not None and effort not in self.VALID_EFFORTS:
            self._emit("error", msg=f"invalid effort {effort!r} (valid: {self.VALID_EFFORTS})")
            return
        self.effort = effort or None
        self._emit(
            "effort_changed",
            effort=self.effort,
            applied_at_next_start=self._client is not None,
        )
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
            "model": self.model,
            "fallback_model": self.fallback_model,
            "effort": self.effort,
        }

    def to_persist(self) -> dict[str, Any]:
        # Persisted status: reflects the current state. At boot, _restore_existing
        # does NOT restore "killed" or "sleeping" sessions (explicit pause),
        # but does resume "active" / "thinking" / "starting" / "error".
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
            "model": self.model,
            "fallback_model": self.fallback_model,
            "effort": self.effort,
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
        # Mirror to our stderr for local debugging
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
            parts.append("--- claude CLI stderr ---\n" + captured[-3000:])
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

        # AskUserQuestion → let can_use_tool handle it (dedicated UI)
        if tool_name == "AskUserQuestion":
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": "dashboard handles AskUserQuestion",
            }}

        # ExitPlanMode: auto-allow + implicit switch to auto
        if tool_name == "ExitPlanMode":
            asyncio.create_task(self._switch_to_auto_after_exit_plan())
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }}

        # Plan mode: auto-allow read-only safe tools
        if self.permission_mode == "plan" and tool_name in PLAN_MODE_SAFE_TOOLS:
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }}

        # Plan mode: auto-allow Bash if command is read-only
        if self.permission_mode == "plan" and tool_name == "Bash":
            cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
            if _is_safe_bash(cmd):
                return {"hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                }}

        # Universal auto-allow (TodoWrite, plan write, /tmp)
        if self._is_auto_allowed(tool_name, tool_input):
            if tool_name in SNAPSHOT_TOOLS:
                fp = tool_input.get("file_path")
                if fp:
                    self._snapshot_file(fp, "before", tool_use_id)
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }}

        # acceptEdits: auto-allow only file editing tools
        if self.permission_mode == "acceptEdits" and tool_name in SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path")
            if fp:
                self._snapshot_file(fp, "before", tool_use_id)
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }}

        # Snapshot the editing tools BEFORE deciding — regardless of the
        # permission path (direct PreToolUse or can_use_tool via auto classifier),
        # PostToolUse will need the original content to generate the diff.
        if tool_name in SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path")
            if fp:
                self._snapshot_file(fp, "before", tool_use_id)

        # "auto" mode: total bypass — accepts everything without asking. This is what
        # the charon UI has always called "auto mode" (vs the model-classifier auto
        # of native Claude Code which is not accessible from the Python SDK).
        # The SNAPSHOT_TOOLS snapshot was already taken above for the diff.
        if self.permission_mode == "auto":
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }}

        # Standard permission flow (normal, acceptEdits non-snapshot, plan
        # non-safe): we ask the dashboard directly from this hook.
        allowed = await self._ask_dashboard_permission(
            tool_name=tool_name,
            tool_input=tool_input,
            perm_id="perm_" + str(tool_use_id or id(input_data)),
        )
        if allowed is None:
            # timeout or cancellation: we already cleaned _pending_perms
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "timeout/cancellation",
            }}
        if not allowed:
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "denied by the dashboard",
            }}
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
        }}

    async def _ask_dashboard_permission(
        self,
        *,
        tool_name: str,
        tool_input: dict,
        perm_id: str,
    ) -> bool | None:
        """Emits permission_request to the dashboard and awaits the response.

        Returns True if allowed, False if denied, None on timeout/cancellation.
        The caller translates into an Allow/Deny decision in the appropriate format
        (hookSpecificOutput for PreToolUse, PermissionResult for can_use_tool).
        """
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        self._pending_perms[perm_id] = fut
        self._emit("permission_request", id=perm_id, tool=tool_name, input=tool_input)
        try:
            allowed = await asyncio.wait_for(fut, timeout=600)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self._pending_perms.pop(perm_id, None)
            return None
        return bool(allowed)

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
                return PermissionResultDeny(message="timeout (30min without response from the dashboard)")
            except asyncio.CancelledError:
                self._pending_perms.pop(qid, None)
                return PermissionResultDeny(message="session paused")
            if not isinstance(answers, dict):
                return PermissionResultDeny(message="invalid response from the dashboard")
            return PermissionResultAllow(
                updated_input={"questions": questions, "answers": answers}
            )

        # In "auto" mode, our PreToolUse returns "ask" → the CLI classifier
        # applies its rules. If it decides we should ask the user,
        # the CLI calls us back here via can_use_tool. We delegate to the dashboard
        # via the same mechanism as the standard permission flow.
        perm_id = "perm_" + str(getattr(context, "tool_use_id", None) or id(tool_input))
        allowed = await self._ask_dashboard_permission(
            tool_name=tool_name,
            tool_input=tool_input or {},
            perm_id=perm_id,
        )
        if allowed is None:
            return PermissionResultDeny(message="timeout (10min without response from the dashboard)")
        if not allowed:
            return PermissionResultDeny(message="denied by the dashboard")
        return PermissionResultAllow()

    async def _switch_to_auto_after_exit_plan(self) -> None:
        if self._plan_accepted:
            return
        self._plan_accepted = True
        try:
            await asyncio.sleep(0.05)
            self.permission_mode = "auto"
            if self._client is not None:
                try:
                    # On the SDK side we stay on "default" — it's our PreToolUse hook
                    # that sees `self.permission_mode == "auto"` and bypasses everything.
                    await self._client.set_permission_mode("default")
                except Exception as e:
                    print(f"set_permission_mode(default) post-exit-plan: {e}", file=sys.stderr)
            self._emit("mode_changed", mode=self.permission_mode)
            await self._save_state()
        except Exception as e:
            print(f"_switch_to_auto_after_exit_plan: {e}", file=sys.stderr)

    async def _post_tool_use(self, input_data, tool_use_id, context):
        tool_name = (input_data or {}).get("tool_name", "?")
        tool_input = (input_data or {}).get("tool_input", {}) or {}
        if tool_name in SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path")
            if fp:
                self._snapshot_file(fp, "after", tool_use_id)
        return {}

    # ── Translate SDK events → our protocol ──────────────────────────────────
    def _translate(self, ev) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        try:
            # Session id (often in SystemMessage data['session_id'])
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
                # Extract the API-confirmed model for this turn. AssistantMessage
                # has `.model: str` (per SDK >= 0.2.82 dataclass). When it
                # changes from what we last reported, emit `effective_model`
                # so Charon can display the truth alongside the configured
                # model. Old SDKs without `.model` → getattr returns None and
                # we just skip.
                msg_model = getattr(ev, "model", None)
                if isinstance(msg_model, str) and msg_model and msg_model != self._effective_model:
                    self._effective_model = msg_model
                    out.append({"event": "effective_model", "model": msg_model})
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
                pass  # already handled above
        except Exception as e:
            out.append({"event": "error", "msg": f"translate: {e}"})
        return out

    # ── Main loop ────────────────────────────────────────────────────────────
    async def _run(self) -> None:
        # SDK mode:
        #   - "plan": passed through as-is so the SDK applies its plan logic
        #   - "auto" / "normal" / "acceptEdits" → "default" on the SDK side. It's our
        #     PreToolUse hooks that decide (allow direct in auto mode = total
        #     bypass, asking the dashboard in normal, auto-allow file edits in
        #     acceptEdits).
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
            # Optional model/effort fields. Added with try/except so an old
            # claude-agent-sdk that doesn't know one of these (TypeError:
            # unexpected keyword argument) doesn't crash the session — we drop
            # the unknown field and retry. The dropped field is reported via
            # stderr so the user knows their SDK is too old for that knob.
            if self.model:
                options_kwargs["model"] = self.model
            if self.fallback_model:
                options_kwargs["fallback_model"] = self.fallback_model
            if self.effort:
                options_kwargs["effort"] = self.effort
            options = _build_options_with_fallback(
                options_kwargs,
                lambda fields: self._emit(fields.pop("event"), **fields),
            )
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
                        # Stop requested
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
            # If force_stop replaced us (self._main_task points elsewhere
            # or is already None and a new task has taken over), we don't
            # touch anything — otherwise we'd overwrite the state of the
            # freshly restarted session.
            me = asyncio.current_task()
            if self._main_task is None or self._main_task is me:
                self._client = None
                self._client_ctx = None
                if self.status not in ("error", "killed", "sleeping"):
                    self.status = "sleeping"
                    self._emit("status", status="sleeping")
                await self._save_state()
