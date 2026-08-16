// TypeScript mirror of the agent's JSON-RPC protocol (agent/charon_agent/protocol.py).
// Events are aligned with lib/server/claude/types.ts (BridgeEvent) — the wire
// type differs slightly: we have an "event" string instead of a "type".

// Agent-type discriminator (multi-agent support). 'claude' = Claude Agent SDK
// (ClaudeSDKClient), 'codex' = OpenAI Codex (openai-codex → codex app-server).
export type AgentKind = 'claude' | 'codex';

export type PermissionMode = 'normal' | 'acceptEdits' | 'auto' | 'plan';

// Codex sessions have NO interactive human approval (cf. CLAUDE.md §14.59):
// their "mode" is a SANDBOX level (the guardrail). Stored in the same
// permission_mode field as Claude's modes.
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'full-access';

// Superset used wherever a session's mode is read regardless of kind.
export type SessionMode = PermissionMode | CodexSandboxMode;

// Mirrors claude_agent_sdk.EffortLevel literal. Newer SDK versions may add
// values; if so, also extend this union (the agent silently drops unknown
// effort values, so adding new ones here without bumping the agent is safe).
// 'ultracode' = Charon pseudo-effort (xhigh + dynamic-workflow orchestration),
// applied agent-side via options.settings, not the SDK effort kwarg (§14.56).
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';

// Codex reasoning-effort levels (catalog-driven per model). 'ultra' is Codex's
// Workflow-delegation tier (the analog of Claude's 'ultracode').
export type CodexEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

// Superset effort used at the wire/hub level regardless of kind.
export type AnyEffort = EffortLevel | CodexEffort;

export type AgentSessionStatus =
  | 'starting'
  | 'active'
  | 'thinking'
  | 'sleeping'
  | 'killed'
  | 'error';

export type AgentSessionInfo = {
  // 'claude' (default when absent — agents < 0.15.0 omit it) | 'codex'.
  kind?: AgentKind;
  session_id: string;
  claude_session_id: string | null;
  cwd: string;
  name: string | null;
  permission_mode: SessionMode;
  status: AgentSessionStatus;
  // Optional because agents < 0.5.0 don't emit these fields. null/undefined
  // both mean "use the default" (global setting → SDK default).
  model?: string | null;
  fallback_model?: string | null;
  effort?: AnyEffort | null;
};

export type AgentHelloResult = {
  agent_version: string;
  // SHA256 (first 12 chars) of the .pyz that is running. Compared to the sha
  // of the pyz embedded in the dashboard to detect "agent out of date".
  // Optional because older agents (<0.2.0) don't return it.
  agent_pyz_sha?: string;
  sdk_available: boolean;
  sdk_error: string | null;
  // Installed `claude-agent-sdk` version in the VPS venv (>= 0.12.0 agents).
  // Absent on older agents — persist ONLY when !== undefined so an old
  // agent's hello never null-clobbers a value written by the update flow.
  sdk_version?: string | null;
  // ── Codex (OpenAI) availability (agent >= 0.15.0). ──
  // Absent on older agents — persist ONLY when !== undefined so an old
  // agent's hello never null-clobbers a value written by the update flow.
  codex_available?: boolean;
  codex_error?: string | null;
  codex_sdk_version?: string | null;
  codex_cli_version?: string | null;
  pid: number;
  sessions: AgentSessionInfo[];
};

// A single Codex model from the catalog (list_codex_models RPC). The catalog
// is account-driven and per-VPS (openai_codex .models()). efforts is the
// per-model supported reasoning-effort list (drives the effort picker,
// catalog-style like Claude).
export type CodexModelInfo = {
  id: string;
  display_name?: string | null;
  description?: string | null;
  is_default?: boolean;
  hidden?: boolean;
  default_effort?: string | null;
  efforts?: string[];
  supports_personality?: boolean;
};

export type AgentCodexModelsResult =
  | { ok: true; models: CodexModelInfo[]; sdk_version?: string | null; cli_version?: string | null }
  | { ok: false; error: string };

// Codex account-usage snapshot (get_codex_usage RPC) — rate-limit utilization,
// mapped onto the same shape the Claude /usage gauges consume (§14.58).
export type CodexRateWindow = {
  used_percent: number | null;
  resets_at: number | null;
  window_minutes: number | null;
};
export type AgentCodexUsageResult =
  | {
      ok: true; provider: 'codex'; plan_type?: string | null;
      five_hour: CodexRateWindow | null; seven_day: CodexRateWindow | null;
      windows?: CodexRateWindow[]; fetched_at: number;
    }
  | { ok: false; error: string };

// Common fields attached to every event by the agent's durable event log
// (>= 0.4.0). Both are optional because (a) older agents don't emit them
// and (b) replay markers (`replay_begin`/`replay_end`) intentionally omit
// the seq — they wrap the replayed events, they aren't replayed themselves.
export type AgentEventCommonFields = {
  // Monotonically increasing per-session sequence number. Used by Charon
  // to checkpoint progress (`last_seen_seq` in DB) and request durable
  // replay via `subscribe({after_seq: lastSeenSeq})`. Absent on agents
  // pre-0.4.0 and on replay marker events.
  seq?: number;
  // Server-side timestamp (Unix seconds, float) the agent stamped when
  // appending to the log. Useful for debugging out-of-order delivery.
  ts?: number;
};

// Events pushed by the agent. session_id required for all except global
// errors (rare). We keep a wide union to not lie to ourselves.
export type AgentEvent = (
  | { event: 'replay_begin'; session_id: string; count: number }
  | { event: 'replay_end'; session_id: string }
  // HUB-SYNTHETIC (not sent by the agent): AgentClient fabricates this from
  // the subscribe RPC result when the agent (>= 0.18.0) reports that its
  // durable log rotated past our cursor — events (after_seq, earliest_seq)
  // exclusive are gone for good. sessionOps surfaces the hole explicitly
  // (log + persisted event row + UI banner) instead of silently presenting
  // a truncated transcript. No seq (it isn't a logged event).
  | { event: 'replay_gap'; session_id: string; after_seq: number; earliest_seq: number }
  | { event: 'status'; session_id: string; status: AgentSessionStatus }
  | { event: 'ready'; session_id: string }
  | { event: 'session_id'; session_id: string; claude_session_id: string }
  // `uuid` (agent >= 0.39.0) is the CLI transcript's own id for the message
  // these deltas belong to — the anchor a fork branches at. First delta of a
  // message carries it; the hub stamps it on the flush row.
  | { event: 'assistant_text'; session_id: string; delta: string; uuid?: string }
  | { event: 'thinking'; session_id: string; text: string }
  | { event: 'tool_use'; session_id: string; id: string; name: string; input: any }
  | { event: 'tool_result'; session_id: string; tool_use_id: string; content: string; is_error: boolean }
  | { event: 'tool_progress'; session_id: string; tool_use_id: string; delta: string }
  | { event: 'edit_progress'; session_id: string; tool_use_id: string; file_path: string; diff: string; size: number; truncated: boolean }
  | { event: 'plan_progress'; session_id: string; id: string; text: string }
  | { event: 'plan_update'; session_id: string; id: string; explanation?: string | null; steps: Array<{ step: string; status: string }> }
  | { event: 'tool_activity'; session_id: string; kind: string; id: string; status: string; detail?: any }
  | { event: 'permission_request'; session_id: string; id: string; tool: string; input: any }
  | { event: 'user_question'; session_id: string; id: string; questions: any[] }
  | { event: 'exit_plan_request'; session_id: string; id: string; plan: string }
  // phase 'before'/'after' (Claude, content-based) OR 'diff' (Codex: `diff`
  // holds a unified diff, content is null). The GET /edits route strips both
  // `content` and `diff` from the poll payload (egress, §14.41).
  | { event: 'edit_snapshot'; session_id: string; phase: 'before' | 'after' | 'diff'; tool_use_id: string; file_path: string; content: string | null; diff?: string | null; size: number; truncated: boolean }
  | { event: 'mode_changed'; session_id: string; mode: SessionMode }
  // model_changed / effort_changed: emitted by agent >= 0.5.0 when set_model
  // or set_effort is invoked. applied_at_next_start is true when the SDK
  // client is currently running (= the change takes effect on next sleep/resume),
  // false when there's no live client (= takes effect on the next start).
  // null fields mean "cleared back to default".
  | { event: 'model_changed'; session_id: string; model: string | null; fallback_model: string | null; applied_at_next_start?: boolean }
  | { event: 'effort_changed'; session_id: string; effort: AnyEffort | null; applied_at_next_start?: boolean }
  // effective_model (agent >= 0.6.0): the model id Anthropic actually used on
  // the last AssistantMessage. Emitted on CHANGE only (= once per turn at
  // most). Useful when the configured `model` is an alias ('opus' → real id)
  // or when fallback_model kicked in. Decouples reality from what the LLM
  // claims about itself in text (which is unreliable — training cutoff).
  // Persisted: claude_sessions.effective_model + stamped per assistant row
  // (claude_session_messages.model, migration 0020).
  | { event: 'effective_model'; session_id: string; model: string }
  // bg_task (agent >= 0.13.0): normalized background-task lifecycle, from the
  // SDK's first-class TaskStartedMessage / TaskUpdatedMessage /
  // TaskNotificationMessage (SDK ≥ 0.2.11x). kind: 'started' (Bash
  // run_in_background / background subagent spawned — tool_use_id links to
  // the launching tool call), 'updated' (status change), 'finished' (task
  // completed; the CLI re-invokes the model right after and the agent's
  // continuous reader streams that turn live). The hub persists each as a
  // role='event' row {type:'bg_task'} and the client keeps a per-session
  // registry (BgTasks bar). Durable (has seq) → replayed.
  | {
      event: 'bg_task'; session_id: string;
      kind: 'started' | 'updated' | 'finished';
      task_id: string;
      description?: string; tool_use_id?: string; task_type?: string;
      status?: string; output_file?: string; summary?: string;
      // Workflow-tool runs (task_type 'local_workflow') carry the script name.
      workflow_name?: string;
      // agent >= 0.36.0: the SDK's OWN verdict (TERMINAL_TASK_STATUSES) on
      // whether this status ends the task. Absent on older agents, where the
      // hub falls back to its word-list normaliser. Prefer this when present:
      // the two hand-written lists drifted in opposite directions (§14.91).
      terminal?: boolean;
    }
  // bg_task_progress (agent >= 0.13.1): high-frequency progress for a running
  // background task. TRANSIENT (broadcast-only, no seq, not replayed — like
  // usage). For a Workflow run, `agents[]` is the per-sub-agent fan-out
  // (label/state/model/tokens/resultPreview) from the raw workflow_progress[].
  // §14.54.
  | {
      event: 'bg_task_progress'; session_id: string;
      task_id: string;
      description?: string; last_tool_name?: string; workflow_name?: string;
      usage?: { tokens?: number | null; tool_uses?: number | null; duration_ms?: number | null };
      agents?: Array<{
        index?: number | null; label?: string | null; state?: string | null;
        model?: string | null; phaseTitle?: string | null; tokens?: number | null;
        toolCalls?: number | null; durationMs?: number | null; resultPreview?: string | null;
      }>;
      phases?: Array<{ index?: number | null; title?: string | null }>;
    }
  // usage (agent >= 0.11.0): live token counter for the CURRENT turn, emitted
  // broadcast-only (transient, no seq) and throttled (~0.6s). `final:true`
  // carries the turn totals (duration_ms, cost_usd) from the ResultMessage. §14.50.
  // `tree` (agent >= 0.36.0) is the WHOLE-TREE total from ResultMessage
  // .model_usage — subagents included. The flat fields count the main thread
  // only, which under-reports every ultracode/Workflow session; the CLI had
  // the same bug in its own /stats until 2.1.89. Absent on older agents.
  | {
      event: 'usage'; session_id: string; output_tokens: number;
      input_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number;
      final?: boolean; duration_ms?: number; cost_usd?: number | null;
      tree?: {
        input_tokens: number; output_tokens: number;
        cache_read_tokens: number; cache_write_tokens: number;
        cost_usd: number | null; models: string[];
      };
    }
  | { event: 'interrupted'; session_id: string; forced?: boolean }
  // stop (agent >= 0.36.0 adds the typed outcome): `terminal_reason` says WHY
  // the turn ended (completed | max_turns | aborted_streaming | aborted_tools),
  // `api_error_status` the HTTP status when the API is what failed. These layer
  // OVER the assistant-prose classifiers of §14.65/68 — they do not replace
  // them, because an older CLI reports failures only as prose.
  | {
      event: 'stop'; session_id: string; subtype?: string;
      terminal_reason?: string; stop_reason?: string;
      api_error_status?: number | string; is_error?: boolean;
    }
  // compaction (agent >= 0.36.0): the CLI replaced the conversation with a
  // summary. Charon's own transcript is untouched (it lives in SQLite, not in
  // the CLI's file), so nothing is lost — but from here on the model no longer
  // remembers what is above, which is invisible without a marker. Durable:
  // persisted as a role='event' row so it survives a refetch and keeps its
  // place in history.
  | { event: 'compaction'; session_id: string; trigger?: string; pre_tokens?: number; post_tokens?: number }
  // session_info (agent >= 0.36.0): the CLI's init frame. `capabilities` is the
  // sanctioned feature-detection channel (CLI >= 2.1.205) — prefer it to
  // comparing version strings. `model_efforts` is per-model effort support,
  // which the hub otherwise hard-codes in three places (§14.35).
  | {
      event: 'session_info'; session_id: string;
      capabilities?: string[]; slash_commands?: string[]; tools?: string[];
      plugins?: string[]; model_efforts?: Record<string, string[]>;
      // The account's REAL model catalog with per-model effort support, read
      // from get_server_info() at start (agent >= 0.37.0). Solves what §14.43
      // could not: a live catalog with no api key. `resolved` expands aliases
      // ('default' → 'claude-opus-5[1m]').
      models?: Array<{
        id: string; resolved?: string; label?: string; hint?: string;
        efforts?: string[]; supports_effort?: boolean;
        supports_adaptive_thinking?: boolean;
      }>;
    }
  // turn_end (agent >= 0.37.0): the Stop hook's verdict at the moment the turn
  // ended — which background tasks are STILL ALIVE, straight from the process
  // that owns them, plus the final assistant text. Replaces §14.91's
  // reconstruction of the same fact. Ordering vs `stop` is not guaranteed, so
  // the hub reconciles rather than assuming it arrives first.
  | {
      event: 'turn_end'; session_id: string;
      background_tasks?: string[]; session_crons?: number;
      last_assistant_message?: string;
    }
  // rate_limit (agent >= 0.37.0): from the SDK's RateLimitEvent. ⚠ `utilization`
  // is NULL on subscription accounts (measured, still true) — this does NOT
  // replace the /api/oauth/usage poll behind the percentage gauges (§14.72). It
  // carries the "limited right now / resets at" half for free.
  | {
      event: 'rate_limit'; session_id: string;
      status?: string; window?: string; resets_at?: number;
      utilization?: number; overage_status?: string;
    }
  // external_message (agent >= 0.36.0): a user turn that did NOT come from the
  // human — currently only the agent-to-agent kinds (`peer`, `coordinator`).
  // It arrives as plain-string content, which the tool-result branch drops, so
  // without this the session acts on a message nobody can see.
  // `from` (agent >= 0.44.0) is the SENDER's addressable name, pulled from the
  // `<cross-session-message from-name=…>` envelope. ⚠ These messages carry NO
  // `origin` field — the envelope inside plain string content is the only
  // signal, which is why the first implementation caught nothing.
  | { event: 'external_message'; session_id: string; origin: string; text: string; from?: string }
  // turn_error (agent >= 0.36.0): typed failure off AssistantMessage.error
  // (authentication_failed, billing_error, …) — the same fact §14.65 infers by
  // regexing prose, stated.
  | { event: 'turn_error'; session_id: string; kind: string }
  | { event: 'error'; session_id: string; msg: string; fatal?: boolean }
  // ── Persistent PTY shells (agent >= 0.7.0) ───────────────────────────────
  // Routed through the same `session_id` channel as Claude sessions (the
  // agent's _emit pipeline keys by that string); the value here is the
  // shell_id. `shell_id` is duplicated as an explicit field for clarity.
  // `shell_output.data` is raw terminal stream (utf-8 with errors='replace').
  // status: 'active' = idle/at-prompt, 'busy' = streaming output (drives the
  // UI's blue "thinking" tab, agent >= 0.9.0), 'exited' = bash ended.
  | { event: 'shell_status'; session_id: string; shell_id: string; status: 'active' | 'busy' | 'exited'; cols: number; rows: number; pid: number | null }
  | { event: 'shell_output'; session_id: string; shell_id: string; data: string }
  | { event: 'shell_exit'; session_id: string; shell_id: string; code: number | null }
  // shell_idle (agent >= 0.8.0): heuristic "the shell finished something"
  // signal — emitted once when an output burst goes quiet (see shell.py).
  // TRANSIENT: not persisted in the agent's durable log (no seq), delivered
  // to shell_subscribe subscribers AND global shell_watch watchers. Charon's
  // notify consumer turns it into a push/telegram notification.
  | { event: 'shell_idle'; session_id: string; shell_id: string; idle_seconds: number; burst_seconds: number; burst_bytes: number }
) & AgentEventCommonFields;

// ── Names of JSON-RPC methods supported by the agent ───────────────────────
// Python source of truth: agent/charon_agent/protocol.py (METHODS set).
// The script scripts/check-protocol-sync.mjs (run before each build via
// `npm run build`) compares both lists and fails the build on drift.
// Any protocol change must touch both places.
export type AgentMethodName =
  | 'hello'
  | 'ping'
  | 'list_sessions'
  | 'get_usage'
  | 'list_codex_models'
  | 'get_codex_usage'
  // Codex ChatGPT device-code login (agent >= 0.16.0) — headless `codex
  // login`: start → {verification_url, user_code}, hub polls status. §14.61.
  | 'codex_login_start'
  | 'codex_login_status'
  | 'codex_login_cancel'
  // Subdirs of a path — hub path autocomplete (agent >= 0.17.0, fsnav.py).
  // The fs route falls back to a one-shot ssh ls on older agents. NB: no
  // semicolon CHARACTER anywhere in comments inside this union —
  // check-protocol-sync.mjs slices the type body at the first one.
  | 'list_dir'
  // Read-only file tree (agent >= 0.25.0, fsnav.py) - fs_list is ONE directory
  // per call (lazy expansion) and fs_read returns utf-8 or base64. Both are
  // contained under the session cwd.
  | 'fs_list'
  | 'fs_read'
  | 'fs_stat'
  // Text write for the editor (agent >= 0.26.0) - atomic, sha-gated.
  | 'fs_write'
  // Explorer context menu (agent >= 0.27.0).
  | 'fs_mkdir'
  | 'fs_rename'
  | 'fs_delete'
  // Search across the tree (agent >= 0.29.0) - grep inside files, or match
  // file names. Bounded in files, matches and wall clock, and every bound it
  // hits comes back as truncated. cf. CLAUDE.md §14.84.
  | 'fs_search'
  // Source control for the hub's git panel (agent >= 0.24.0, git.py). Scoped
  // to the repo containing a cwd, NOT to a session. No ssh fallback exists on
  // purpose - duplicating the porcelain-v2 parser hub-side is the real cost,
  // so an older agent degrades to the unsupported reason. cf. CLAUDE.md §14.76.
  // NB: no quoted words in comments here - check-protocol-sync.mjs reads every
  // quoted token in this type body as a method name.
  | 'git_status'
  // A folder OF projects is a normal cwd: one call returns every checkout at
  // or below it, since --show-toplevel only walks up (agent >= 0.29.0, §14.83).
  | 'git_workspace'
  // Branches (agent >= 0.31.0): list with drift vs upstream AND vs HEAD,
  // switch/create, fetch (what makes behind a real number), safe delete.
  // History (agent >= 0.32.0): paged log for a repo or one file, and one
  // commit's patch. Read-only.
  // Language servers hosted on the VPS (agent >= 0.33.0, lsp.py): diagnostics,
  // hover, go-to-definition and completion for the in-hub editor. §14.89
  | 'lsp_status'
  | 'lsp_open'
  | 'lsp_close'
  | 'lsp_diagnostics'
  | 'lsp_request'
  | 'lsp_apply_edit'
  | 'lsp_stop'
  | 'git_log'
  | 'git_show'
  | 'git_branches'
  | 'git_checkout'
  | 'git_fetch'
  | 'git_delete_branch'
  | 'git_diff'
  | 'git_commit'
  | 'git_push'
  | 'git_pull'
  | 'git_discard'
  | 'start_session'
  | 'resume_session'
  | 'subscribe'
  | 'unsubscribe'
  | 'send_input'
  | 'interrupt'
  | 'force_stop'
  // Stop ONE background task, leaving the session running (agent >= 0.35.0).
  | 'stop_bg_task'
  | 'set_permission_mode'
  | 'set_model'
  | 'set_effort'
  // Mirror Charon's session name into the CLI's own transcript (agent >=
  // 0.38.0) so `claude --resume <name>` and the CLI's cross-session addressing
  // agree with what the dashboard shows.
  | 'set_session_name'
  // Branch a transcript into a NEW session, optionally cutting at a message
  // (agent >= 0.39.0). Pure file work — the original session keeps running.
  | 'fork_session'
  | 'compact_session'
  // Append bounded Responses message items to a loaded Codex thread's durable
  // model-visible history (agent >= 0.46.0). Used by Claude -> Codex forks.
  | 'inject_history'
  // Live context-window usage, MCP server health, and the sub-agent
  // transcripts this session spawned (agent >= 0.40.0). All Claude-only.
  | 'get_context_usage'
  | 'mcp_status'
  | 'mcp_toggle'
  | 'mcp_reconnect'
  | 'list_subagents'
  | 'get_subagent_messages'
  // What Charon calls this session vs what the CLI calls it — so a divergence
  // is visible rather than something the UI asks you to trust (§14.93).
  | 'session_identity'
  // VPS-level: what the CLI itself calls each live session — the ADDRESSABLE
  // name another agent types, which is NOT the transcript title (§14.93).
  | 'cli_agents'
  | 'shell_list'
  | 'shell_start'
  | 'shell_input'
  | 'shell_resize'
  | 'shell_subscribe'
  | 'shell_unsubscribe'
  | 'shell_kill'
  | 'shell_watch'
  | 'shell_unwatch'
  | 'respond_permission'
  | 'respond_question'
  | 'respond_exit_plan'
  | 'sleep_session'
  | 'kill_session';

// Per-shell info returned by `shell_list` and `shell_start` (agent >= 0.7.0).
export type AgentShellInfo = {
  shell_id: string;
  cwd: string | null;
  name: string | null;
  created_at: number;
  cols: number;
  rows: number;
  exited: boolean;
  exit_code: number | null;
  pid: number | null;
};

// Raw envelope returned by the `get_usage` RPC (agent >= 0.14.0). `usage` is the
// verbatim api.anthropic.com/api/oauth/usage body — usagePoll.ts normalizes it
// into the client-facing AccountUsage. Never throws agent-side. See §14.58.
// `org_id` = the `anthropic-organization-id` response header (agent >= 0.22.0):
// the ACCOUNT identity behind the gauges. Absent on older agents and on every
// failure envelope (429s are edge-generated and carry no org id).
// `retry_after` = seconds, straight from the `Retry-After` header (>= 0.22.0).
export type AgentUsageResult =
  | { ok: true; subscription_type?: string | null; org_id?: string | null; fetched_at: number; usage: any }
  | { ok: false; error: string; status_code?: number; detail?: string; retry_after?: number; fetched_at: number };

export type AgentClientStatus =
  | 'idle'           // never connected
  | 'connecting'     // SSH in progress
  | 'connected'      // hello received, operational
  | 'reconnecting'   // drop detected, in backoff
  | 'closed';        // explicitly closed

// Error on the agent side: { code, message }
export class AgentRpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'AgentRpcError';
  }
}

// Codes aligned with protocol.py
export const ERR_SESSION_NOT_FOUND = -32000;
export const ERR_SDK_UNAVAILABLE = -32010;
