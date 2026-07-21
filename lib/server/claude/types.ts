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
  | { type: 'todo_update'; todos: any[] }
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
  | { type: 'usage'; output_tokens: number; input_tokens?: number; cache_read_tokens?: number; final?: boolean; duration_ms?: number; cost_usd?: number | null }
  | { type: 'stop'; subtype?: string }
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
  subscriptionType?: string | null;  // 'max' | 'pro' | …
  error?: string | null;       // when !ok: 'no_credentials' | 'http_error' | 'request_failed'
  statusCode?: number | null;  // when error==='http_error' (401 stale token, 429 throttled)
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
  | { type: 'vps_status'; agentStatus: 'ok' | 'missing' | 'error'; agentVersion?: string | null; agentPyzSha?: string | null; sdkVersion?: string | null }
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
  // Account usage gauges fanned onto the global bus (sessionId = vpsId). Polled
  // from the agent's get_usage RPC by usagePoll.ts (60s + after each stop);
  // LOW_VOLUME → every tab. The header widget shows the CURRENT session's VPS
  // account. cf. CLAUDE.md §14.58.
  | ({ type: 'account_usage' } & AccountUsage);

export type WorkerEvent = BridgeEvent | SyntheticEvent;

export type WorkerStatus = 'starting' | 'active' | 'thinking' | 'sleeping' | 'killed' | 'error' | 'reconnecting';

export type PermissionMode = 'normal' | 'acceptEdits' | 'auto' | 'plan';

export type UserQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};
