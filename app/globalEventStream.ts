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
const MAX_BACKOFF_MS = 6_000;       // cap retries at 6s. A build+restart of
                                    // the hub (the user develops Charon WITH
                                    // Charon — a session runs `npm run build
                                    // && systemctl restart charon`) keeps the
                                    // hub down ~30-60s; Apache 503s the whole
                                    // time. Capping at 6s (was 15s) means the
                                    // SSE reconnects within 6s of the hub
                                    // coming back, not 15s. The cost (a few
                                    // extra failed reconnects during the down
                                    // window) is negligible.
const STALE_MS = 20_000;            // no event for 20s → assume dead. Lower
                                    // than 30s so we catch silent stalls
                                    // before the user notices. Still > 2x
                                    // the 8s heartbeat interval so a single
                                    // missed beat does NOT trigger a
                                    // reconnect.
const WATCHDOG_TICK_MS = 4_000;     // check liveness every 4s
// Threshold for "the SSE was really down, not just a network blip". Set
// > heartbeat interval (8s) + a generous safety margin, so a single missed
// beat or a transient ~10s blip does NOT trigger an auto-reload. 15s
// reliably detects a real `systemctl restart charon` (~30-60s with build)
// or a device sleep, without false-positives on jitter.
const AUTO_RELOAD_THRESHOLD_MS = 15_000;

// ── Self-healing focus re-POST (CLAUDE.md §14.45, RC5) ──────────────────────
// High-volume events (assistant_text, tool_*, thinking) are routed server-side
// ONLY to the conn whose focus matches the session. On the browser's NATIVE
// SSE auto-reconnect the conn is re-registered with the STALE ?focus= baked
// into the URL, so the focus MUST be re-POSTed — and that POST can legitimately
// return {ok:false} when it races the conn (re)registration. The old
// fire-and-forget POST then left the active session's live streaming muted with
// no recovery. We read {ok} and retry on ok:false / network error.
const FOCUS_POST_MAX_RETRIES = 5;
const FOCUS_POST_RETRY_MS = 600;

// ── Auth probe on a never-recovering reconnect (CLAUDE.md §14.45, P8) ───────
// The EventSource API can't expose the HTTP status of a failed reconnect, so a
// 401 (session expired after a long outage) looks identical to a 502/503
// (server restarting). The 502/503 case self-heals (backoff + onmessage
// auto-reload); the 401 case loops forever silently → the user's "connected but
// dead, must F5" symptom. After a few consecutive failures we probe
// /api/auth/check (which surfaces the real status) and hard-reload on 401.
const AUTH_PROBE_AFTER_FAILURES = 3;
const AUTH_PROBE_MIN_INTERVAL_MS = 10_000;
let consecutiveFailures = 0;
let lastAuthProbeTs = 0;
let authReloadDone = false;

function reloadForAuth(): void {
  if (authReloadDone) return;
  if (typeof window === 'undefined') return;
  authReloadDone = true;
  // eslint-disable-next-line no-console
  if (typeof console !== 'undefined') console.info('[charon] SSE: session expired (401) → reload to /login');
  try { window.location.reload(); } catch {}
}

function maybeProbeAuth(): void {
  if (typeof window === 'undefined') return;
  if (consecutiveFailures < AUTH_PROBE_AFTER_FAILURES) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const now = Date.now();
  if (now - lastAuthProbeTs < AUTH_PROBE_MIN_INTERVAL_MS) return;
  lastAuthProbeTs = now;
  fetch('/api/auth/check', { cache: 'no-store' })
    .then((r) => { if (r.status === 401) reloadForAuth(); })
    .catch(() => { /* network error → server down, keep backing off */ });
}

// POST /focus with self-healing retry. Stops early if the focus changed under
// us (a newer setFocus/postFocus owns the retry then) or after N attempts.
function postFocus(sessionId: string | null, attempt = 0): void {
  if (typeof window === 'undefined') return;
  // Bail BEFORE issuing the POST if the desired focus changed under us — a
  // stale retry chain (setFocus(A) failed → scheduled; user switched to B)
  // would otherwise POST {sessionId:A} and clobber the server's focus back to
  // the previous session, muting B's high-volume stream. cf. CLAUDE.md §14.45.
  if (currentFocus !== sessionId) return;
  const id = getConnId();
  const retry = () => {
    if (currentFocus !== sessionId) return;          // superseded — drop
    if (attempt >= FOCUS_POST_MAX_RETRIES) return;
    setTimeout(() => postFocus(sessionId, attempt + 1), FOCUS_POST_RETRY_MS);
  };
  fetch('/api/claude/focus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conn: id, sessionId }),
  })
    .then((r) => r.json().catch(() => ({ ok: false })))
    .then((j) => { if (!(j && j.ok)) retry(); })
    .catch(retry);
}

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
  // If the browser knows it's offline, don't burn retries — they will all
  // fail instantly with ERR_NETWORK. Tear down and wait for the `online`
  // event (wired in attachWindowListeners) to trigger reconnectNow. This
  // is what stops the "reconnect in 1000ms / 2000ms / ..." spam in the
  // console while a laptop is asleep / Wi-Fi is down.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    teardownStream();
    return;
  }
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
      consecutiveFailures++;
      maybeProbeAuth();
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
    const now = Date.now();
    // Track liveness on EVERY incoming event (heartbeat or real). We also
    // use lastActivityTs to detect an outage we just recovered from — see
    // the auto-reload below.
    const prevTs = lastActivityTs;
    const silenceMs = prevTs > 0 ? now - prevTs : 0;
    lastActivityTs = now;
    // Real data flowed → the connection is healthy. Reset the failure streak
    // that drives the auth probe (CLAUDE.md §14.45, P8).
    consecutiveFailures = 0;
    // Reset the backoff HERE (on real data), not on `onopen`. A connection
    // that opens then immediately breaks (proxy cutting the stream, server
    // restarting mid-response) should keep backing off — resetting on
    // `onopen` made the backoff useless (it always reset to 1s right before
    // the next break → tight open→break→reopen loop). The server sends a
    // heartbeat immediately on connect, so a healthy stream resets the
    // backoff within milliseconds anyway.
    backoffMs = 0;

    // ─── Auto-reload on outage recovery ──────────────────────────────────
    // The user's repeated complaint (CLAUDE.md §14 gotcha 24) was always:
    // "the chat doesn't update after a server restart — I have to F5".
    // Their own suggestion: "if a refresh fixes it, just simulate the
    // refresh." We tried every clever partial recovery (polling deltas,
    // clean refetch, error boundary, etc.) and they all had subtle holes.
    // This is the LITERAL implementation of the user's request: when the
    // SSE has been SILENT for longer than the heartbeat interval (8s) plus
    // a generous margin — i.e. the hub was actually down (build+restart
    // ~30-60s, or device sleep) — and the stream JUST recovered (this
    // event is the first activity), do `window.location.reload()`.
    //
    // Why not soft-recover (polling/refetch)? Because we've burned 8
    // rounds proving that something always breaks the soft path. A hard
    // reload is the ONE thing that ALWAYS works (it's literally what the
    // user is doing by hand every time). The cost — losing the textarea
    // draft and resetting scroll — is the same cost they're already
    // paying manually, plus the page just re-SSRs cleanly with all the
    // post-restart state.
    if (silenceMs > AUTO_RELOAD_THRESHOLD_MS && typeof window !== 'undefined') {
      // eslint-disable-next-line no-console
      console.info(`[charon] SSE silent ${Math.round(silenceMs / 1000)}s → recovered → hard reload (matches manual F5)`);
      // Use a microtask to let the runtime finish the current callback
      // cleanly before navigating.
      setTimeout(() => { try { window.location.reload(); } catch {} }, 0);
      return;
    }

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
    // NOTE: backoff is reset in `onmessage` (on real data), NOT here — see
    // the comment there. `onopen` only means the HTTP response started;
    // the stream can still break immediately.
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
    // Self-healing re-POST: reads {ok} and retries on ok:false (conn not yet
    // re-registered after the native reconnect) so high-volume streaming for
    // the focused session resumes reliably. cf. CLAUDE.md §14.45 (RC5).
    if (currentFocus) postFocus(currentFocus);
    for (const cb of reconnectListeners) {
      try { cb(); } catch {}
    }
  };
  es.onerror = () => {
    // The EventSource hit an error. Per the WHATWG spec, readyState is
    // either CONNECTING (1) or CLOSED (2).
    //
    //   - CLOSED (2): the browser gave up — typically after a non-200
    //     (Apache 502 while Charon restarts). The browser will NOT retry
    //     on its own. We MUST reconnect manually, with backoff.
    //
    //   - CONNECTING (1): the browser IS auto-retrying (transient network
    //     blip, stream truncated). We deliberately DO NOTHING here. An
    //     earlier version tore the stream down on every CONNECTING error
    //     and reconnected manually — but that fought the browser's own
    //     retry and, combined with the backoff reset on `onopen`, produced
    //     a pathological open→break→reopen loop every 1000ms during any
    //     network instability (hammering the server + firing refetch every
    //     second). The watchdog (no event for STALE_MS) is the backstop:
    //     if the browser's retry also stalls, the watchdog forces a clean
    //     reconnect. And the 5s polling loop in useClaudeSessionStream
    //     keeps the chat fresh regardless of SSE state.
    if (!es) return;
    if (es.readyState === 2 /* CLOSED */) {
      // Count the failure and, after a few in a row, probe /api/auth/check to
      // tell "server down" (recovers on its own) from "session expired" (loops
      // forever until we reload to /login). cf. CLAUDE.md §14.45 (P8).
      consecutiveFailures++;
      maybeProbeAuth();
      scheduleReconnect('onerror & CLOSED');
      teardownStream();
    }
    // CONNECTING: leave it to the browser + watchdog + polling.
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
  // POST /focus — read {ok} and self-heal on ok:false (the conn may not be
  // registered yet if setFocus raced ensureStream). cf. CLAUDE.md §14.45 (RC5).
  const id = getConnId();
  const post = fetch('/api/claude/focus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conn: id, sessionId }),
  })
    .then((r) => r.json().catch(() => ({ ok: false })))
    .then((j) => {
      if (currentFocus === sessionId && !(j && j.ok)) {
        setTimeout(() => postFocus(sessionId, 1), FOCUS_POST_RETRY_MS);
      }
    })
    .catch(() => {
      if (currentFocus === sessionId) setTimeout(() => postFocus(sessionId, 1), FOCUS_POST_RETRY_MS);
    });
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
