# Codex migration — making Charon multi-agent (Claude **and** Codex)

Status: implemented 2026-07-21/22 (agent 0.15.0 → **0.16.0**). This document is
the source of truth for **what changed**, **what reached feature parity**, and —
most importantly — **what is NOT compatible** and why, plus the design choices
and the alternatives we rejected. Companion sections in CLAUDE.md: §14.59
(backend), §14.60 (health chips), §14.61 (codex login).

Charon is no longer a Claude-only hub. Every session now carries a `kind`
(`'claude' | 'codex'`) and is driven by the matching backend:

- **Claude** — `claude-agent-sdk` (`ClaudeSDKClient`), unchanged.
- **Codex** — the official **`openai-codex`** Python SDK, which drives a local
  `codex app-server` over JSON-RPC. Installed into the same per-VPS venv
  (`~/.charon/venv`) as `claude-agent-sdk`; it bundles its own `codex` CLI
  binary (`openai-codex-cli-bin`), so no separate CLI install is needed.

A VPS can run **either or both** backends: Claude iff the agent is up +
`claude login` done; Codex iff `openai-codex` is importable in the venv +
signed in to Codex (ChatGPT device-code from the hub, §14.61, or an API key).
The Agent launcher shows one **Claude** and one **Codex** button per VPS,
greyed out when that backend isn't available.

---

## 1. Architecture

The agent daemon gained a sibling to `AgentSession`:
`agent/charon_agent/codex_session.py` → `CodexSession`. It exposes the **exact
same public + private contract** `server.py` drives (start/stop/force_stop/
send_input/interrupt/set_permission_mode/set_model/set_effort/respond_*/to_info/
to_persist, plus the `_stopped`/`_ready_evt`/`_session_id_emitted`/`_main_task`/
`_client` attrs the resume path pokes), and **translates the Codex app-server
notification stream into the identical Charon event vocabulary** the hub already
understands. `server.py` picks the class via a `kind` factory
(`_make_session`). Result: ~65-70% of the hub + the entire chat-rendering
frontend are reused unchanged — anything that consumes the event vocabulary
just works.

Codex is **turn-based**: `thread.turn(input)` starts a turn and returns a
handle; `handle.stream()` yields notifications until the turn completes (it
breaks itself on `TurnCompletedNotification`). We consume `stream()` only
(calling `.run()` too would open a second stream and deadlock). `handle.
interrupt()` and `handle.steer()` drive the live turn.

### Event mapping (Codex notification → Charon event)

| Codex app-server notification / item | Charon event |
|---|---|
| `ThreadStarted` (thread.id) | `session_id {claude_session_id = thread id}` |
| `TurnStarted` | `status: thinking` (`_begin_turn`) |
| `AgentMessageDeltaNotification.delta` | `assistant_text {delta}` (token-level) |
| `ReasoningTextDelta` / `ReasoningSummaryTextDelta` | `thinking {text}` |
| `ItemStarted/Completed` → `CommandExecutionThreadItem` | `tool_use {name:'shell'}` + `tool_result {content: aggregated_output, is_error: exit_code≠0}` |
| `…FileChangeThreadItem` (unified `diff` per file) | `tool_use {name:'apply_patch'}` + `edit_snapshot {phase:'diff', diff}` + `tool_result` |
| `…McpToolCallThreadItem` | `tool_use {name:'server/tool'}` + `tool_result` |
| `…WebSearchThreadItem` | `tool_use {name:'web_search'}` + `tool_result` |
| `…SubAgentActivityThreadItem` | `bg_task` (started/updated/finished) |
| `TurnPlanUpdated` (plan steps) | `todo_update {todos}` |
| `ThreadTokenUsageUpdated` (`last`/`total` breakdown) | `usage {output_tokens, input_tokens}` |
| `TurnCompleted` (status) | `usage {final}` + `stop {subtype}` → `status: active` |
| `ErrorNotification` (will_retry) | `error {msg, fatal: !will_retry}` |

New agent RPCs: `list_codex_models` (the account-driven per-VPS catalog, from
`codex.models()`), `get_codex_usage` (rate-limit gauges), and — since 0.16.0 —
`codex_login_start` / `codex_login_status` / `codex_login_cancel` (the
ChatGPT device-code sign-in, §14.61). `hello` also reports `codex_available` /
`codex_error` / `codex_sdk_version` / `codex_cli_version`.

### Config semantics (a nice win over Claude)

Codex applies `model` / `effort` / `sandbox` / `approval` **per turn**, so a
mid-session model/effort/mode change takes effect on the **next turn with no
sleep+resume**. (Claude binds the model at client construction, so its changes
are deferred to the next SDK start — the ⏳/"apply now ↻" badge. That badge is
**not** shown for Codex.)

Per-session storage reuses the existing columns: for a `codex` row,
`claudeSessionId` = the Codex **thread id** (resume handle), `permissionMode` =
the Codex **sandbox mode**, `model` = a Codex model id, `effort` = a Codex
effort; `fallbackModel` is unused. New DB columns: `claude_sessions.kind`
(+ `vps.codex_available` / `codex_sdk_version` / `codex_logged_in` /
`codex_logged_in_checked_at`) in migration `0021`; `vps.agent_last_error`
(health chips, §14.60) in `0022`.

---

## 2. Feature parity

| Feature | Codex | Notes |
|---|---|---|
| Start / resume by id | ✅ | `thread_start` / `thread_resume(thread id)`; survives Charon + agent restarts via the same reconcile path as Claude. |
| Streaming assistant text | ✅ | Token-level deltas (`AgentMessageDelta`) — same typewriter as Claude. |
| Thinking / reasoning | ✅ | Reasoning text + summary deltas → `thinking`. |
| Tools (shell / patch / mcp / web) | ✅ | Rendered as tool cards via the shared vocabulary. |
| **Diffs** | ✅ | Codex emits a unified `diff` per file → shown in the diffs view (`edit_snapshot phase:'diff'`, served lazily by `/edits`). NB: Codex gives a diff, not before/after content, so revert-from-diff is not offered for Codex edits. |
| **Todos** | ✅ | `TurnPlanUpdated` → `todo_update` (pending/in_progress/completed). |
| **Interrupt** | ✅ | `handle.interrupt()`. |
| **Force-stop** | ✅ | Cancels the turn + tears down the client → `sleeping` (resumable). |
| **Sleep / resume** | ✅ | Same lifecycle; thread id kept for resume. |
| **Model change** | ✅ | Per-turn, applied immediately (no restart badge). |
| **Effort change** | ✅ | Codex efforts none/minimal/low/medium/high/xhigh/max/ultra, catalog-gated per model. `ultra` ≈ Claude's `ultracode` (Workflow delegation). |
| **Mode change** | ✅ (redefined) | Codex "mode" = sandbox level (read-only / workspace-write / full-access). |
| Token counter | ✅ | Live `usage` from `ThreadTokenUsageUpdated` + final on turn completion. |
| Background tasks | ~ | Codex sub-agent activity surfaces as `bg_task`, but Codex has no Workflow-tool fan-out equivalent to Claude's `bg_task_progress` panel — the BgTasks bar is sparser for Codex. |
| Account-usage gauges | ✅ (best-effort) | `get_codex_usage` → the same `<UsageMeter>`, mapped to fiveHour/sevenDay. See §3.4. |
| Model catalog | ✅ | `codex.models()` per-VPS (account-driven), no API key needed (unlike Claude's `/v1/models`, §14.43). |
| Per-VPS login | ✅ | In-hub **device-code** sign-in (§14.61): `codex_login_*` RPCs → `/api/vps/[id]/codex/login` → `<CodexLoginModal>`. Also works with a pre-seeded `~/.codex/auth.json` or API key. |
| Auto-update | ✅ | `openai-codex` freshness folded into the existing SDK-watch tick (§7); update flow pip-installs it per VPS. |
| Settings defaults | ✅ | `codex.default_model` / `codex.default_effort` in the redesigned two-pane SettingsModal, catalog-driven via the first codex-capable VPS. |

---

## 3. INCOMPATIBILITIES (read this)

### 3.1 Interactive permission gating — **NOT supported for Codex** (the big one)

Claude's whole interactive-permission UX — per-tool **permission cards**
(allow/deny), **exit-plan** review, and the in-memory **`alwaysAllow`** set —
has **no equivalent** when driving Codex through `openai-codex`.

Why: the SDK exposes only two approval modes — `auto_review` (a server-side
"guardian" sub-agent auto-decides escalations) and `deny_all` — and its message
router has **no channel to forward a per-tool approval request to the host** and
await a human answer (verified by reading the SDK source: `_approval_mode.py`
maps `auto_review → on_request + reviewer=auto_review`, `deny_all → never`;
`_message_router.py` routes responses / turn notifications / login / global
notifications, but **nothing for server-initiated `execCommandApproval` /
`applyPatchApproval` requests**). Those human-in-the-loop approval requests DO
exist at the raw `codex app-server` / MCP protocol level (with a `reviewer:
"user"` mode), but the Python SDK deliberately does not surface them.

**What Codex uses instead:** the **sandbox** is the guardrail. A Codex session's
"mode" selects the sandbox level:

| Charon Codex mode | Codex sandbox + approval |
|---|---|
| `read-only` | `read-only` + `deny_all` (analyze only) |
| `workspace-write` (default) | `workspace-write` + `auto_review` (edit workspace + run commands, escalations auto-reviewed) |
| `full-access` | `danger-full-access` + `auto_review` (no sandbox) |

Consequence: for a Codex session you will **not** see permission prompts,
exit-plan cards, or alwaysAllow — you choose the trust level up front via the
mode. This was the incompatibility flagged up front; it is inherent to the
`openai-codex` SDK, not a Charon limitation.

**Alternative we rejected (for now):** drive `codex app-server`'s JSON-RPC
directly (bypassing the SDK) to intercept `execCommandApproval` /
`applyPatchApproval` and render Charon's permission cards. Rejected for v1
because it means re-implementing the SDK's transport/thread/turn machinery
against an **experimental** protocol ("subject to change without notice"), for a
large amount of code and ongoing churn. Revisit if human approval becomes a hard
requirement.

### 3.2 Fallback model — not a Codex concept

Codex has no `fallback_model`. The fallback-model picker is hidden for Codex
sessions; the column stays null. (Codex does server-side tier substitution
itself, which isn't configurable.)

### 3.3 Effort levels differ

Claude: low/medium/high/xhigh/max + the `ultracode` pseudo-effort. Codex:
none/minimal/low/medium/high/xhigh/max/ultra, **catalog-gated per model** (e.g.
gpt-5.6-luna tops out at xhigh; sol offers max/ultra). Pickers are
catalog-driven per kind, so each session only offers what its model supports.

### 3.4 Account-usage gauges are best-effort

Codex has no `/v1/oauth/usage` equivalent surfaced by the SDK. We read the
app-server's `account/rateLimits/read` (via the SDK's low-level `request()`),
which returns rate-limit **windows** (`used_percent`, `resets_at`,
`window_duration_mins`). We classify windows by duration into the same 5h /
weekly slots the Claude gauges use. Some plans expose only one window (e.g. a
weekly window only), so a gauge may be blank. Utilization %, not token counts.

### 3.5 Miscellaneous

- **Diff revert**: Codex reports a unified diff, not before/after content, so
  the "revert this edit" affordance (which re-writes the pre-edit content) is
  Claude-only.
- **`bg_task_progress`** (the Workflow per-sub-agent fan-out panel) is
  Claude-specific; Codex sub-agents show only as coarse `bg_task` entries.
- **Live per-token input counter**: Claude streams raw Anthropic `usage` per
  message; Codex reports usage per `ThreadTokenUsageUpdated` (coarser cadence).
- **Codex login ≠ a PTY console.** Claude's login is an xterm over SSE running
  `claude login`; Codex's browser flow can't work on a headless VPS (OAuth
  callback → localhost:1455 on the VPS), so the hub uses the SDK's
  **device-code** flow instead (§14.61): `codex_login_start` returns a
  verification URL + user code, you approve from any device, the app-server
  writes `~/.codex/auth.json` itself, and the hub polls `codex_login_status`.
  One attempt at a time, 14-min TTL.

---

## 4. What could have been done differently

- **Transport**: we chose the official `openai-codex` Python SDK (drives
  `codex app-server`) over (a) `codex exec --json` — rejected: one-shot per turn
  and its `--json` drops tool args/results (issue #5028); (b) the TypeScript
  `@openai/codex-sdk` — rejected: Node, and it wraps `codex exec` (no live
  approvals, abort-only); (c) hand-rolling the app-server JSON-RPC — rejected:
  experimental churn. The Python SDK matched Charon's Python-daemon architecture
  almost exactly.
- **Table naming**: we kept the `claude_*` table names and added a `kind`
  discriminator rather than renaming to neutral names — a rename touches 100+
  files and 27 API routes for zero functional gain. `claudeSessionId` doubling
  as the Codex thread id is deliberate reuse, documented in the schema.
- **Permissions**: see §3.1 — the app-server-direct path remains the escape
  hatch if human approval is later required.

---

## 5. Verification (end-to-end, real agent) + bugs fixed

Tested against a real Codex session on this server (ChatGPT-plus account),
driving the built pyz over its socket in an isolated `CHARON_AGENT_HOME`:

- `hello` → `codex_available=true`, sdk/cli `0.144.4`.
- `list_codex_models` → 6 models, default `gpt-5.6-sol`.
- `start_session kind=codex` → `{session_id, kind:'codex'}`, `ready`.
- A turn ("create out.txt=OK, run `echo hello123`, say DONE") streamed:
  `session_id` (thread id), `mode_changed`, `effective_model`, live
  `assistant_text` deltas, **`tool_use apply_patch` + `edit_snapshot{diff}` +
  `tool_result`**, **`tool_use shell` + `tool_result` (`hello123`)**, live +
  final `usage`, `stop`. **File created on disk.** ✅
- `set_model` / `set_effort` → `applied_at_next_start: false` (Codex per-turn). ✅
- `interrupt` mid-turn → `interrupted` event. ✅
- `sleep_session` → `resume_session` → back to running. ✅
- `get_codex_usage` → `{ok, plan_type:'plus', seven_day:{used_percent, resets_at, window_minutes:10080}}`. ✅
- Live-hub verification post-deploy: `GET /api/codex/models?vpsId=…` returns the
  catalog; `GET /api/vps/[id]/usage` returns `{usage, codexUsage}`. ✅

**Two bugs found during the live test and fixed:**
1. `event_log.append error: Object of type LegacyAppPathString is not JSON
   serializable` — Codex `cwd`/path fields are pydantic RootModel wrappers.
   Fixed by (a) `CodexSession._path_str`/`_json_safe` coercing path/args to
   JSON-native before emit, and (b) hardening `event_log.append` with
   `default=str` (the live socket send already did this).
2. `set_model`/`set_effort` returned `applied_at_next_start:true` for Codex —
   wrong (Codex applies per-turn). `server.py` now returns `false` for `kind==codex`.

## 6. Rollout

1. Hub: `npm run build && systemctl restart charon` (node v20, §14.3) — done.
2. Fleet: the rebuilt `agent/dist/charon-agent.pyz` (new sha) rolls via the
   "update agent" button / the auto-tick, which also `pip install openai-codex`
   per VPS (`ensureCodexLatest`). On VPSes already signed in to Codex, Codex
   lights up on its own (hello → `codexAvailable`, usage poll → `codexLoggedIn`);
   others get the in-hub device-code login (§14.61). Sequence self-hosted VPSes
   LAST (§14.53).
