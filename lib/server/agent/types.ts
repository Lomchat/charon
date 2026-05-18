// Mirroir TypeScript du protocole JSON-RPC de l'agent (agent/charon_agent/protocol.py).
// Les events sont alignés avec lib/server/claude/types.ts (BridgeEvent) — le
// type wire diffère légèrement : on a un "event" string au lieu d'un "type".

export type PermissionMode = 'normal' | 'acceptEdits' | 'bypass' | 'plan';

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
};

export type AgentHelloResult = {
  agent_version: string;
  sdk_available: boolean;
  sdk_error: string | null;
  pid: number;
  sessions: AgentSessionInfo[];
};

// Events poussés par l'agent. session_id obligatoire pour tous sauf erreurs
// globales (rare). On garde une union large pour ne pas se mentir.
export type AgentEvent =
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
  | { event: 'interrupted'; session_id: string }
  | { event: 'stop'; session_id: string; subtype?: string }
  | { event: 'error'; session_id: string; msg: string; fatal?: boolean };

export type AgentClientStatus =
  | 'idle'           // jamais connecté
  | 'connecting'     // SSH en cours
  | 'connected'      // hello reçu, opérationnel
  | 'reconnecting'   // drop détecté, en backoff
  | 'closed';        // fermé explicitement

// Erreur côté agent : { code, message }
export class AgentRpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'AgentRpcError';
  }
}

// Codes alignés avec protocol.py
export const ERR_SESSION_NOT_FOUND = -32000;
export const ERR_SDK_UNAVAILABLE = -32010;
