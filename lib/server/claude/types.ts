// Events exchanged between the Python bridge and the SessionWorker (and to the
// SSE clients). We keep a wide TS union + guard helpers.

// One sub-agent inside a running Workflow-tool task (from the SDK's raw
// TaskProgressMessage.workflow_progress[]). Carried by bg_task_progress. §14.54.
export type BgAgentProgress = {
  index?: number | null;
  label?: string | null;
  state?: string | null;        // 'start' | 'done' | …
  model?: string | null;
  phaseTitle?: string | null;
  tokens?: number | null;
  toolCalls?: number | null;
  durationMs?: number | null;
  resultPreview?: string | null;
};

export type BridgeEvent =
  | { type: 'ready' }
  | { type: 'session_id'; id: string }
  | { type: 'assistant_text'; delta: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
  | { type: 'permission_request'; id: string; tool: string; input: any }
  | { type: 'user_question'; id: string; questions: UserQuestion[] }
  | { type: 'exit_plan_request'; id: string; plan: string }
  | { type: 'interaction_resolved'; kind: 'permission' | 'question' | 'exit_plan'; id: string }
  | { type: 'prefill_input'; content: string }
  | { type: 'reconnecting'; attempt: number; nextRetryIn: number; reason: string }
  | { type: 'edit_snapshot'; phase: 'before' | 'after'; tool_use_id: string; file_path: string; content: string | null; size: number; truncated: boolean }
  | { type: 'mode_changed'; mode: PermissionMode }
  // Per-session Claude model / effort changes (agent >= 0.5.0). Both carry
  // appliedAtNextStart so the UI can label the change as deferred: the SDK
  // client cannot swap model/effort mid-flight (bound at construction), so
  // the change takes effect on the next sleep+resume. null values mean
  // "cleared back to the global default".
  | { type: 'model_changed'; model: string | null; fallbackModel: string | null; appliedAtNextStart: boolean }
  | { type: 'effort_changed'; effort: EffortLevel | null; appliedAtNextStart: boolean }
  // effective_model = what Anthropic ACTUALLY billed for the last
  // AssistantMessage. Differs from `model` (= configured value) when the
  // user picked an alias, or when fallback_model kicked in. Emitted on
  // change only; persisted (claude_sessions.effective_model + per-row
  // claude_session_messages.model stamp, migration 0020).
  | { type: 'effective_model'; model: string }
  // bg_task = background-task lifecycle (agent >= 0.13.0, SDK Task*Message):
  // started / updated / finished. Drives the BgTasks bar above the chat
  // input. Persisted as a role='event' row; high-volume routing (focused conn).
  | {
      type: 'bg_task';
      kind: 'started' | 'updated' | 'finished';
      taskId: string;
      description?: string; toolUseId?: string; taskType?: string;
      status?: string; outputFile?: string; summary?: string;
      workflowName?: string;
      // agent >= 0.36.0: the SDK's own terminal verdict for this status word,
      // read from its exported TERMINAL_TASK_STATUSES. Outranks the hub's
      // word-list normaliser when present (§14.91).
      terminal?: boolean;
    }
  // bg_task_progress = transient (broadcast-only, focused conn) per-task
  // progress. `agents[]` = a Workflow run's per-sub-agent fan-out. Never
  // persisted; the client patches the live BgTasks registry in place. §14.54.
  | {
      type: 'bg_task_progress';
      taskId: string;
      description?: string; lastToolName?: string; workflowName?: string;
      usage?: { tokens?: number | null; tool_uses?: number | null; duration_ms?: number | null };
      agents?: BgAgentProgress[];
      phases?: Array<{ index?: number | null; title?: string | null }>;
    }
  // usage = live token counter for the current turn (§14.50). Transient
  // (broadcast-only, high-volume → focused conn). `final:true` = turn totals
  // (duration_ms, cost_usd from the ResultMessage).
  // `tree` (agent >= 0.36.0) is the whole-tree total from model_usage —
  // subagents included. The flat fields count the main thread only, which
  // under-reports every ultracode/Workflow session.
  | {
      type: 'usage'; output_tokens: number; input_tokens?: number;
      cache_read_tokens?: number; cache_write_tokens?: number;
      final?: boolean; duration_ms?: number; cost_usd?: number | null;
      tree?: {
        input_tokens: number; output_tokens: number;
        cache_read_tokens: number; cache_write_tokens: number;
        cost_usd: number | null; models: string[];
      };
    }
  | { type: 'stop'; subtype?: string }
  // compaction (agent >= 0.36.0) = the CLI replaced the conversation with a
  // summary. Charon's own rows are untouched, so this marks a boundary rather
  // than a loss: above it is still readable, but the model no longer remembers
  // it. Persisted as a role='event' row so it keeps its place after a refetch.
  | { type: 'compaction'; trigger?: string; preTokens?: number; postTokens?: number }
  // session_info (agent >= 0.36.0) = the CLI's init frame. `capabilities` is
  // the sanctioned feature-detection channel (CLI >= 2.1.205). Broadcast-only:
  // it describes the running CLI process, so it must not outlive it.
  | {
      type: 'session_info';
      capabilities?: string[]; slashCommands?: string[]; tools?: string[];
      plugins?: string[]; modelEfforts?: Record<string, string[]>;
      models?: Array<{
        id: string; resolved?: string; label?: string; hint?: string;
        efforts?: string[]; supports_effort?: boolean;
        supports_adaptive_thinking?: boolean;
      }>;
    }
  // rate_limit (agent >= 0.37.0) — "am I limited right now / when does the
  // window reset", free off the stream. NOT a replacement for the usage poll:
  // `utilization` is null on subscription accounts (§14.72 stays).
  | {
      type: 'rate_limit'; status?: string; window?: string;
      resets_at?: number; utilization?: number; overage_status?: string;
    }
  // external_message (agent >= 0.36.0) = a turn driven by ANOTHER agent
  // (origin 'peer' | 'coordinator'). It arrives as plain-string user content,
  // which the tool-result path drops — so without this the session visibly
  // acts on nothing.
  | { type: 'external_message'; origin: string; text: string; from?: string }
  // turn_error (agent >= 0.36.0) = typed turn failure off AssistantMessage
  // .error (authentication_failed, billing_error, …). The same fact §14.65
  // infers by regexing prose; layered over it, not replacing it.
  | { type: 'turn_error'; kind: string }
  | { type: 'error'; msg: string; fatal?: boolean };

// Mirror of claude_agent_sdk.EffortLevel. Re-exported from
// lib/server/agent/types.ts as the source of truth for the protocol layer;
// duplicated here as a local alias to avoid a circular import (this file
// is imported by sessionOps.ts which itself imports from agent/types.ts).
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';

// ── Account usage (the `/usage` gauges) ─────────────────────────────────────
// Normalized shape of api.anthropic.com/api/oauth/usage, polled per-VPS from
// the agent's get_usage RPC (usagePoll.ts) and fanned onto the global bus as an
// `account_usage` synthetic event (sessionId = vpsId). ACCOUNT-scoped. §14.58.
export type AccountUsageWindow = {
  utilization: number | null;  // percent 0–100 (null = unknown / no active window)
  resetsAt: string | null;     // ISO 8601, or null when the window is idle
};
export type AccountUsageLimit = {
  kind: string;                // 'session' | 'weekly_all' | 'weekly_scoped' | …
  group?: string | null;       // 'weekly' | 'session' | …
  percent: number;             // 0–100
  severity: string;            // 'normal' | 'warning' | 'critical' | …
  resetsAt?: string | null;
  scopeModel?: string | null;  // scope.model.display_name (e.g. 'Fable'), else null
  isActive?: boolean;
};
export type AccountUsage = {
  ok: boolean;
  fetchedAt: number;           // hub Date.now() (ms) — for "updated Ns ago"
  // Which coding-agent account these gauges belong to. 'claude' (default when
  // absent) reads api.anthropic.com/api/oauth/usage; 'codex' reads the Codex
  // app-server rate limits (get_codex_usage). A VPS can have BOTH — the header
  // shows the one matching the CURRENT session's kind. cf. CLAUDE.md §14.59.
  provider?: 'claude' | 'codex';
  subscriptionType?: string | null;  // 'max' | 'pro' | …
  error?: string | null;       // when !ok: 'no_credentials' | 'http_error' | 'request_failed'
  statusCode?: number | null;  // when error==='http_error' (401 stale token, 429 throttled)
  // Anthropic org id behind these gauges (agent >= 0.22.0). The hub groups
  // VPSes by it and polls ONE per account — usage is account-scoped, so N
  // VPSes on one account return identical numbers. cf. CLAUDE.md §14.72.
  orgId?: string | null;
  // Set on an OK snapshot when the LATEST refresh attempt failed: the gauges
  // below are real but no longer fresh. The widget keeps rendering them (with
  // the "updated Nm ago" age) and mentions the reason — blanking working
  // numbers on a transient 429 is what read as "usage is broken". §14.72.
  degraded?: { reason: string; statusCode?: number | null; retryAt?: number | null } | null;
  fiveHour?: AccountUsageWindow | null;
  sevenDay?: AccountUsageWindow | null;
  limits?: AccountUsageLimit[] | null;
  extraUsage?: { isEnabled?: boolean; utilization?: number | null } | null;
};

// Synthetic events that the worker fabricates itself (not received from the bridge).
export type SyntheticEvent =
  | { type: 'status'; status: WorkerStatus }
  | { type: 'user_echo'; content: string; createdAt: number }
  | { type: 'history_begin' }
  | { type: 'history_end' }
  // Shell lifecycle status fanned onto the global SSE bus (sessionId = shellId).
  // 'busy' = streaming output → the UI's blue "thinking" tab; 'active' =
  // idle/at-prompt; 'exited' = bash ended. Fed by the persistent AgentClient's
  // shell_watch via shellNotify → emitGlobalShellStatus (agent >= 0.9.0).
  // Classed LOW_VOLUME in eventConnections so it reaches every tab (shells are
  // not focus-tracked on the SSE). Not a real Claude-session event — it just
  // reuses the GlobalSessionEvent pipe with the shell id as sessionId.
  | { type: 'shell_status'; status: 'active' | 'busy' | 'exited' }
  // Live agentStatus push (sessionId = vpsId). Mirrors every DB persist of
  // `vps.agentStatus` inside AgentClient (hello success / classified exit) so
  // the sidebar badge + action buttons follow reality without an F5. Same
  // bus-reuse trick as shell_status; LOW_VOLUME → broadcast to every tab.
  | { type: 'vps_status'; agentStatus: 'ok' | 'missing' | 'error'; agentVersion?: string | null; agentPyzSha?: string | null; sdkVersion?: string | null;
      // Classified failure ('ssh-auth: …' | 'ssh-unreachable: …' | 'daemon-down: …'
      // | 'error: …', null = cleared) + codex availability — feed the per-VPS
      // health chips (app/vpsHealth.tsx). Keys present only when known
      // (no-clobber contract, mirrors sdkVersion).
      agentLastError?: string | null; codexAvailable?: number | null; codexSdkVersion?: string | null;
      // Set by the codex device-code login route on completion (§14.61) and by
      // the claude device-code login session on success (§14.64).
      codexLoggedIn?: number | null; claudeLoggedIn?: number | null }
  // Per-session "finished, unread" marker fanned onto the global SSE bus
  // (sessionId = the Claude session id). unread=true when a turn finished
  // (`stop`) while nobody was viewing the session; unread=false when the user
  // opens/focuses it (POST /focus → markSessionRead). Lets the sidebar's green
  // "finished" glow appear live across tabs/devices and clear on read. Source
  // of truth is claudeSessions.unreadStop; this event is just the live mirror.
  // Classed LOW_VOLUME in eventConnections so it reaches every tab regardless
  // of SSE focus. cf. CLAUDE.md §14.47.
  | { type: 'session_unread'; unread: boolean }
  // The set of Claude sessions changed (one was created, imported or deleted).
  // A pure "refetch the list" signal so the sidebar/tab bar update live across
  // tabs AND devices — e.g. a session started on a phone appears on the desktop
  // without waiting for the 15s poll (or an F5). `sessionId` is the affected
  // session id (informational only; the client just refetches GET
  // /api/claude/sessions). Charon-internal synthetic event (no JSON-RPC / pyz
  // change), classed LOW_VOLUME so it reaches every tab. cf. CLAUDE.md §14.52.
  | { type: 'session_list_changed' }
  // The workspace layout changed (a tab opened / closed / pinned / activated).
  // LOW_VOLUME: tabs are shared across devices, so every connection needs it
  // regardless of which session it is focused on. §14.78.
  | { type: 'tabs_changed' }
  // Account usage gauges fanned onto the global bus (sessionId = vpsId). Polled
  // from the agent's get_usage RPC by usagePoll.ts (60s + after each stop);
  // LOW_VOLUME → every tab. The header widget shows the CURRENT session's VPS
  // account. cf. CLAUDE.md §14.58.
  | ({ type: 'account_usage' } & AccountUsage);

export type WorkerEvent = BridgeEvent | SyntheticEvent;

// `failed` is connected/idle: the last Claude turn ended in a synthetic
// API/auth error, but the SDK session is still alive and accepts input.
// `error` is reserved for an actually broken/stopped SDK session.
// `background` is idle-but-not-done: the turn ended, yet background tasks it
// launched are still running, so the session is neither working nor finished
// (§14.91). Hub-only, like `failed` — the daemon never emits either.
export type WorkerStatus =
  | 'starting' | 'active' | 'thinking' | 'failed' | 'background'
  | 'sleeping' | 'killed' | 'error' | 'reconnecting';

export type PermissionMode = 'normal' | 'acceptEdits' | 'auto' | 'plan';

export type UserQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};
