import 'server-only';
import { subscribeGlobalSessionEvents, setSessionFocusChecker, type GlobalSessionEvent } from './sessionOps';

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
  // Live VPS agent-status flips (sessionId = vpsId) — sidebar badges on every
  // tab. See sessionOps.ts § emitGlobalVpsStatus.
  'vps_status',
  // Per-session "finished, unread" marker flips (sessionId = session id). Must
  // reach EVERY tab regardless of SSE focus: the whole point is to light up a
  // BACKGROUND (non-focused) session's sidebar card the moment it finishes.
  // See sessionOps.ts § markSessionRead / stop handler (CLAUDE.md §14.47).
  'session_unread',
  // The Claude session SET changed (created / imported / deleted). A pure
  // "refetch the list" ping → must reach EVERY tab so the sidebar updates live
  // across tabs AND devices (a session started on a phone shows on the desktop
  // without an F5). See sessionOps.ts § emitGlobalSessionListChanged (§14.52).
  'session_list_changed',
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

// "Recently viewed" grace for the finished-unread marker (CLAUDE.md §14.47).
// `focusCountFor` is instantaneous: the moment a user navigates away from a
// session its focus count drops to 0. But an agent's turn frequently finishes a
// second or two AFTER the user switches (or steps back to the session list), so
// the `stop` would land with nobody "focused" and wrongly flip the session the
// user was just reading to green "unread". We therefore remember the last time
// each session had/lost focus and treat a finish within RECENT_VIEW_GRACE_MS as
// "still being viewed". Covers the switch-away race + brief SSE-reconnect gaps.
const RECENT_VIEW_GRACE_MS = 12_000;
const gView = globalThis as unknown as { _lastViewAt?: Map<string, number> };
if (!gView._lastViewAt) gView._lastViewAt = new Map();
const lastViewAt: Map<string, number> = gView._lastViewAt;

function touchView(sessionId: string | null | undefined): void {
  if (sessionId) lastViewAt.set(sessionId, Date.now());
}

/**
 * "Is this session being viewed, or was it within the last few seconds?" Used
 * by the stop handler to decide whether to light the finished-unread marker.
 */
export function wasRecentlyViewed(sessionId: string): boolean {
  if (focusCountFor(sessionId) > 0) return true;
  const t = lastViewAt.get(sessionId);
  return t != null && Date.now() - t < RECENT_VIEW_GRACE_MS;
}

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
    // Tab closed / SSE dropped while focused → remember we were just viewing it,
    // so a finish during the gap doesn't immediately mark it unread (§14.47).
    touchView(c.focus);
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
  // Stamp BOTH the session being left and the one being entered as "viewed just
  // now", so the recently-viewed grace covers a turn that finishes immediately
  // after a switch (the user was reading it a moment ago). cf. CLAUDE.md §14.47.
  touchView(conn.focus);
  conn.focus = sessionId;
  touchView(sessionId);
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

// Wire the "is this session currently being viewed (or was, a few seconds
// ago)?" check into sessionOps so its `stop` handler can decide whether to
// light the "finished, unread" marker (a finish the user is already watching —
// or just navigated away from — shouldn't mark itself unread). Reverse of the
// setVpsStatusEmitter injection — keeps the dependency one-directional at
// module-eval time while letting sessionOps query focus at runtime. The grace
// window (wasRecentlyViewed) is what fixes the switch-away race. cf. §14.47.
setSessionFocusChecker((sessionId) => wasRecentlyViewed(sessionId));
