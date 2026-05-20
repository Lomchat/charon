'use client';
import type { WorkerEvent } from '@/lib/server/claude/types';
import type { InstallStatus } from '@/lib/types/api';

// globalEventStream
// ─────────────────────────────────────────────────────────────────────────────
// Singleton client: ONE single EventSource on /api/claude/events for the
// entire browser. The hooks (`useClaudeSessionStream`, `useCrossSessionInteractionFeed`,
// `useInstallNotifications`) subscribe to this module instead of opening
// their own SSE.
//
// Why a singleton:
//   - Avoids HTTP/1.1 saturation (6 connections max per origin on the
//     Apache front, cf. CLAUDE.md §14 gotcha 15).
//   - Zero session-switch latency: a POST /focus is enough, the SSE
//     stays open.
//   - A single connection to manage for reconnect/health.
//
// The server SSE multiplexes 2 sources:
//   - Session bus (`sessionOps.ts § subscribeGlobalSessionEvents`)
//   - Install bus (`installSession.ts § subscribeInstallBus`) — for the
//     install_started / install_finished notifications
// Install events do NOT have a `sessionId`; they are distinguished by their
// `type` (`install_started` / `install_finished`).

export type InstallBusClientEvent =
  | { type: 'install_started'; installId: string; vpsId: string; vpsName: string; status: InstallStatus }
  | { type: 'install_finished'; installId: string; vpsId: string; vpsName: string; status: InstallStatus };

export type SessionBusClientEvent = WorkerEvent & { sessionId: string };

export type GlobalEvent = SessionBusClientEvent | InstallBusClientEvent;

function hasSessionId(ev: GlobalEvent): ev is SessionBusClientEvent {
  return 'sessionId' in ev && typeof (ev as any).sessionId === 'string';
}

// Two flavors of listener: `SessionListener` for per-sessionId subscriptions
// (which only receive sessionId-tagged events), and `GlobalListener` for
// catch-all listeners that also receive install events. We split them so
// that per-session callers (typically `useClaudeSessionStream`) can be
// written with a callback typed `(ev: WorkerEvent & {sessionId: string}) => void`
// without casts.
type SessionListener = (ev: SessionBusClientEvent) => void;
type GlobalListener = (ev: GlobalEvent) => void;

// Stable connId for the duration of the tab. If we lose the connection and
// reconnect with the same connId, the server cleanly replaces the existing
// conn (cf. eventConnections.ts § registerConnection).
function genConnId(): string {
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
    return (crypto as any).randomUUID();
  }
  return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

let connId: string | null = null;
let es: EventSource | null = null;
let currentFocus: string | null = null;
// `null` key = catch-all listeners (which want all events from all
// sessions, e.g. useCrossSessionInteractionFeed). Stored as a Set of
// the widest possible function type (GlobalListener); for per-sessionId
// subscriptions, the callbacks are contravariantly compatible because
// they will only ever receive SessionBusClientEvent values.
const listeners = new Map<string | null, Set<GlobalListener>>();
let pendingFocusPost: Promise<void> | null = null;

// EventSource reconnect detection: `openCount` starts at 0, becomes 1 on
// the 1st connection (boot), then ≥2 on each browser auto-reconnect after
// a drop (e.g. backend restarted). We notify consumers so they refetch
// history missed during the gap — the SSE itself only replays live events
// + a status snapshot, not persisted messages.
let openCount = 0;
const reconnectListeners = new Set<() => void>();

function getConnId(): string {
  if (!connId) connId = genConnId();
  return connId;
}

function ensureStream(): void {
  if (es) return;
  if (typeof window === 'undefined') return; // SSR guard
  const id = getConnId();
  const url = `/api/claude/events?conn=${encodeURIComponent(id)}`
    + (currentFocus ? `&focus=${encodeURIComponent(currentFocus)}` : '');
  es = new EventSource(url);
  es.onmessage = (e) => {
    let ev: GlobalEvent;
    try { ev = JSON.parse(e.data); } catch { return; }
    // Fan out to this session's listeners (except install events, which have none)
    // + to the catch-alls (which receive everything, including installs).
    if (hasSessionId(ev)) {
      const perSession = listeners.get(ev.sessionId);
      if (perSession) for (const cb of perSession) {
        try { cb(ev); } catch {}
      }
    }
    const all = listeners.get(null);
    if (all) for (const cb of all) {
      try { cb(ev); } catch {}
    }
  };
  es.onopen = () => {
    openCount++;
    if (openCount <= 1) return;  // 1st open (boot): not a reconnect
    // On each reconnect (≥ 2nd open), two things to do:
    //
    // 1) Re-POST focus to the server. The browser's auto-reconnect reopens
    //    the ORIGINAL URL — so the ?focus= in the URL is the one at the
    //    time the EventSource was created. If the user switched sessions
    //    in the meantime (via setFocus), the server falls back to the
    //    wrong focus without this re-POST, and high-volume events for the
    //    current session are not streamed.
    //
    // 2) Notify consumers (e.g. useClaudeSessionStream) so they refetch
    //    history: during the SSE gap, Charon may have persisted messages
    //    that the SSE didn't relay (it is live-only on the Charon side —
    //    no ring buffer, cf. CLAUDE.md §14 gotcha 14). Without this
    //    refetch, the UI stays frozen on the last pre-drop state.
    const id = getConnId();
    if (currentFocus) {
      fetch('/api/claude/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conn: id, sessionId: currentFocus }),
      }).catch(() => {});
    }
    for (const cb of reconnectListeners) {
      try { cb(); } catch {}
    }
  };

  // onerror: EventSource handles reconnection itself. We don't log to
  // avoid console noise on every missed heartbeat.
}

/**
 * Subscribe a listener that fires on each SSE reconnect (NOT on the 1st open).
 * Useful for refetching history missed during the drop. Returns an
 * unsubscribe function.
 */
export function subscribeReconnect(cb: () => void): () => void {
  reconnectListeners.add(cb);
  return () => { reconnectListeners.delete(cb); };
}

/**
 * Subscribe a listener to ALL events for a given session. Returns an
 * unsubscribe function. Lazily opens the SSE if not already done.
 */
export function subscribeSession(sessionId: string, cb: SessionListener): () => void {
  ensureStream();
  let set = listeners.get(sessionId);
  if (!set) { set = new Set(); listeners.set(sessionId, set); }
  // The store is typed `GlobalListener` but we only dispatch
  // SessionBusClientEvent into this bucket (cf. `hasSessionId(ev)` above),
  // so the cast is safe.
  set.add(cb as GlobalListener);
  return () => {
    const s = listeners.get(sessionId);
    if (!s) return;
    s.delete(cb as GlobalListener);
    if (s.size === 0) listeners.delete(sessionId);
  };
}

/**
 * Subscribe a listener to ALL events from ALL sessions. Used by
 * useCrossSessionInteractionFeed for the cross-session popups.
 */
export function subscribeAll(cb: GlobalListener): () => void {
  ensureStream();
  let set = listeners.get(null);
  if (!set) { set = new Set(); listeners.set(null, set); }
  set.add(cb);
  return () => {
    const s = listeners.get(null);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) listeners.delete(null);
  };
}

/**
 * Change the focus session on the server. The server will start streaming
 * high-volume events (assistant_text, tool_use, etc.) for this session
 * without closing/reopening the SSE.
 *
 * If `sessionId` matches the current focus, no-op.
 *
 * Idempotent: if several setFocus calls fire at the same time (rapid
 * navigation), the last one wins; we coalesce via `pendingFocusPost`.
 */
export async function setFocus(sessionId: string | null): Promise<void> {
  ensureStream();
  if (currentFocus === sessionId) return;
  currentFocus = sessionId;
  // POST /focus — we coalesce but still attempt in case of retry.
  const id = getConnId();
  const post = fetch('/api/claude/focus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conn: id, sessionId }),
  }).then(() => {}).catch(() => {});
  pendingFocusPost = post;
  await post;
  if (pendingFocusPost === post) pendingFocusPost = null;
}

/**
 * For debug / introspection.
 */
export function getCurrentFocus(): string | null {
  return currentFocus;
}
