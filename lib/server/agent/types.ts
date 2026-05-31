// TypeScript mirror of the agent's JSON-RPC protocol (agent/charon_agent/protocol.py).
// Events are aligned with lib/server/claude/types.ts (BridgeEvent) — the wire
// type differs slightly: we have an "event" string instead of a "type".

export type PermissionMode = 'normal' | 'acceptEdits' | 'auto' | 'plan';

// Mirrors claude_agent_sdk.EffortLevel literal. Newer SDK versions may add
// values; if so, also extend this union (the agent silently drops unknown
// effort values, so adding new ones here without bumping the agent is safe).
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AgentSessionStatus =
  | 'starting'
  | 'active'
  | 'thinking'
  | 'sleeping'
  | 'killed'
  | 'error';

export type AgentSessionInfo = {
  session_id: string;
  claude_session_id: string | null;
  cwd: string;
  name: string | null;
  permission_mode: PermissionMode;
  status: AgentSessionStatus;
  // Optional because agents < 0.5.0 don't emit these fields. null/undefined
  // both mean "use the default" (global setting → SDK default).
  model?: string | null;
  fallback_model?: string | null;
  effort?: EffortLevel | null;
};

export type AgentHelloResult = {
  agent_version: string;
  // SHA256 (first 12 chars) of the .pyz that is running. Compared to the sha
  // of the pyz embedded in the dashboard to detect "agent out of date".
  // Optional because older agents (<0.2.0) don't return it.
  agent_pyz_sha?: string;
  sdk_available: boolean;
  sdk_error: string | null;
  pid: number;
  sessions: AgentSessionInfo[];
};

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
  | { event: 'status'; session_id: string; status: AgentSessionStatus }
  | { event: 'ready'; session_id: string }
  | { event: 'session_id'; session_id: string; claude_session_id: string }
  | { event: 'assistant_text'; session_id: string; delta: string }
  | { event: 'thinking'; session_id: string; text: string }
  | { event: 'tool_use'; session_id: string; id: string; name: string; input: any }
  | { event: 'tool_result'; session_id: string; tool_use_id: string; content: string; is_error: boolean }
  | { event: 'permission_request'; session_id: string; id: string; tool: string; input: any }
  | { event: 'user_question'; session_id: string; id: string; questions: any[] }
  | { event: 'exit_plan_request'; session_id: string; id: string; plan: string }
  | { event: 'todo_update'; session_id: string; todos: any[] }
  | { event: 'edit_snapshot'; session_id: string; phase: 'before' | 'after'; tool_use_id: string; file_path: string; content: string | null; size: number; truncated: boolean }
  | { event: 'mode_changed'; session_id: string; mode: PermissionMode }
  // model_changed / effort_changed: emitted by agent >= 0.5.0 when set_model
  // or set_effort is invoked. applied_at_next_start is true when the SDK
  // client is currently running (= the change takes effect on next sleep/resume),
  // false when there's no live client (= takes effect on the next start).
  // null fields mean "cleared back to default".
  | { event: 'model_changed'; session_id: string; model: string | null; fallback_model: string | null; applied_at_next_start?: boolean }
  | { event: 'effort_changed'; session_id: string; effort: EffortLevel | null; applied_at_next_start?: boolean }
  | { event: 'interrupted'; session_id: string; forced?: boolean }
  | { event: 'stop'; session_id: string; subtype?: string }
  | { event: 'error'; session_id: string; msg: string; fatal?: boolean }
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
  | 'start_session'
  | 'resume_session'
  | 'subscribe'
  | 'unsubscribe'
  | 'send_input'
  | 'interrupt'
  | 'force_stop'
  | 'set_permission_mode'
  | 'set_model'
  | 'set_effort'
  | 'respond_permission'
  | 'respond_question'
  | 'respond_exit_plan'
  | 'sleep_session'
  | 'kill_session';

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
