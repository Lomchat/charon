import 'server-only';
import { subscribeGlobalSessionEvents, type GlobalSessionEvent } from './sessionOps';

// eventConnections
// ─────────────────────────────────────────────────────────────────────────────
// Registry of multiplexed SSE connections (/api/claude/events). Each browser
// client opens ONE persistent SSE on mount, identified by a connId (UUID
// generated on the client side). The focus (sessionId currently being
// watched) is mutable via POST /api/claude/focus — no close/reopen on switch.
//
// Fan-out rules:
//   - "Low-volume" events (status, mode_changed, ready, session_id,
//     permission_request, user_question, exit_plan_request,
//     interaction_resolved, error) → forwarded to ALL connections
//     (for sidebar badges + cross-session permissions popup).
//   - "High-volume" events (assistant_text, thinking, tool_use, tool_result,
//     edit_snapshot, todo_update, user_echo, stop, prefill_input,
//     reconnecting) → forwarded ONLY to the connection that has the session
//     in focus. The client loads the history via GET in parallel.
//
// When a client switches focus:
//   1. Client POST /focus { conn, sessionId } → updates the focus
//   2. Client GET /api/claude/sessions/[id] → reloads the persisted history
//   3. SSE continues flowing — from now on the high-volume events of the
//      new session arrive

const LOW_VOLUME_EVENTS = new Set<string>([
  'status', 'mode_changed', 'ready', 'session_id',
  'permission_request', 'user_question', 'exit_plan_request',
  'interaction_resolved', 'error',
  // Rare-but-cross-tab events: a user can have the same session open in two
  // tabs (e.g. desktop + mobile/phone). All three should update the header
  // badge regardless of which tab is "focused" on the SSE multiplex.
  'model_changed', 'effort_changed', 'effective_model',
  // Shell live lifecycle status (sessionId = shellId, agent >= 0.9.0). Shells
  // are NOT the SSE's "focused session", so this must broadcast to every tab
  // to color the shell tabs/dots (blue "thinking" while busy). See
  // sessionOps.ts § emitGlobalShellStatus.
  'shell_status',
]);

function isLowVolume(type: string): boolean {
  return LOW_VOLUME_EVENTS.has(type);
}

type ConnState = {
  send: (ev: GlobalSessionEvent) => void;
  focus: string | null;
  unsubBus: (() => void) | null;
};

const gReg = globalThis as unknown as { _eventConnections?: Map<string, ConnState> };
if (!gReg._eventConnections) gReg._eventConnections = new Map();
const connections: Map<string, ConnState> = gReg._eventConnections;

/**
 * Register an SSE connection. Wires the connection to the global bus and
 * applies the focus filter. Returns an unregister function to call when
 * the SSE closes (req abort).
 */
export function registerConnection(opts: {
  connId: string;
  send: (ev: GlobalSessionEvent) => void;
  initialFocus?: string | null;
}): () => void {
  // If a connId already exists (e.g. client reconnected before we detected
  // the close), replace it cleanly.
  const existing = connections.get(opts.connId);
  if (existing?.unsubBus) existing.unsubBus();

  const conn: ConnState = {
    send: opts.send,
    focus: opts.initialFocus ?? null,
    unsubBus: null,
  };
  conn.unsubBus = subscribeGlobalSessionEvents((ev) => {
    if (isLowVolume(ev.type) || ev.sessionId === conn.focus) {
      try { conn.send(ev); } catch {}
    }
  });
  connections.set(opts.connId, conn);

  return () => {
    const c = connections.get(opts.connId);
    if (!c) return;
    if (c.unsubBus) c.unsubBus();
    connections.delete(opts.connId);
  };
}

/**
 * Change the focus of a connection. Returns true if found, false otherwise.
 * The SSE keeps flowing; starting with the next event, the filter uses
 * the new focus.
 */
export function setConnectionFocus(connId: string, sessionId: string | null): boolean {
  const conn = connections.get(connId);
  if (!conn) return false;
  conn.focus = sessionId;
  return true;
}

/**
 * Count the connections that have this session in focus. Used by the
 * "×N clients connected" badge shown in the sidebar/header.
 */
export function focusCountFor(sessionId: string): number {
  let n = 0;
  for (const c of connections.values()) if (c.focus === sessionId) n++;
  return n;
}
