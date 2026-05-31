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
  | { type: 'history_end' };

export type WorkerEvent = BridgeEvent | SyntheticEvent;

export type WorkerStatus = 'starting' | 'active' | 'thinking' | 'sleeping' | 'killed' | 'error' | 'reconnecting';

export type PermissionMode = 'normal' | 'acceptEdits' | 'auto' | 'plan';

export type UserQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};
