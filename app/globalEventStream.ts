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
//
// ─── Robust reconnection (CLAUDE.md §14 gotcha 24, completed) ─────────────
// The built-in EventSource auto-reconnect is unreliable: per the WHATWG
// spec, when the server responds with a non-200 status (typical: Apache
// returns 502 while Charon is restarting), the browser sets
// `readyState=CLOSED` and *never* reconnects on its own. Symptom: chat
// frozen until F5 after `systemctl restart charon`.
//
// We layer two safety nets on top of the browser's behavior:
//
//   1. `onerror` watcher: when `readyState === CLOSED`, we explicitly
//      tear down the dead EventSource and schedule a manual reconnect
//      with exponential backoff (1s → 2 → 4 → 8 → 15 → 30, capped).
//      Reset to 1s on the next successful `onopen`.
//   2. Liveness watchdog: server now sends a typed `heartbeat` data event
//      every 10s (instead of an SSE comment, which EventSource hides from
//      JS). We track `lastActivityTs` and, if no event arrives for 30s,
//      we force a manual reconnect even if `readyState` still claims OPEN
//      (handles silent stalls — TCP alive but proxy buffering, NAT
//      timeout, etc.).
//
// We also nudge reconnection on `online` and `visibilitychange` so the
// user immediately resyncs when their laptop wakes / Wi-Fi returns.

export type InstallBusClientEvent =
  | { type: 'install_started'; installId: string; vpsId: string; vpsName: string; status: InstallStatus }
  | { type: 'install_finished'; installId: string; vpsId: string; vpsName: string; status: InstallStatus };

export type SessionBusClientEvent = WorkerEvent & { sessionId: string };

// Server-sent liveness ping. Not surfaced to listeners — it's eaten by
// the dispatcher (we only use it to bump `lastActivityTs`).
type HeartbeatEvent = { type: 'heartbeat'; ts: number };

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

// ── Robust reconnection state ──────────────────────────────────────────
// Timestamp (ms, Date.now()) of the last event received from the server,
// including heartbeats. We assume a dead connection if this is > STALE_MS
// behind the current time. 0 = no event ever received (initial state).
let lastActivityTs = 0;
// Pending reconnect timer (setTimeout). null when no retry is pending.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Current backoff delay in ms. Reset to MIN_BACKOFF_MS on each successful
// onopen, doubled on each failure, clamped to MAX_BACKOFF_MS.
let backoffMs = 0;
// Watchdog interval id (checks lastActivityTs periodically). null when not
// armed (e.g. tab in background — we suspend the watchdog to save battery).
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
// Already wired window-level listeners? We wire them once per page load,
// but ensureStream() may be called many times during a session.
let windowListenersAttached = false;

const MIN_BACKOFF_MS = 1_000;       // first retry after 1s
const MAX_BACKOFF_MS = 15_000;      // cap retries at 15s spacing (lowered:
                                    // a typical `systemctl restart charon`
                                    // takes 3-6s, capping at 15s means we
                                    // resync within 15s of recovery in the
                                    // worst case rather than 30s)
const STALE_MS = 20_000;            // no event for 20s → assume dead. Lower
                                    // than 30s so we catch silent stalls
                                    // before the user notices. Still > 2x
                                    // the 8s heartbeat interval so a single
                                    // missed beat does NOT trigger a
                                    // reconnect.
const WATCHDOG_TICK_MS = 4_000;     // check liveness every 4s

function getConnId(): string {
  if (!connId) connId = genConnId();
  return connId;
}

function buildUrl(): string {
  const id = getConnId();
  return `/api/claude/events?conn=${encodeURIComponent(id)}`
    + (currentFocus ? `&focus=${encodeURIComponent(currentFocus)}` : '');
}

function clearReconnectTimer(): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function teardownStream(): void {
  if (es) {
    try { es.onmessage = null; } catch {}
    try { es.onopen = null; } catch {}
    try { es.onerror = null; } catch {}
    try { es.close(); } catch {}
    es = null;
  }
}

function scheduleReconnect(reason: string): void {
  if (typeof window === 'undefined') return;
  // Don't pile up retries: if one is already queued, leave it alone.
  if (reconnectTimer != null) return;
  // Bump backoff for next failure; first retry after a fresh OPEN uses
  // MIN_BACKOFF_MS.
  if (backoffMs <= 0) backoffMs = MIN_BACKOFF_MS;
  else backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  const delay = backoffMs;
  // eslint-disable-next-line no-console
  if (typeof console !== 'undefined') {
    // Quiet by default but very useful when debugging "stuck after restart"
    // reports — keep it; it's one log per failed retry, not per missed beat.
    console.info(`[charon] SSE reconnect in ${delay}ms (${reason})`);
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    teardownStream();
    openStream();
  }, delay);
}

function reconnectNow(reason: string): void {
  clearReconnectTimer();
  teardownStream();
  // Reset backoff so the immediate attempt isn't delayed by past failures.
  // If THIS attempt also fails, onerror will re-arm the backoff sequence.
  backoffMs = 0;
  // eslint-disable-next-line no-console
  if (typeof console !== 'undefined') console.info(`[charon] SSE reconnect now (${reason})`);
  openStream();
}

function startWatchdog(): void {
  if (watchdogTimer != null) return;
  watchdogTimer = setInterval(() => {
    if (!es) return;
    if (lastActivityTs === 0) return; // never received anything yet — onopen/onerror handles it
    const age = Date.now() - lastActivityTs;
    if (age > STALE_MS) {
      // No heartbeat or event for > 30s — assume the proxy or upstream is
      // silently dead. The browser still thinks the connection is OPEN, so
      // it won't reconnect on its own. We force it.
      lastActivityTs = 0; // avoid triggering twice
      scheduleReconnect(`stale ${Math.round(age / 1000)}s`);
    }
  }, WATCHDOG_TICK_MS);
}

function stopWatchdog(): void {
  if (watchdogTimer != null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function attachWindowListeners(): void {
  if (windowListenersAttached) return;
  if (typeof window === 'undefined') return;
  windowListenersAttached = true;

  // Browser came back online → most likely the prior connection died.
  // Kick a reconnect attempt immediately rather than wait for backoff.
  window.addEventListener('online', () => {
    if (!es || es.readyState === 2 /* CLOSED */) {
      reconnectNow('online event');
    } else {
      // Even if readyState says OPEN, force a freshness check soon.
      lastActivityTs = Math.min(lastActivityTs, Date.now() - STALE_MS + 2_000);
    }
  });

  // Tab back in foreground → make sure we have a live stream. If the OS
  // suspended the page (battery saver, laptop sleep), the EventSource may
  // be silently dead.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!es || es.readyState === 2 /* CLOSED */) {
      reconnectNow('tab visible & ES closed');
      return;
    }
    // If we haven't heard from the server in a while, force a reconnect
    // even if the browser thinks the connection is OPEN.
    const age = lastActivityTs ? Date.now() - lastActivityTs : Infinity;
    if (age > STALE_MS) {
      reconnectNow(`tab visible & stale ${Math.round(age / 1000)}s`);
    }
  });
}

function openStream(): void {
  if (es) return;
  if (typeof window === 'undefined') return; // SSR guard
  attachWindowListeners();
  startWatchdog();

  const url = buildUrl();
  es = new EventSource(url);
  es.onmessage = (e) => {
    // Track liveness on EVERY incoming event (heartbeat or real).
    lastActivityTs = Date.now();
    let ev: GlobalEvent | HeartbeatEvent;
    try { ev = JSON.parse(e.data); } catch { return; }
    // Heartbeat: server-only liveness ping, not forwarded to listeners.
    if ((ev as any).type === 'heartbeat') return;
    const real = ev as GlobalEvent;
    // Fan out to this session's listeners (except install events, which have none)
    // + to the catch-alls (which receive everything, including installs).
    if (hasSessionId(real)) {
      const perSession = listeners.get(real.sessionId);
      if (perSession) for (const cb of perSession) {
        try { cb(real); } catch {}
      }
    }
    const all = listeners.get(null);
    if (all) for (const cb of all) {
      try { cb(real); } catch {}
    }
  };
  es.onopen = () => {
    // Successful connection — reset the backoff so the next failure starts
    // from MIN_BACKOFF_MS again.
    backoffMs = 0;
    lastActivityTs = Date.now();
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
    //    (Manual reconnect via openStream() always uses the current focus
    //    in the URL, so this is mostly a safety net for the browser's
    //    own auto-retry path.)
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
  es.onerror = () => {
    // The EventSource hit an error. Per the WHATWG spec, readyState is
    // either CONNECTING (1, browser will auto-retry) or CLOSED (2,
    // browser gave up — typical after a non-200 like Apache's 502 during
    // a restart). We used to only react to CLOSED and trust the browser
    // for CONNECTING, but that turned out to be too slow: on a typical
    // `systemctl restart charon` the FIRST error is
    // `ERR_INCOMPLETE_CHUNKED_ENCODING` with state=CONNECTING (the
    // initial 200 was already received, the chunked stream just got
    // truncated), and the browser's retry then hits Apache's 502 and
    // bounces between failure modes for tens of seconds without ever
    // firing `onopen` again. The user perceives this as "stuck".
    //
    // New strategy: we ALWAYS tear down and reconnect ourselves on any
    // onerror. Predictable behavior, predictable timing, no fighting
    // with the browser's internal retry FSM. Cost: we throw away the
    // browser's in-flight retry attempt, but those reconnects are rare
    // (a few per day at most), so the overhead is negligible.
    //
    // The same connId is reused, so the server's eventConnections
    // registry dedupes any zombie state cleanly.
    if (!es) return;
    const state = es.readyState;
    scheduleReconnect(state === 2 ? 'onerror & CLOSED' : 'onerror & CONNECTING');
    // Tear down NOW so the browser doesn't keep retrying in parallel
    // with our scheduled attempt.
    teardownStream();
  };
}

/**
 * @deprecated kept for API stability — same as openStream(). Internal
 * callers should prefer openStream() directly.
 */
function ensureStream(): void {
  openStream();
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

/**
 * For debug / introspection. Returns the live connection health snapshot.
 * Exposed so a dev panel can show "last heartbeat 4s ago" if we ever
 * surface it in the UI.
 */
export function getStreamHealth(): {
  readyState: number | null;
  lastActivityMsAgo: number | null;
  openCount: number;
  reconnectPending: boolean;
  backoffMs: number;
} {
  return {
    readyState: es?.readyState ?? null,
    lastActivityMsAgo: lastActivityTs ? Date.now() - lastActivityTs : null,
    openCount,
    reconnectPending: reconnectTimer != null,
    backoffMs,
  };
}

// Stop the watchdog if all listeners go away. Not strictly necessary but
// keeps test environments tidy (jsdom doesn't tear down intervals on unmount).
function maybeStopIdle(): void {
  if (listeners.size === 0 && es == null && reconnectTimer == null) {
    stopWatchdog();
  }
}
// Hook into existing unsubscribers — kept as a no-op call we can extend later.
void maybeStopIdle;
