// Événements échangés entre le bridge Python et le SessionWorker (et vers les
// clients SSE). On garde une union TS large + des helpers de garde.

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
  | { type: 'stop'; subtype?: string }
  | { type: 'error'; msg: string; fatal?: boolean };

// Événements synthétiques que le worker fabrique lui-même (pas reçus du bridge).
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
