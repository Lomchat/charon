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
import time
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
    # Installed SDK version, reported via `hello` so the hub can flag outdated
    # fleets (compared against the PyPI latest). Best-effort: never fatal.
    try:
        import claude_agent_sdk as _sdk_mod
        SDK_VERSION: str | None = getattr(_sdk_mod, "__version__", None)
        if not SDK_VERSION:
            from importlib.metadata import version as _pkg_version
            SDK_VERSION = _pkg_version("claude-agent-sdk")
    except Exception:  # pragma: no cover
        SDK_VERSION = None
    # THE terminal-task-status oracle, straight from the SDK. The hub used to
    # keep two hand-written word lists (app/bgTasks.ts and bgTaskState.ts) which
    # drifted in OPPOSITE directions (§14.91). Read it once here and stamp the
    # answer on the wire so nothing downstream has to guess.
    try:
        from claude_agent_sdk import TERMINAL_TASK_STATUSES as _TERMINAL  # type: ignore
        TERMINAL_TASK_STATUSES: frozenset[str] | None = frozenset(
            str(s).lower() for s in _TERMINAL
        )
    except Exception:  # pragma: no cover - SDK too old to export it
        TERMINAL_TASK_STATUSES = None
except ImportError as e:  # pragma: no cover - depends on the remote env
    ClaudeAgentOptions = None  # type: ignore
    ClaudeSDKClient = None  # type: ignore
    HookMatcher = None  # type: ignore
    SDK_AVAILABLE = False
    SDK_IMPORT_ERROR = str(e)
    SDK_VERSION = None
    TERMINAL_TASK_STATUSES = None


EmitCallback = Callable[[dict[str, Any]], None]
StateSaveCallback = Callable[[], Awaitable[None] | None]


# Tools auto-allowed universally (all modes).
# TodoWrite is off by default since CLI 2.1.142 and was superseded by the Task*
# family (TaskCreate/TaskUpdate/TaskGet/TaskList). Both spellings stay listed:
# the pyz runs against whatever CLI the SDK bundles, and an old bundle still
# emits TodoWrite. These are bookkeeping tools with no side effect outside the
# transcript — gating them behind a permission card is pure noise.
AUTO_ALLOW_TOOLS = {
    "TodoWrite", "ExitPlanMode",
    "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
}

# Tools auto-allowed in plan mode only
PLAN_MODE_SAFE_TOOLS = {
    "Read", "Grep", "Glob", "LS", "NotebookRead",
    "WebFetch", "WebSearch",
    "TodoWrite",
    "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
}

# Read-only Bash commands auto-allowed in plan mode (first word after stripping path)
PLAN_MODE_SAFE_BASH = {
    "ls", "dir", "cat", "head", "tail", "more", "less", "find",
    "pwd", "echo", "printf", "date", "whoami", "hostname", "id", "uname",
    "grep", "egrep", "fgrep", "rg", "ag",
    # Native macOS/Linux CLI builds (>= 2.1.117) drop the dedicated Glob/Grep
    # tools and expose embedded `bfs`/`ugrep` through Bash instead. Without
    # these two, plan mode asks permission for what used to be a free read.
    "bfs", "ugrep",
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


def _field(obj: Any, *names: str) -> Any:
    """Read the first present field from a dict OR a dataclass, trying each
    name in order. SDK payloads arrive as either, and switched between snake
    and camel spellings across versions — so never bind to one shape."""
    for n in names:
        if isinstance(obj, dict):
            if n in obj:
                return obj[n]
        else:
            v = getattr(obj, n, None)
            if v is not None:
                return v
    return None


def _num(v: Any) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0


def _nested_cache_creation(usage: dict[str, Any]) -> int:
    """Cache-write tokens when the API reports them ONLY under a nested
    `cache_creation` breakdown ({ephemeral_5m_input_tokens, …}) instead of the
    flat `cache_creation_input_tokens`."""
    nested = usage.get("cache_creation")
    if not isinstance(nested, dict):
        return 0
    return int(sum(_num(v) for v in nested.values()))


def _extract_effort_support(sdata: dict[str, Any]) -> dict[str, list[str]] | None:
    """Pull per-model effort support out of the init frame.

    The CLI reports `supportedEffortLevels` per model (SDK >= 0.1.49) but has
    moved where it hangs it more than once, so search the plausible containers
    rather than binding to one path — a miss costs a feature, a wrong guess
    costs a crash. Charon otherwise hard-codes these levels in three separate
    places (§14.35) and offers `max` on models that 400 on it.
    """
    def levels_of(entry: Any) -> list[str] | None:
        v = _field(entry, "supportedEffortLevels", "supported_effort_levels")
        if isinstance(v, list):
            out = [x for x in v if isinstance(x, str) and x]
            return out or None
        # A model that supports effort but doesn't enumerate: report nothing
        # rather than inventing a list.
        return None

    for container_key in ("model_info", "modelInfo", "models", "model"):
        container = sdata.get(container_key)
        if isinstance(container, dict):
            # Either {modelId: {...}} or a single model's info dict.
            direct = levels_of(container)
            if direct:
                mid = _field(container, "id", "model", "name")
                return {mid if isinstance(mid, str) and mid else "*": direct}
            found: dict[str, list[str]] = {}
            for mid, entry in container.items():
                lv = levels_of(entry)
                if isinstance(mid, str) and lv:
                    found[mid] = lv
            if found:
                return found
        elif isinstance(container, list):
            found = {}
            for entry in container:
                lv = levels_of(entry)
                mid = _field(entry, "id", "model", "name")
                if isinstance(mid, str) and mid and lv:
                    found[mid] = lv
            if found:
                return found
    return None


def _sum_model_usage(mu: Any) -> dict[str, Any] | None:
    """Collapse ResultMessage.model_usage (dict keyed by model id) into one
    whole-tree total. Returns None when the SDK is too old to provide it, so
    the caller can fall back to the main-thread `usage`."""
    if not isinstance(mu, dict) or not mu:
        return None
    tot = {"input_tokens": 0, "output_tokens": 0,
           "cache_read_tokens": 0, "cache_write_tokens": 0}
    cost = 0.0
    models: list[str] = []
    for model_id, entry in mu.items():
        if isinstance(model_id, str) and model_id:
            models.append(model_id)
        tot["input_tokens"] += int(_num(_field(entry, "input_tokens", "inputTokens")))
        tot["output_tokens"] += int(_num(_field(entry, "output_tokens", "outputTokens")))
        tot["cache_read_tokens"] += int(_num(
            _field(entry, "cache_read_input_tokens", "cacheReadInputTokens")))
        tot["cache_write_tokens"] += int(_num(
            _field(entry, "cache_creation_input_tokens", "cacheCreationInputTokens")))
        cost += _num(_field(entry, "cost_usd", "costUSD", "costUsd"))
    if not any(tot.values()) and cost <= 0:
        return None
    tot["cost_usd"] = round(cost, 6) if cost > 0 else None
    tot["models"] = sorted(set(models))
    return tot

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


# Cap for a SINGLE NDJSON message the SDK frames off the CLI's stdout. The SDK
# default is 1 MiB (_DEFAULT_MAX_BUFFER_SIZE in the SDK's subprocess_cli.py); a
# single large tool_result (Read of a big file, a verbose Bash/grep/diff, a
# WebFetch, build logs…) is serialized as ONE line and blows past 1 MiB, making
# receive_messages() raise "JSON message exceeded maximum buffer size of
# 1048576 bytes" — which kills the stream reader mid-turn (§14.55). 32 MiB
# covers realistic tool output while still bounding memory (the buffer only
# grows to the current pending line's size). Rebuild the pyz to change it.
_MAX_BUFFER_SIZE = 32 * 1024 * 1024

# Keys that we'll drop one-by-one if the installed SDK doesn't know them.
# Order matters: drop the "newest"/least-important knobs first so we retain the
# most behavior when downgrading. effort is the newest (added in
# claude-agent-sdk ~0.2.80+), fallback_model is older, model is the oldest of
# the three. include_partial_messages drops FIRST (least important — only the
# live token counter, §14.50): an SDK too old to know it must still start the
# session. max_buffer_size (§14.55) is next: dropping it reverts to the SDK's
# 1 MiB stdout cap (the bug), but an SDK too old to accept the kwarg has no
# other choice.
_OPTIONAL_KEYS_FALLBACK_ORDER = (
    "include_partial_messages", "max_buffer_size", "effort", "fallback_model", "model",
    # `settings` carries the ultracode flags (§14.56); an SDK too old to accept
    # the kwarg just starts without ultracode.
    "settings",
)


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

    # Discriminator so the hub / server.py can tell Claude and Codex sessions
    # apart (Codex sessions are CodexSession, see codex_session.py).
    kind = "claude"

    # Valid effort levels (mirrors claude_agent_sdk.EffortLevel literal).
    # If the SDK installed on this VPS is older and doesn't know one of these,
    # _run will catch the TypeError on ClaudeAgentOptions(**kwargs) and retry
    # without the offending field — see EFFORT_OPTIONAL_KEYS below.
    # "ultracode" is a Charon pseudo-effort (xhigh + workflow orchestration),
    # applied via options.settings rather than the SDK effort kwarg (§14.56).
    VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max", "ultracode")

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
        # Whether Charon's name has been mirrored into the CLI's transcript
        # (write_cli_title). Retried at turn end until it lands.
        self._cli_title_written = False
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
        # Live token-usage accounting for the CURRENT turn (CLAUDE.md §14.50).
        # Reset at each turn start; fed by the raw Anthropic stream events
        # (StreamEvent) when include_partial_messages is on.
        self._usage_in = 0              # input tokens (sum of message_start)
        self._usage_cache = 0           # cache-read input tokens
        self._usage_committed_out = 0   # output tokens of FINISHED messages this turn
        self._usage_cur_out = 0         # output tokens of the in-flight message
        self._usage_last_emit = 0.0     # monotonic ts of the last throttled live emit
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

    async def stop_bg_task(self, task_id: str) -> None:
        """Stop ONE background task, leaving the session itself alone.

        This is the SDK's `stop_task` control request, NOT `interrupt`: it
        targets a single task_id and the turn/session keeps running. The whole
        point of the button it backs is "kill the sub-task, not the agent".

        The terminal state comes back through the NORMAL event stream, so the
        hub needs no special-casing: the CLI answers with a `task_updated`
        patch whose status is terminal (raw `killed`) and usually — but per the
        SDK docs NOT always — a `task_notification` (`stopped`). That is
        exactly why both hub-side reducers clear a task on a terminal status
        from EITHER message (`app/bgTasks.ts § isTerminalBgStatus`); a kill
        that only produced a `task_updated` would otherwise look like a
        no-op forever.
        """
        if self._client is None:
            raise RuntimeError("session is not running")
        stop = getattr(self._client, "stop_task", None)
        if stop is None:
            # Older claude-agent-sdk: the control request doesn't exist. Say so
            # rather than failing opaquely — the fix is a fleet SDK bump.
            raise RuntimeError("claude-agent-sdk too old: no stop_task support")
        await stop(task_id)

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

        Applied LIVE when the SDK supports it (`client.set_model`, streaming
        mode — which is the only mode we run). §14.35 recorded this as
        impossible; it is not, and the deferred sleep+resume dance it described
        was working around a limitation that no longer exists.

        ⚠ The cost is real though: model and effort are part of the prompt-cache
        key, so the next turn re-reads the whole history uncached. That is a
        price to warn about, not a reason to refuse — the CLI itself just shows
        a confirmation dialog. `applied_at_next_start` stays true only when the
        live call is unavailable (no client yet, or an SDK too old).
        """
        self.model = model or None
        if fallback_model is not None:
            self.fallback_model = fallback_model or None
        deferred = self._client is not None
        if self._client is not None:
            setter = getattr(self._client, "set_model", None)
            if callable(setter):
                try:
                    await setter(self.model)
                    deferred = False
                except Exception as e:
                    # Stay deferred rather than lie: the next start applies it.
                    self._emit("error", msg=f"set_model live: {e}")
        self._emit(
            "model_changed",
            model=self.model,
            fallback_model=self.fallback_model,
            applied_at_next_start=deferred,
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

    async def context_usage(self) -> dict[str, Any]:
        """How full the context window is, right now.

        The hub had a live TOKEN counter (§14.50) but no notion of the window:
        "why did my session suddenly forget things" had no answer in the UI
        until the compaction marker, which arrives only after the fact. This
        answers it before.
        """
        if self._client is None:
            return {"ok": False, "error": "session not running"}
        fn = getattr(self._client, "get_context_usage", None)
        if not callable(fn):
            return {"ok": False, "error": "SDK too old for get_context_usage"}
        try:
            r = await fn()
        except Exception as e:
            return {"ok": False, "error": str(e)}
        if not isinstance(r, dict):
            r = {k: getattr(r, k, None) for k in
                 ("totalTokens", "maxTokens", "percentage", "model",
                  "autoCompactThreshold", "categories")}
        out: dict[str, Any] = {"ok": True}
        for src, dst in (("totalTokens", "total_tokens"), ("maxTokens", "max_tokens"),
                         ("percentage", "percentage"), ("model", "model"),
                         ("autoCompactThreshold", "auto_compact_threshold"),
                         ("total_tokens", "total_tokens"), ("max_tokens", "max_tokens")):
            v = r.get(src)
            if isinstance(v, (int, float, str)):
                out[dst] = v
        cats = r.get("categories")
        if isinstance(cats, list):
            out["categories"] = [
                {"name": _field(c, "name", "category"), "tokens": _field(c, "tokens", "count")}
                for c in cats[:20]
            ]
        return out

    async def mcp_status(self) -> dict[str, Any]:
        """Per-server MCP health. Charon exposed no MCP surface at all, so a
        server that failed to connect was invisible — the tools simply were not
        there and nothing said why."""
        if self._client is None:
            return {"ok": False, "error": "session not running"}
        fn = getattr(self._client, "get_mcp_status", None)
        if not callable(fn):
            return {"ok": False, "error": "SDK too old for get_mcp_status"}
        try:
            r = await fn()
        except Exception as e:
            return {"ok": False, "error": str(e)}
        servers = r.get("servers") if isinstance(r, dict) else getattr(r, "servers", None)
        out = []
        for sv in (servers or [])[:50]:
            out.append({
                "name": _field(sv, "name"),
                "status": _field(sv, "status", "state"),
                "tool_count": _field(sv, "tool_count", "toolCount"),
                "error": _field(sv, "error", "message"),
            })
        return {"ok": True, "servers": out}

    async def mcp_toggle(self, name: str, enabled: bool) -> dict[str, Any]:
        if self._client is None:
            return {"ok": False, "error": "session not running"}
        fn = getattr(self._client, "toggle_mcp_server", None)
        if not callable(fn):
            return {"ok": False, "error": "SDK too old for toggle_mcp_server"}
        try:
            await fn(name, enabled)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def mcp_reconnect(self, name: str) -> dict[str, Any]:
        if self._client is None:
            return {"ok": False, "error": "session not running"}
        fn = getattr(self._client, "reconnect_mcp_server", None)
        if not callable(fn):
            return {"ok": False, "error": "SDK too old for reconnect_mcp_server"}
        try:
            await fn(name)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def subagents(self) -> dict[str, Any]:
        """Which sub-agents this session spawned, and their transcripts.

        A Workflow run showed as "Agent: … — 4m12s — done" and everything the
        sub-agent actually read, searched and concluded was thrown away. The
        transcripts have been sitting on the VPS the whole time
        (`.../subagents/agent-<id>.jsonl`, workflows/<runId>/ included).
        """
        if not self.claude_session_id:
            return {"ok": True, "agents": []}
        try:
            from claude_agent_sdk import list_subagents
        except Exception as e:
            return {"ok": False, "error": f"SDK too old: {e}"}
        try:
            ids = list_subagents(self.claude_session_id, directory=self.cwd)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "agents": [i for i in (ids or []) if isinstance(i, str)][:200]}

    def subagent_messages(self, agent_id: str, limit: int = 400) -> dict[str, Any]:
        if not self.claude_session_id:
            return {"ok": False, "error": "no transcript"}
        try:
            from claude_agent_sdk import get_subagent_messages
        except Exception as e:
            return {"ok": False, "error": f"SDK too old: {e}"}
        try:
            msgs = get_subagent_messages(self.claude_session_id, agent_id,
                                         directory=self.cwd, limit=limit)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        out = []
        for m in (msgs or []):
            content = _field(m, "content", "text")
            if not isinstance(content, str):
                try:
                    content = json.dumps(content, default=str)
                except Exception:
                    content = str(content)
            out.append({
                "role": _field(m, "role", "type") or "assistant",
                # Bounded: this is a reader, not an export. A runaway sub-agent
                # must not be able to push megabytes through one RPC line.
                "content": content[:8000],
                "uuid": _field(m, "uuid"),
            })
        return {"ok": True, "messages": out}

    def write_cli_title(self, name: str) -> bool:
        """Mirror Charon's session name into the CLI's OWN transcript.

        The CLI keeps its own notion of a session title (what `/rename` sets,
        what `--resume <name>` matches, and what the cross-session addressing
        surfaces as the session's name). Charon has always kept its name purely
        hub-side, so the two disagreed: a session called "frontend" in the
        dashboard was an unnamed uuid to everything running on the VPS.

        `rename_session` appends a custom-title entry, so repeated calls are
        safe — the last one wins. Returns False rather than raising when the
        SDK is too old to export it or the transcript does not exist yet (a
        session that has not produced its first message has no file to title).
        """
        if not self.claude_session_id:
            return False
        try:
            from claude_agent_sdk import rename_session  # type: ignore
        except Exception:
            return False
        try:
            rename_session(self.claude_session_id, name, directory=self.cwd)
            return True
        except Exception:
            # FileNotFoundError (no transcript yet), ValueError (bad title) —
            # all non-fatal: the hub remains the source of truth for the name.
            return False

    def to_info(self) -> dict[str, Any]:
        return {
            "kind": "claude",
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
            "kind": "claude",
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

    async def _emit_model_catalog(self, client) -> None:
        """Report the model catalog THIS ACCOUNT actually has, with per-model
        effort support.

        Replaces three hand-maintained sources of the same truth: `VALID_EFFORTS`
        here, `isKnownEffort` in TS, and the "ultracode only on xhigh-capable
        models" rule in knownModels.ts (§14.35/§14.56). Those lists lie whenever
        Anthropic moves the levels — offering `max` on a model that 400s on it.

        Also solves what §14.43 could not: a live catalog with NO api key. The
        OAuth token cannot call GET /v1/models, but the CLI already knows, and
        `resolvedModel` resolves aliases for us (`default` →
        `claude-opus-5[1m]`, hence the `[1m]` handling in isPlausibleModelId).

        Best-effort and out of band: a session must never fail to start because
        the catalog could not be read.
        """
        try:
            info = await client.get_server_info()
        except Exception:
            return
        if not isinstance(info, dict):
            return
        models = info.get("models")
        if not isinstance(models, list):
            return
        out = []
        for m in models[:60]:
            mid = _field(m, "value", "id", "model")
            if not isinstance(mid, str) or not mid:
                continue
            entry: dict[str, Any] = {"id": mid}
            for src, dst in (("resolvedModel", "resolved"),
                             ("displayName", "label"),
                             ("description", "hint")):
                v = _field(m, src)
                if isinstance(v, str) and v:
                    entry[dst] = v
            lv = _field(m, "supportedEffortLevels", "supported_effort_levels")
            if isinstance(lv, list):
                entry["efforts"] = [x for x in lv if isinstance(x, str)]
            for src, dst in (("supportsEffort", "supports_effort"),
                             ("supportsAdaptiveThinking", "supports_adaptive_thinking")):
                v = _field(m, src)
                if isinstance(v, bool):
                    entry[dst] = v
            out.append(entry)
        if out:
            try:
                self._emit("session_info", models=out)
            except Exception:
                pass

    async def _on_stop_hook(self, input_data, tool_use_id, context):
        """The turn ended — report what is STILL RUNNING, authoritatively.

        §14.91 exists because "the turn ended" and "the session is done" are
        different facts, and the hub could only tell them apart by rebuilding a
        registry from persisted `bg_task` rows: burial rows when the CLI dies,
        three triggers, a 24h age cap, and two terminal-word lists that drifted.

        The Stop hook (CLI >= 2.1.145) simply hands us `background_tasks` — what
        is alive at this instant, from the process that owns them. Emitted as
        its own durable event rather than folded into `stop`, because hook and
        ResultMessage ordering is not guaranteed: the hub applies whichever
        arrives, and a late `turn_end` corrects the status a beat later instead
        of racing it.
        """
        d = input_data if isinstance(input_data, dict) else {}
        payload: dict[str, Any] = {"event": "turn_end"}
        bg = d.get("background_tasks")
        if isinstance(bg, list):
            # Ids only: the hub already holds the descriptions, and a hook
            # payload is not a place to re-ship them.
            ids = []
            for t in bg:
                tid = _field(t, "task_id", "taskId", "id")
                if isinstance(tid, str) and tid:
                    ids.append(tid)
            payload["background_tasks"] = ids
        crons = d.get("session_crons")
        if isinstance(crons, list):
            payload["session_crons"] = len(crons)
        last = d.get("last_assistant_message")
        if isinstance(last, str) and last:
            # Bounded: this is a classification signal (§14.68), not content —
            # the real text already arrived as assistant_text.
            payload["last_assistant_message"] = last[:2000]
        try:
            self._emit(payload.pop("event"), **payload)
        except Exception:
            pass
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
                        if self.name and not self._cli_title_written:
                            self._cli_title_written = self.write_cli_title(self.name)
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
                # Typed failure (SDK >= 0.2.126): authentication_failed,
                # billing_error, … The hub has been inferring exactly this by
                # regexing the assistant's prose for "API Error: 401" (§14.65),
                # with a documented pile of anti-false-positive guards. This is
                # the same fact, stated. It LAYERS over the regex rather than
                # replacing it: an older CLI still only says it in prose.
                err_kind = _field(getattr(ev, "error", None), "type", "kind", "code")
                if isinstance(err_kind, str) and err_kind:
                    out.append({"event": "turn_error", "kind": err_kind})
                # The transcript's own uuid for THIS message. Forking branches
                # at a transcript entry and the SDK identifies it by this id, so
                # without it the only possible fork is "the whole conversation".
                msg_uuid = getattr(ev, "uuid", None)
                msg_uuid = msg_uuid if isinstance(msg_uuid, str) and msg_uuid else None
                for block in getattr(ev, "content", []) or []:
                    bt = type(block).__name__
                    if bt == "TextBlock":
                        text = getattr(block, "text", "")
                        if text:
                            ev_txt: dict[str, Any] = {"event": "assistant_text", "delta": text}
                            if msg_uuid:
                                ev_txt["uuid"] = msg_uuid
                            out.append(ev_txt)
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
            elif ev_type in ("TaskStartedMessage", "TaskUpdatedMessage", "TaskNotificationMessage"):
                # First-class background-task lifecycle messages (SDK ≥ 0.2.11x):
                # started (Bash run_in_background / background subagent / a
                # Workflow-tool run — task_type 'local_workflow'), updated
                # (status change; a workflow completes HERE as status
                # 'completed' with NO accompanying notification), notification
                # (finished — the CLI re-invokes the model right after; the
                # continuous reader streams that turn live). Forward a
                # normalized `bg_task` event keyed by task_id; the hub persists
                # it and the UI keeps a per-session registry (BgTasks bar).
                kind = {
                    "TaskStartedMessage": "started",
                    "TaskUpdatedMessage": "updated",
                    "TaskNotificationMessage": "finished",
                }[ev_type]
                payload: dict[str, Any] = {"kind": kind}
                for key in ("task_id", "description", "tool_use_id",
                            "task_type", "status", "output_file", "summary"):
                    v = getattr(ev, key, None)
                    if v is not None:
                        payload[key] = v
                # workflow_name lives only in the raw SystemMessage `data` (not a
                # typed field) — surface it so the UI can badge a Workflow run
                # distinctly from a plain background bash task.
                _data = getattr(ev, "data", None)
                if isinstance(_data, dict) and _data.get("workflow_name"):
                    payload["workflow_name"] = _data["workflow_name"]
                if payload.get("task_id"):
                    # Stamp the SDK's own verdict on terminal-ness. A kill emits
                    # BOTH vocabularies (updated:killed AND finished:stopped),
                    # so the WORD is what matters, not which message carried it
                    # — and the word list belongs to the SDK, not to us. Absent
                    # on an SDK too old to export it, in which case the hub
                    # falls back to its own normaliser.
                    st = payload.get("status")
                    if TERMINAL_TASK_STATUSES is not None and isinstance(st, str):
                        payload["terminal"] = st.lower() in TERMINAL_TASK_STATUSES
                    elif kind == "finished" and not isinstance(st, str):
                        payload["terminal"] = True
                    out.append({"event": "bg_task", **payload})
            elif ev_type == "TaskProgressMessage" or (
                ev_type == "SystemMessage"
                and getattr(ev, "subtype", None) == "task_progress"
            ):
                # High-frequency progress for a running background task (§14.54).
                # For a Workflow run the raw `data.workflow_progress[]` carries
                # the per-AGENT fan-out (label/state/model/tokens/resultPreview)
                # — the richest live view. Emitted as a TRANSIENT
                # `bg_task_progress` (server.py transient set: no seq, not
                # logged, not replayed — like `usage`) so it never bloats the
                # durable history; the live UI patches the per-task registry in
                # place. (SystemMessage fallback: an SDK that doesn't parse the
                # typed TaskProgressMessage still delivers subtype=task_progress.)
                _data = getattr(ev, "data", None)
                _data = _data if isinstance(_data, dict) else {}
                tid = getattr(ev, "task_id", None) or _data.get("task_id")
                if tid:
                    prog: dict[str, Any] = {"event": "bg_task_progress", "task_id": tid}
                    desc = getattr(ev, "description", None) or _data.get("description")
                    if desc:
                        prog["description"] = desc
                    ltn = getattr(ev, "last_tool_name", None) or _data.get("last_tool_name")
                    if ltn:
                        prog["last_tool_name"] = ltn
                    u = getattr(ev, "usage", None)
                    if not isinstance(u, dict):
                        u = _data.get("usage")
                    if isinstance(u, dict):
                        prog["usage"] = {
                            "tokens": u.get("total_tokens"),
                            "tool_uses": u.get("tool_uses"),
                            "duration_ms": u.get("duration_ms"),
                        }
                    if _data.get("workflow_name"):
                        prog["workflow_name"] = _data["workflow_name"]
                    wf = _data.get("workflow_progress")
                    if isinstance(wf, list):
                        agents, phases = [], []
                        for item in wf:
                            if not isinstance(item, dict):
                                continue
                            it = item.get("type")
                            if it == "workflow_agent":
                                rp = item.get("resultPreview")
                                agents.append({
                                    "index": item.get("index"),
                                    "label": item.get("label"),
                                    "state": item.get("state"),
                                    "model": item.get("model"),
                                    "phaseTitle": item.get("phaseTitle"),
                                    "tokens": item.get("tokens"),
                                    "toolCalls": item.get("toolCalls"),
                                    "durationMs": item.get("durationMs"),
                                    "resultPreview": rp[:600] if isinstance(rp, str) else None,
                                })
                            elif it == "workflow_phase":
                                phases.append({"index": item.get("index"),
                                               "title": item.get("title")})
                        if agents:
                            prog["agents"] = agents
                        if phases:
                            prog["phases"] = phases
                    out.append(prog)
            elif ev_type == "UserMessage":
                content_attr = getattr(ev, "content", None)
                # Where this user turn came from (SDK >= 0.2.137). Anything other
                # than a human typing is invisible otherwise: a message relayed
                # from ANOTHER session (`peer`) arrives as plain-string content,
                # which the branch below drops on the floor, so the session
                # appears to act on nothing. Only the agent-to-agent kinds are
                # surfaced — `task-notification` is already modelled as bg_task
                # (§14.54) and the rest are CLI bookkeeping.
                origin_kind = _field(getattr(ev, "origin", None), "kind", "type")
                if isinstance(origin_kind, str) and origin_kind in ("peer", "coordinator"):
                    text = content_attr if isinstance(content_attr, str) else "".join(
                        getattr(b, "text", "") for b in (content_attr or [])
                        if type(b).__name__ == "TextBlock"
                    )
                    if text.strip():
                        out.append({"event": "external_message",
                                    "origin": origin_kind, "text": text})
                if isinstance(content_attr, str):
                    # Plain-string user content (synthetic CLI injections,
                    # system reminders) — nothing to forward; iterating a str
                    # would yield characters, so normalize to an empty list.
                    content_attr = []
                for block in content_attr or []:
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
            elif ev_type == "StreamEvent":
                # Raw Anthropic stream events (include_partial_messages=True) carry
                # the LIVE token counter: message_start → input tokens; message_delta
                # → the running output_tokens of the in-flight message. We sum across
                # the turn's messages and emit a THROTTLED, TRANSIENT `usage` event so
                # the UI can show "thinking… 3m48s · ↑14.2k tokens" (§14.50). Text is
                # still emitted from the full AssistantMessage — we use partials only
                # for usage, so streaming behaviour is unchanged.
                raw = getattr(ev, "event", None)
                if isinstance(raw, dict):
                    rtype = raw.get("type")
                    if rtype == "message_start":
                        mo = raw.get("message")
                        u = mo.get("usage") if isinstance(mo, dict) else None
                        u = u if isinstance(u, dict) else {}
                        # input_tokens is the FULL context of THIS API call and grows
                        # across a multi-message (tool-using) turn → take the LATEST,
                        # never sum (summing N-counts the same context).
                        self._usage_in = int(u.get("input_tokens") or 0)
                        self._usage_cache = int(u.get("cache_read_input_tokens") or 0)
                    elif rtype == "message_delta":
                        u = raw.get("usage")
                        u = u if isinstance(u, dict) else {}
                        self._usage_cur_out = int(u.get("output_tokens") or self._usage_cur_out)
                        now = time.monotonic()
                        if now - self._usage_last_emit >= 0.6:
                            self._usage_last_emit = now
                            out.append({"event": "usage",
                                        "output_tokens": self._usage_committed_out + self._usage_cur_out,
                                        "input_tokens": self._usage_in})
                    elif rtype == "message_stop":
                        self._usage_committed_out += self._usage_cur_out
                        self._usage_cur_out = 0
                        out.append({"event": "usage",
                                    "output_tokens": self._usage_committed_out,
                                    "input_tokens": self._usage_in})
            elif ev_type == "ResultMessage":
                subtype = getattr(ev, "subtype", "")
                ru = getattr(ev, "usage", None)
                ru = ru if isinstance(ru, dict) else {}
                # Explicit None checks (not `or`): a genuine 0 (e.g. cache_read=0)
                # must NOT fall back to the partial-stream estimate.
                def _u(key: str, fallback: int) -> int:
                    v = ru.get(key)
                    return int(v) if isinstance(v, (int, float)) else fallback
                # `usage` counts the MAIN thread only. `model_usage` (SDK >=
                # 0.2.126) is the whole-tree total, subagents included — which is
                # every ultracode/Workflow session (§14.56). Reporting `usage`
                # there under-counts by however much the fan-out spent; the CLI
                # had the identical bug in its own /stats until 2.1.89. Prefer the
                # tree total, fall back to the main-thread one on older SDKs.
                tree = _sum_model_usage(getattr(ev, "model_usage", None))
                usage_ev: dict[str, Any] = {
                    "event": "usage", "final": True,
                    "output_tokens": _u("output_tokens", self._usage_committed_out + self._usage_cur_out),
                    "input_tokens": _u("input_tokens", self._usage_in),
                    "cache_read_tokens": _u("cache_read_input_tokens", self._usage_cache),
                    # Cache WRITES: the API may report them only under a nested
                    # `cache_creation` breakdown (CLI 2.1.152 fixed the same
                    # zero-reporting bug), so read the flat key then the nested one.
                    "cache_write_tokens": _u("cache_creation_input_tokens",
                                             _nested_cache_creation(ru)),
                    "duration_ms": int(getattr(ev, "duration_ms", 0) or 0),
                    "cost_usd": getattr(ev, "total_cost_usd", None),
                }
                if tree:
                    usage_ev["tree"] = tree
                out.append(usage_ev)
                # Typed turn outcome (SDK >= 0.2.126). `terminal_reason` says WHY
                # the turn ended (completed | max_turns | aborted_streaming |
                # aborted_tools) and `api_error_status` carries the HTTP status
                # when the API is what failed. The hub layers these ABOVE the
                # assistant-text regexes of §14.65/68 — it does not replace them,
                # because an older CLI still reports failures only as prose.
                # A brand-new session has no transcript file yet, so the
                # title write attempted at session_id time fails. Retry here:
                # by the end of a turn the file exists. Deliberately NOT in the
                # Stop hook — that hook does not fire on a turn that ended in
                # error, and was observed silent on some VPSes entirely, so a
                # session would keep its uuid as a title forever.
                if self.name and not self._cli_title_written:
                    self._cli_title_written = self.write_cli_title(self.name)

                stop_ev: dict[str, Any] = {"event": "stop", "subtype": subtype or ""}
                for key, wire in (
                    ("terminal_reason", "terminal_reason"),
                    ("stop_reason", "stop_reason"),
                    ("api_error_status", "api_error_status"),
                ):
                    v = getattr(ev, key, None)
                    if isinstance(v, (str, int)):
                        stop_ev[wire] = v
                if getattr(ev, "is_error", None) is True:
                    stop_ev["is_error"] = True
                out.append(stop_ev)
            elif ev_type == "RateLimitEvent":
                # Rate-limit state, free and out-of-band-free.
                #
                # ⚠ It does NOT carry `utilization` on a subscription account
                # (measured: None) — §14.58's note still holds, so this can NOT
                # replace the /api/oauth/usage poll that feeds the percentage
                # gauges, and §14.72's pacing machinery stays. What it DOES give
                # is the part that machinery pays the most for: whether we are
                # limited right now and when the window resets, at zero network
                # cost and with no 429 to escalate against.
                info = getattr(ev, "rate_limit_info", None) or ev
                payload: dict[str, Any] = {"event": "rate_limit"}
                for attr, wire in (
                    ("status", "status"),
                    ("rate_limit_type", "window"),
                    ("resets_at", "resets_at"),
                    ("utilization", "utilization"),
                    ("overage_status", "overage_status"),
                ):
                    v = _field(info, attr)
                    if isinstance(v, (str, int, float)):
                        payload[wire] = v
                if len(payload) > 1:
                    out.append(payload)
            elif ev_type == "SystemMessage":
                # Everything the CLI tells us about itself arrives here and used
                # to be discarded wholesale.
                sub = getattr(ev, "subtype", None)
                sdata = getattr(ev, "data", None)
                sdata = sdata if isinstance(sdata, dict) else {}
                if sub == "compact_boundary":
                    # The CLI just replaced the conversation with a summary. Our
                    # OWN transcript keeps every message (it lives in the hub's
                    # SQLite, not in the CLI's), so nothing is lost — but from
                    # here on the model no longer remembers what is above. That
                    # is invisible without a marker, and reads as "the session
                    # went stupid". Durable on purpose: it must survive a
                    # refetch and sit at the right place in history.
                    ev_out: dict[str, Any] = {"event": "compaction"}
                    trig = sdata.get("trigger") or sdata.get("compact_trigger")
                    if isinstance(trig, str) and trig:
                        ev_out["trigger"] = trig
                    for k in ("pre_tokens", "post_tokens"):
                        v = sdata.get(k)
                        if isinstance(v, (int, float)):
                            ev_out[k] = int(v)
                    out.append(ev_out)
                elif sub == "init":
                    # Feature detection, the sanctioned way (CLI >= 2.1.205):
                    # `capabilities[]` instead of comparing version strings.
                    # Also carries the real tool list (native builds swap
                    # Glob/Grep for embedded bfs/ugrep) and the per-model effort
                    # support, which we otherwise hard-code in three places
                    # (§14.35) and get wrong whenever Anthropic moves the levels.
                    info: dict[str, Any] = {}
                    for key, wire in (
                        ("capabilities", "capabilities"),
                        ("slash_commands", "slash_commands"),
                        ("tools", "tools"),
                        ("plugins", "plugins"),
                    ):
                        v = sdata.get(key)
                        if isinstance(v, list):
                            info[wire] = [x for x in v if isinstance(x, (str, int))]
                    efforts = _extract_effort_support(sdata)
                    if efforts:
                        info["model_efforts"] = efforts
                    if info:
                        out.append({"event": "session_info", **info})
        except Exception as e:
            out.append({"event": "error", "msg": f"translate: {e}"})
        return out

    def _begin_turn(self) -> None:
        """Mark the start of a turn — from USER INPUT or a SPONTANEOUS CLI
        re-invoke (a background task completed and the harness woke the model
        with a <task-notification>). Resets the per-turn usage counters
        (§14.50) and flips to 'thinking'. Idempotent while already thinking:
        steering input sent mid-turn must not reset the counters or re-emit."""
        if self.status == "thinking":
            return
        self._usage_in = self._usage_cache = 0
        self._usage_committed_out = self._usage_cur_out = 0
        self._usage_last_emit = 0.0
        self.status = "thinking"
        self._emit("status", status="thinking")

    def _end_turn(self) -> None:
        """Turn finished (ResultMessage seen). Back to idle 'active'."""
        if self.status != "thinking":
            return
        self.status = "active"
        self._emit("status", status="active")

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
                    # Stop carries the answer the hub used to REBUILD: which
                    # background tasks are still alive at the moment the turn
                    # ends (§14.91), plus the final assistant text. Native
                    # Python event — no mcp_tool indirection needed.
                    "Stop": [HookMatcher(hooks=[self._on_stop_hook])],
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
            if self.effort == "ultracode":
                # "ultracode" is NOT an SDK EffortLevel — it's xhigh effort +
                # STANDING dynamic-workflow orchestration (the Workflow tool on
                # by default). It's enabled via the CLI `ultracode` settings key
                # (apply_flag_settings), passed here as inline --settings JSON
                # (merged on top of project settings). We deliberately DON'T set
                # the `effort` kwarg — the setting pins xhigh itself. Requires an
                # xhigh-capable model + the Workflows feature on the account;
                # if unavailable the CLI just runs without it. §14.35 / §14.56.
                options_kwargs["settings"] = json.dumps(
                    {"enableWorkflows": True, "ultracode": True}
                )
            elif self.effort:
                options_kwargs["effort"] = self.effort
            # Live token usage (§14.50): receive the raw Anthropic stream events
            # (StreamEvent) so we can surface a growing token counter. Dropped by
            # _build_options_with_fallback on an SDK too old to know the kwarg →
            # graceful degradation (no live counter, final ResultMessage usage
            # still works).
            options_kwargs["include_partial_messages"] = True
            # Raise the CLI-stdout NDJSON framing cap well above the SDK's 1 MiB
            # default so a single big tool_result doesn't overflow the buffer and
            # kill the stream reader mid-turn (§14.55). Dropped by
            # _build_options_with_fallback on an SDK too old to accept the kwarg.
            options_kwargs["max_buffer_size"] = _MAX_BUFFER_SIZE
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
                asyncio.create_task(self._emit_model_catalog(client))

                # ── Continuous stream reader ─────────────────────────────────
                # The CLI can start a turn WITHOUT user input: when a
                # background task (Bash run_in_background / subagent) finishes,
                # the harness re-invokes the model with a <task-notification>.
                # The old loop only read the stream inside receive_response()
                # during a user query, so those spontaneous messages sat
                # UNREAD in the transport until the next user input flushed
                # them all at once ("send a message to see what the agent
                # wanted to tell you"). The reader below owns the stream 100%
                # of the time; query() only ever SENDS. Turn boundaries:
                #   - any Assistant/Stream/User message while 'active'
                #     → _begin_turn (spontaneous turn starts)
                #   - ResultMessage → _translate emits usage-final + stop,
                #     then _end_turn flips back to 'active'
                async def _read_stream() -> None:
                    try:
                        async for ev in client.receive_messages():
                            ev_type = type(ev).__name__
                            if ev_type in ("AssistantMessage", "StreamEvent",
                                           "UserMessage", "TaskNotificationMessage"):
                                # (SystemMessage excluded: the init frame at
                                # connect must not fake a turn start.
                                # TaskNotificationMessage included: a finished
                                # background task re-invokes the model — flip
                                # to 'thinking' as early as possible.)
                                self._begin_turn()
                            for out in self._translate(ev):
                                self._emit_to_server({
                                    "session_id": self.session_id, **out
                                })
                            if ev_type == "ResultMessage":
                                self._end_turn()
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        self._emit("error", msg=self._format_err("stream", e))
                        # Unblock the stdin loop so the session winds down
                        # instead of sitting deaf forever.
                        await self._stdin_queue.put(None)

                # Very old SDKs (< receive_messages) fall back to the legacy
                # per-query consumption — background re-invokes stay deferred
                # there (upgrade the SDK, cf. CLAUDE.md §14.53).
                use_reader = hasattr(client, "receive_messages")
                reader_task = (
                    asyncio.create_task(
                        _read_stream(), name=f"reader-{self.session_id}"
                    ) if use_reader else None
                )

                try:
                    while True:
                        msg = await self._stdin_queue.get()
                        if msg is None:
                            # Stop requested (or the reader died)
                            break
                        if msg.get("type") != "user_message":
                            continue
                        content = msg.get("content") or ""
                        self._begin_turn()
                        try:
                            await client.query(content)
                            if not use_reader:
                                async for ev in client.receive_response():
                                    for out in self._translate(ev):
                                        self._emit_to_server({
                                            "session_id": self.session_id, **out
                                        })
                                self._end_turn()
                        except Exception as e:
                            self._emit("error", msg=self._format_err("query", e))
                            # No turn will stream after a failed send — don't
                            # leave the pill stuck on 'thinking'.
                            self._end_turn()
                finally:
                    if reader_task is not None:
                        reader_task.cancel()
                        try:
                            await reader_task
                        except (asyncio.CancelledError, Exception):
                            pass
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
