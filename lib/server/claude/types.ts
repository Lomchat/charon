// Events exchanged between the Python bridge and the SessionWorker (and to the
// SSE clients). We keep a wide TS union + guard helpers.

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
  // user picked an alias, or when fallback_model kicked in. Transient
  // runtime info — no DB persistence. Emitted on change only.
  | { type: 'effective_model'; model: string }
  | { type: 'stop'; subtype?: string }
  | { type: 'error'; msg: string; fatal?: boolean };

// Mirror of claude_agent_sdk.EffortLevel. Re-exported from
// lib/server/agent/types.ts as the source of truth for the protocol layer;
// duplicated here as a local alias to avoid a circular import (this file
// is imported by sessionOps.ts which itself imports from agent/types.ts).
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  | { type: 'vps_status'; agentStatus: 'ok' | 'missing' | 'error'; agentVersion?: string | null; agentPyzSha?: string | null }
  // Per-session "finished, unread" marker fanned onto the global SSE bus
  // (sessionId = the Claude session id). unread=true when a turn finished
  // (`stop`) while nobody was viewing the session; unread=false when the user
  // opens/focuses it (POST /focus → markSessionRead). Lets the sidebar's green
  // "finished" glow appear live across tabs/devices and clear on read. Source
  // of truth is claudeSessions.unreadStop; this event is just the live mirror.
  // Classed LOW_VOLUME in eventConnections so it reaches every tab regardless
  // of SSE focus. cf. CLAUDE.md §14.47.
  | { type: 'session_unread'; unread: boolean };

export type WorkerEvent = BridgeEvent | SyntheticEvent;

export type WorkerStatus = 'starting' | 'active' | 'thinking' | 'sleeping' | 'killed' | 'error' | 'reconnecting';

export type PermissionMode = 'normal' | 'acceptEdits' | 'auto' | 'plan';

export type UserQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};
