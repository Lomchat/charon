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
  // Installed `claude-agent-sdk` version in the VPS venv (>= 0.12.0 agents).
  // Absent on older agents — persist ONLY when !== undefined so an old
  // agent's hello never null-clobbers a value written by the update flow.
  sdk_version?: string | null;
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
    }
  // usage (agent >= 0.11.0): live token counter for the CURRENT turn, emitted
  // broadcast-only (transient, no seq) and throttled (~0.6s). `final:true`
  // carries the turn totals (duration_ms, cost_usd) from the ResultMessage. §14.50.
  | { event: 'usage'; session_id: string; output_tokens: number; input_tokens?: number; cache_read_tokens?: number; final?: boolean; duration_ms?: number; cost_usd?: number | null }
  | { event: 'interrupted'; session_id: string; forced?: boolean }
  | { event: 'stop'; session_id: string; subtype?: string }
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
