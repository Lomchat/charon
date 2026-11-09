'use client';
import type { WorkerEvent } from '@/lib/server/hub/types';
import type { InstallStatus } from '@/lib/types/api';
import { cmpRev, type SyncRev } from '@/lib/sync/rev';
import { attentionAgeMs, installAttentionTracking, isAttentive, noteAttentionProofLost } from './attention';
import { hasUnsavedInput } from './inputDraftStore';
import {
  initialSyncState, onFrame as syncOnFrame, onOpen as syncOnOpen, sinceParam, withInitialPosition,
  type ResyncReason, type SyncClientState,
} from './sync/syncClientState';

// globalEventStream — THE transport (CLAUDE.md §9, §14.24)
// ─────────────────────────────────────────────────────────────────────────────
// ONE EventSource on /api/events per tab, speaking proto 2: every bus
// frame carries `id: <epoch>.<rev>`; per-connection control frames (§3.3 of
// lib/sync/protocol.ts) are recognised by type. Consumers subscribe here
// (`subscribeSession`, `subscribeAll`, `subscribeSyncFrames`) instead of
// opening their own stream (HTTP/1.1 caps connections per origin, §14.15). The
// focus moves with POST /api/focus; the stream stays open.
//
// Reconnects are MANUAL, always: `onerror` closes the EventSource and
// schedules a reconnect (jittered 250–1500 ms, then 1→2→4→6 s ±20 %), the URL
// carrying `since=<epoch>.<lastRev>` (the first connect of a page: the SSR
// stamp, `initSyncPosition`). The hub answers with either
//   - `sync_hello{resume}` + the missed frames (their own ids, under the
//     CURRENT focus) + `sync_replay_end` — exact, nothing to refetch; or
//   - `sync_hello{resync}` + summaries, VPS runtime, installs, notices +
//     `sync_snapshot_end` — an EXPLICIT resync: `subscribeResync` listeners
//     (list, tabs, settings, shells, usage, profiles; transcripts re-window
//     unless covered) run once per snapshot end.
// The baseline rules live in app/sync/syncClientState.ts (pure, tested).
//
// Backstops (§14.24): the registry heartbeat (a typed `data:` frame every 8 s)
// + a 20 s silence watchdog; no `sync_hello` within 10 s of `onopen` ⇒
// reconnect; two `ok:false` focus answers of one chain ⇒ reconnect. NO hard
// reload on silence (that lost drafts): reloads happen only on a 401 (auth
// probe) or on a new build when no draft exists and the tab is idle.
//
// Degraded mode (this bundle against an older or rolled-back hub, which never
// sends `sync_hello`): after 3 consecutive hello-less opens the legacy stream
// is accepted (rev-less frames), the hello watchdog is off, the reload chip
// shows and the consumers fall back to polling. A `sync_hello` (or a reload)
// leaves it — never a reconnect loop rebuilding the legacy snapshot.

export type InstallBusClientEvent =
  | { type: 'install_started'; installId: string; vpsId: string; vpsName: string; status: InstallStatus }
  | { type: 'install_finished'; installId: string; vpsId: string; vpsName: string; status: InstallStatus };

export type SessionBusClientEvent = WorkerEvent & { sessionId: string };

export type GlobalEvent = SessionBusClientEvent | InstallBusClientEvent
  | { type: 'model_notices'; notices: import('@/lib/types/api').ModelNoticesResponse };

function hasSessionId(ev: GlobalEvent): ev is SessionBusClientEvent {
  return 'sessionId' in ev && typeof (ev as { sessionId?: unknown }).sessionId === 'string';
}

/** How a frame reached this tab. `rev`: its bus revision (null: rev-less —
 *  an older hub, or a control frame); `catchUp`: replayed from the hub's ring
 *  on a resume (not live traffic — excluded from the kB/s gauge, §14.50). */
export type EventReception = { bytes: number; at: number; rev: SyncRev | null; catchUp: boolean };
type SessionListener = (ev: SessionBusClientEvent, reception: EventReception) => void;
type GlobalListener = (ev: GlobalEvent, reception: EventReception) => void;

/** What `subscribeSyncFrames` hands the summary store: every delivered frame,
 *  control frames included, BEFORE any other listener. `snapshotRev` = the
 *  resync's R for its snapshot frames (`sync_summaries`, `sync_vps`,
 *  `sync_installs`), which carry no id. */
export type SyncFrameInfo = { rev: SyncRev | null; snapshotRev: SyncRev | null; catchUp: boolean; control: boolean };
export type SyncFrame = { type: string; sessionId?: string } & Record<string, unknown>;
type SyncFrameListener = (frame: SyncFrame, info: SyncFrameInfo) => void;

export type ResyncInfo = { rev: SyncRev; reason: ResyncReason };

// Control frames that only the sync feed sees (`model_notices` also reaches
// the catch-all listeners: useModelNotices reads it there).
const FEED_ONLY = new Set(['sync_hello', 'sync_replay_end', 'sync_summaries', 'sync_vps', 'sync_installs', 'sync_snapshot_end']);

function genConnId(): string {
  if (typeof crypto !== 'undefined' && (crypto as { randomUUID?: () => string }).randomUUID) {
    return (crypto as { randomUUID: () => string }).randomUUID();
  }
  return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Stable connId for the tab: a reconnect with the same id replaces the old
// registration (eventConnections.ts § registerConnection, §14.15).
let connId: string | null = null;
let es: EventSource | null = null;
let currentFocus: string | null = null;
let currentFocusSeq = 0;
// `null` key = catch-all listeners.
const listeners = new Map<string | null, Set<GlobalListener>>();
const syncFrameListeners = new Set<SyncFrameListener>();
const resyncListeners = new Set<(r: ResyncInfo) => void>();
const reconnectListeners = new Set<() => void>();
const readyListeners = new Set<() => void>();
const buildMismatchListeners = new Set<(buildId: string) => void>();
const degradedListeners = new Set<(degraded: boolean) => void>();
const receptionEncoder = new TextEncoder();

let sync: SyncClientState = initialSyncState();
// sessionId → max rev of every bus frame delivered to this tab carrying it.
const sessionFrameRevs = new Map<string, SyncRev>();

// ── Reconnection state ──────────────────────────────────────────────────────
let lastActivityTs = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let helloTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;               // failed attempts since the last healthy stream
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let windowListenersAttached = false;
let openCount = 0;
let helloSeenOnThisConn = false;
let helloLessOpens = 0;
let degraded = false;

const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 6_000];
const FIRST_RETRY_MIN_MS = 250;
const FIRST_RETRY_MAX_MS = 1_500;
/** No frame (the 8 s registry heartbeat included) for 20 s ⇒ assume dead. */
export const STALE_MS = 20_000;
const WATCHDOG_TICK_MS = 4_000;
/** No `sync_hello` within this delay of `onopen` ⇒ reconnect. */
export const HELLO_TIMEOUT_MS = 10_000;
/** Hello-less opens in a row before the legacy stream is accepted. */
export const DEGRADED_AFTER_OPENS = 3;

/** Delay of the next retry. Exported for tests. */
export function backoffDelay(n: number, rand: () => number = Math.random): number {
  if (n <= 0) return Math.round(FIRST_RETRY_MIN_MS + rand() * (FIRST_RETRY_MAX_MS - FIRST_RETRY_MIN_MS));
  const base = BACKOFF_STEPS_MS[Math.min(n - 1, BACKOFF_STEPS_MS.length - 1)];
  return Math.round(base * (0.8 + rand() * 0.4));
}

// ── Self-healing focus re-POST (CLAUDE.md §14.45) ───────────────────────────
// High-volume frames reach ONLY the connection whose focus is their session.
// The POST may return {ok:false} when it races the (re)registration: retry.
const FOCUS_POST_MAX_RETRIES = 5;
const FOCUS_POST_RETRY_MS = 600;
// Two CONSECUTIVE `ok:false` answers OF ONE CHAIN (a POST and its own retry)
// mean the server does not know this conn (a zombie registration, a stream the
// proxy cut without telling us): a fresh EventSource heals that, retries do
// not. Rate-limited so a registration race right after a reconnect cannot loop.
const FOCUS_NOT_APPLIED_RECONNECT_AFTER = 2;
const FOCUS_RECONNECT_MIN_INTERVAL_MS = 10_000;
let lastFocusReconnectAt = 0;

// ── Auth probe on a never-recovering reconnect (CLAUDE.md §14.45) ───────────
// EventSource hides the HTTP status: a 401 (session expired) looks like a 502.
// After a few consecutive failures probe /api/auth/check; reload on 401 only.
const AUTH_PROBE_AFTER_FAILURES = 3;
const AUTH_PROBE_MIN_INTERVAL_MS = 10_000;
let consecutiveFailures = 0;
let lastAuthProbeTs = 0;
let authReloadDone = false;

// ── New build (version skew, FM8) ───────────────────────────────────────────
// `hello.buildId !== initialSync.buildId` ⇒ the chip ("Charon was updated —
// reload"). Auto-reload ONLY when nothing holds unsaved input (composer drafts,
// question answers, commit message, dirty editor tabs: inputDraftStore.ts §
// hasUnsavedInput) AND the tab has been hidden > 30 s or
// idle 5 min; otherwise the chip waits for the user.
export const BUILD_RELOAD_HIDDEN_MS = 30_000;
export const BUILD_RELOAD_IDLE_MS = 5 * 60_000;
const BUILD_CHECK_TICK_MS = 5_000;
let mismatchedBuild: string | null = null;
let buildTimer: ReturnType<typeof setInterval> | null = null;
let hiddenSince: number | null = null;
let lastInputAt = Date.now();
let buildReloadDone = false;

function reload(reason: string): void {
  // eslint-disable-next-line no-console
  if (typeof console !== 'undefined') console.info(`[charon] reload (${reason})`);
  try { window.location.reload(); } catch {}
}

function reloadForAuth(): void {
  if (authReloadDone || typeof window === 'undefined') return;
  authReloadDone = true;
  reload('session expired (401) → /login');
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

function docVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

// The focus POST's attention report: `attentive` plus the age of the proof.
function focusAttention(): { attentive: boolean; attentiveAgeMs?: number } {
  const age = attentionAgeMs();
  return age == null ? { attentive: false } : { attentive: true, attentiveAgeMs: Math.round(age) };
}

// POST /focus with self-healing retry. Stops early if the focus changed under
// us (a newer setFocus owns the retry then) or after N attempts.
async function postFocus(sessionId: string | null, focusSeq: number, attemptNo = 0, notApplied = 0): Promise<void> {
  if (typeof window === 'undefined') return;
  // A stale retry chain must never POST an old focus over a newer one.
  if (currentFocus !== sessionId || currentFocusSeq !== focusSeq) return;
  const id = getConnId();
  const retry = (notAppliedSoFar: number) => {
    if (currentFocus !== sessionId || currentFocusSeq !== focusSeq) return;
    if (attemptNo >= FOCUS_POST_MAX_RETRIES) return;
    setTimeout(() => { void postFocus(sessionId, focusSeq, attemptNo + 1, notAppliedSoFar); }, FOCUS_POST_RETRY_MS);
  };
  try {
    const r = await fetch('/api/focus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conn: id, sessionId, focusSeq,
        visible: docVisible(),
        // Only an ATTENDED view reads a finish (§14.47, app/attention.ts).
        // The age dates the proof by the input, not by this POST.
        ...focusAttention(),
      }),
      keepalive: !docVisible(),
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok === false) {
      // Only an OPEN stream that has had its hello (or a legacy, hello-less
      // hub) is a zombie the server does not know. A CONNECTING one is just
      // not registered yet: the hello timeout and the stale watchdog own it.
      const settled = es != null && es.readyState === 1 && (helloSeenOnThisConn || degraded);
      if (!settled) { retry(notApplied); return; }
      const n = notApplied + 1;
      const now = Date.now();
      if (n >= FOCUS_NOT_APPLIED_RECONNECT_AFTER
        && now - lastFocusReconnectAt >= FOCUS_RECONNECT_MIN_INTERVAL_MS) {
        lastFocusReconnectAt = now;
        if (currentFocus === sessionId && currentFocusSeq === focusSeq) reconnectNow('focus not applied');
        return;
      }
      retry(n);
      return;
    }
    if (!(j?.ok && j.focusSeq === focusSeq && j.focus === sessionId)) retry(j?.ok ? 0 : notApplied);
  } catch {
    retry(notApplied);
  }
}

// POST /focus `{kind:'attention'}`: "a human is at this device".
// An ok:false answer (the conn is not registered yet: a CONNECTING stream)
// loses the proof: the tracker re-arms so the next input proves again, and the
// hello's focus re-POST (reassertAttendedFocus) carries it meanwhile.
function postAttention(): void {
  if (typeof window === 'undefined' || !connId || !es) return;
  void fetch('/api/focus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conn: connId, kind: 'attention' }),
  }).then(async (r) => {
    const j = await r.json().catch(() => null);
    if (j && j.ok === false) noteAttentionProofLost();
  }).catch(() => {});
}

// Once a stream is registered (its hello, or a legacy hub's open): an attended
// device re-POSTs its focus. The URL carries no presence report, and a tab
// that switched sessions while the stream was down owes the hub that report:
// it is what reads the session it left (§14.47).
function reassertAttendedFocus(): void {
  if (currentFocus == null || !isAttentive()) return;
  void postFocus(currentFocus, ++currentFocusSeq);
}

function getConnId(): string {
  if (!connId) connId = genConnId();
  return connId;
}

// `attentive=1|0` plus the proof's age: every (re)connect rebuilds the URL
// (onerror always reconnects manually), so the age is current and the hub dates
// the grant by the input, not by the registration (§14.47).
function attentionParams(): string {
  const age = attentionAgeMs();
  return age == null ? '&attentive=0' : `&attentive=1&attentiveAgeMs=${Math.round(age)}`;
}

function buildUrl(): string {
  const since = sinceParam(sync);
  return `/api/events?conn=${encodeURIComponent(getConnId())}`
    + (currentFocus ? `&focus=${encodeURIComponent(currentFocus)}` : '')
    + `&focusSeq=${currentFocusSeq}`
    + `&visible=${docVisible() ? '1' : '0'}`
    + attentionParams()
    + '&proto=2'
    + (since ? `&since=${encodeURIComponent(since)}` : '');
}

function clearReconnectTimer(): void {
  if (reconnectTimer != null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}
function clearHelloTimer(): void {
  if (helloTimer != null) { clearTimeout(helloTimer); helloTimer = null; }
}

function teardownStream(): void {
  clearHelloTimer();
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
  if (reconnectTimer != null) return;
  teardownStream();
  // `navigator.onLine === false` is only a hint (a localhost/LAN hub without a
  // default route reads offline while reachable): never stop retrying, only
  // slow down to the ladder's last step. The `online` event still reconnects
  // at once.
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const delay = offline ? Math.max(backoffDelay(attempt), backoffDelay(BACKOFF_STEPS_MS.length)) : backoffDelay(attempt);
  attempt++;
  // eslint-disable-next-line no-console
  if (typeof console !== 'undefined') console.info(`[charon] SSE reconnect in ${delay}ms (${reason})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openStream();
  }, delay);
}

function reconnectNow(reason: string): void {
  clearReconnectTimer();
  teardownStream();
  // eslint-disable-next-line no-console
  if (typeof console !== 'undefined') console.info(`[charon] SSE reconnect now (${reason})`);
  openStream();
}

function startWatchdog(): void {
  if (watchdogTimer != null) return;
  watchdogTimer = setInterval(() => {
    if (!es || lastActivityTs === 0) return;
    const age = Date.now() - lastActivityTs;
    if (age > STALE_MS) {
      // The registry heartbeat (8 s) stopped: proxy buffering, NAT timeout,
      // a superseded or never-registered conn. Reconnect — never reload.
      lastActivityTs = 0;
      consecutiveFailures++;
      maybeProbeAuth();
      scheduleReconnect(`stale ${Math.round(age / 1000)}s`);
    }
  }, WATCHDOG_TICK_MS);
}

function noteInput(): void { lastInputAt = Date.now(); }

function attachWindowListeners(): void {
  if (windowListenersAttached || typeof window === 'undefined') return;
  windowListenersAttached = true;

  window.addEventListener('online', () => {
    if (!es || es.readyState === 2 /* CLOSED */) reconnectNow('online event');
    else lastActivityTs = Math.min(lastActivityTs, Date.now() - STALE_MS + 2_000);
  });
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    try { window.addEventListener(type, noteInput, { capture: true, passive: true }); } catch {}
  }

  document.addEventListener('visibilitychange', () => {
    hiddenSince = docVisible() ? null : Date.now();
    if (docVisible()) noteInput();
    if (es) void postFocus(currentFocus, ++currentFocusSeq);
    if (!docVisible()) return;
    if (!es || es.readyState === 2 /* CLOSED */) {
      if (reconnectTimer == null) reconnectNow('tab visible & ES closed');
      return;
    }
    const age = lastActivityTs ? Date.now() - lastActivityTs : Infinity;
    if (age > STALE_MS) reconnectNow(`tab visible & stale ${Math.round(age / 1000)}s`);
  });
}

function setDegraded(next: boolean): void {
  if (degraded === next) return;
  degraded = next;
  // eslint-disable-next-line no-console
  if (typeof console !== 'undefined') console.info(`[charon] SSE ${next ? 'degraded: legacy hub (no sync_hello)' : 'sync protocol back'}`);
  for (const cb of degradedListeners) { try { cb(next); } catch {} }
}

function armHelloWatchdog(): void {
  clearHelloTimer();
  if (degraded) return;
  helloTimer = setTimeout(() => {
    helloTimer = null;
    if (helloSeenOnThisConn || !es) return;
    helloLessOpens++;
    if (helloLessOpens >= DEGRADED_AFTER_OPENS) {
      // An older hub: accept its legacy stream as it is.
      setDegraded(true);
      return;
    }
    reconnectNow('no sync_hello');
  }, HELLO_TIMEOUT_MS);
}

function noteBuild(buildId: string): void {
  if (mismatchedBuild === buildId) return;
  mismatchedBuild = buildId;
  for (const cb of buildMismatchListeners) { try { cb(buildId); } catch {} }
  if (buildTimer == null) {
    buildTimer = setInterval(maybeReloadForBuild, BUILD_CHECK_TICK_MS);
  }
}

/** The idle-gated, draft-safe auto-reload for a new build. Exported for tests. */
export function maybeReloadForBuild(now = Date.now()): boolean {
  if (!mismatchedBuild || buildReloadDone || typeof window === 'undefined') return false;
  if (hasUnsavedInput()) return false;
  const hiddenLong = hiddenSince != null && now - hiddenSince > BUILD_RELOAD_HIDDEN_MS;
  const idle = now - lastInputAt > BUILD_RELOAD_IDLE_MS;
  if (!hiddenLong && !idle) return false;
  buildReloadDone = true;
  reload(`new build ${mismatchedBuild}`);
  return true;
}

function notifyMany(set: Set<() => void>): void {
  for (const cb of set) { try { cb(); } catch {} }
}

function handleMessage(e: MessageEvent): void {
  const now = Date.now();
  lastActivityTs = now;

  let raw: Record<string, unknown>;
  try { raw = JSON.parse(e.data); } catch { return; }
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return;
  const type = raw.type;

  if (type === 'sync_hello') {
    helloSeenOnThisConn = true;
    epochReconnectPending = false;
    helloLessOpens = 0;
    clearHelloTimer();
    setDegraded(false);
    reassertAttendedFocus();
  }

  const prevSnapshotStamp = sync.snapshotStamp;
  const out = syncOnFrame(sync, { type, lastEventId: e.lastEventId, payload: raw });
  sync = out.state;
  // Healthy only once the prologue completed (`live`: snapshot or replay
  // end), or any frame of a legacy hub's stream (degraded, no prologue). A
  // stream the hub closes after its hello / mid-snapshot (prologue error,
  // outbox cap) must NOT reset the backoff: else it retries at the first-step
  // delay forever, each a full resync, and the auth probe never runs.
  if (sync.phase === 'live' || (degraded && sync.phase === 'idle')) {
    consecutiveFailures = 0;
    attempt = 0;
  }
  if (out.fire === 'buildMismatch' && typeof raw.buildId === 'string') noteBuild(raw.buildId);
  if (out.reconnect) { reconnectNow('resume baseline mismatch'); return; }
  if (!out.deliver) return;

  const control = FEED_ONLY.has(type) || (type === 'model_notices' && !out.rev);
  const info: SyncFrameInfo = {
    rev: out.rev,
    snapshotRev: sync.phase === 'snapshot' ? sync.snapshotStamp : (type === 'sync_snapshot_end' ? prevSnapshotStamp : null),
    catchUp: out.catchUp,
    control,
  };
  const frame = raw as SyncFrame;
  const sid = typeof frame.sessionId === 'string' ? frame.sessionId : null;
  // The client half of the probe's `sessionRev` (C16): recorded BEFORE any
  // handler runs, for every delivered bus frame carrying the session id.
  if (sid && out.rev && !control) {
    const held = sessionFrameRevs.get(sid);
    if (!held || cmpRev(out.rev, held) > 0) sessionFrameRevs.set(sid, out.rev);
  }

  // The summary store (and any sync consumer) first: other listeners then
  // read an up-to-date store.
  for (const cb of syncFrameListeners) { try { cb(frame, info); } catch {} }

  if (type === 'sync_snapshot_end' && out.fire === 'resync' && out.rev) {
    const r: ResyncInfo = { rev: out.rev, reason: sync.resyncReason ?? 'first' };
    for (const cb of resyncListeners) { try { cb(r); } catch {} }
    notifyMany(reconnectListeners);
    notifyMany(readyListeners);
    return;
  }
  if (type === 'sync_replay_end') { notifyMany(readyListeners); return; }
  if (FEED_ONLY.has(type)) return;

  const ev = raw as unknown as GlobalEvent;
  const reception: EventReception = {
    bytes: receptionEncoder.encode(e.data).byteLength,
    at: typeof performance !== 'undefined' ? performance.now() : now,
    rev: out.rev,
    catchUp: out.catchUp,
  };
  if (hasSessionId(ev)) {
    const perSession = listeners.get(ev.sessionId);
    if (perSession) for (const cb of perSession) { try { cb(ev, reception); } catch {} }
  }
  const all = listeners.get(null);
  if (all) for (const cb of all) { try { cb(ev, reception); } catch {} }
}

function openStream(): void {
  if (es) return;
  if (typeof window === 'undefined') return; // SSR guard
  // A pending backoff must never outlive a newer stream: its armed timer made
  // the new stream's onerror skip the teardown (`scheduleReconnect` returns
  // early), and the browser's own CONNECTING retry replayed the old URL.
  clearReconnectTimer();
  // Before the window listeners: its visibility handler must update the
  // attention state before the focus re-POST reads it.
  installAttentionTracking(postAttention, () => currentFocus != null);
  attachWindowListeners();
  startWatchdog();

  sync = syncOnOpen(sync);
  helloSeenOnThisConn = false;
  const stream = new EventSource(buildUrl());
  es = stream;
  // The CONNECTING phase counts as silence too: a request that hangs before
  // its headers (dead TCP after a network handoff, a queued HTTP/1.1 slot, a
  // stalled proxy) fires neither onopen nor onerror ⇒ the stale watchdog
  // reconnects it after STALE_MS. Not a hello-less open (degraded mode counts
  // real opens only).
  lastActivityTs = Date.now();
  stream.onmessage = (e) => { if (es === stream) handleMessage(e); };
  stream.onopen = () => {
    if (es !== stream) return;
    lastActivityTs = Date.now();
    openCount++;
    armHelloWatchdog();
    // A legacy hub sends no snapshot end: its reopen is the only "you may
    // have missed something" signal those consumers get.
    if (degraded && openCount > 1) notifyMany(reconnectListeners);
    if (degraded) reassertAttendedFocus();
  };
  stream.onerror = () => {
    if (es !== stream) return;
    // Always manual: close, back off, reconnect with `since` (no CONNECTING
    // passthrough — the browser's own retry would replay the OLD url).
    consecutiveFailures++;
    maybeProbeAuth();
    scheduleReconnect('onerror');
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** The SSR stamp (`initialSync`): the first connect of the page resumes from
 *  it, and its `buildId` is the build this page runs. Idempotent. */
export function initSyncPosition(initial: (SyncRev & { buildId?: string | null }) | null | undefined): void {
  // Browser only: a server render must not pin the module's state.
  if (positionInitialized || !initial || typeof window === 'undefined') return;
  positionInitialized = true;
  sync = withInitialPosition(sync, initial);
}
let positionInitialized = false;

/** `{epoch, lastRev}`: what this tab has seen of the bus (§3.3.1). */
export function getSyncPosition(): { epoch: number | null; lastRev: number | null } {
  return { epoch: sync.epoch, lastRev: sync.lastRev };
}

/**
 * An HTTP answer's `sync` against this tab's epoch: `'older'` = from a
 * previous hub process (ignore it), `'newer'` = the hub restarted (a reconnect
 * is triggered), `'same'`/`'unknown'` = usable.
 */
export function noteHttpSync(stamp: SyncRev | null | undefined): 'same' | 'older' | 'newer' | 'unknown' {
  if (!stamp || sync.epoch == null) return 'unknown';
  if (stamp.epoch < sync.epoch) return 'older';
  if (stamp.epoch > sync.epoch) {
    if (es || reconnectTimer) requestReconnect('epoch');
    return 'newer';
  }
  return 'same';
}

/** Fires once per `sync_snapshot_end`, EVERY reason including `first`
 *  (consumers dedupe with their own stamps/coverage). Nothing fires on a
 *  resume: the replay is exact. */
export function subscribeResync(cb: (r: ResyncInfo) => void): () => void {
  resyncListeners.add(cb);
  return () => { resyncListeners.delete(cb); };
}

/** Alias kept for older consumers: fires at the same moment as
 *  `subscribeResync` (and on a legacy hub's reopen in degraded mode). */
export function subscribeReconnect(cb: () => void): () => void {
  reconnectListeners.add(cb);
  return () => { reconnectListeners.delete(cb); };
}

/** Fires at every `sync_replay_end` and `sync_snapshot_end`. */
export function subscribeSyncReady(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => { readyListeners.delete(cb); };
}

/** Every delivered frame, control frames included (store feed). Passive:
 *  does not open the stream. */
export function subscribeSyncFrames(cb: SyncFrameListener): () => void {
  syncFrameListeners.add(cb);
  return () => { syncFrameListeners.delete(cb); };
}

/** Max rev of every bus frame delivered to this tab carrying this session id
 *  (any type, summary frames included). */
export function getSessionFrameRev(sessionId: string): SyncRev | null {
  return sessionFrameRevs.get(sessionId) ?? null;
}

/** The connection id and the current focus sequence (the window GET applies
 *  focus atomically with them, C12). */
export function getFocusTicket(): { conn: string; seq: number } {
  return { conn: getConnId(), seq: currentFocusSeq };
}

/** The stream is registered on the hub with its prologue done (or a legacy
 *  hub's stream is open): a window GET's focus ticket applies at once. */
export function isStreamLive(): boolean {
  return es != null && (sync.phase === 'live' || degraded);
}

export function requestReconnect(reason: string): void {
  if (typeof window === 'undefined') return;
  // One newer-epoch HTTP answer can reach several triggers (the window's
  // fetch, the list seed, a probe) before the new stream says hello: the
  // stream opened by the first one already follows the new epoch.
  if (reason === 'epoch' && epochReconnectPending && es && !helloSeenOnThisConn) return;
  reconnectNow(reason);
  if (reason === 'epoch') epochReconnectPending = true;
}
let epochReconnectPending = false;

/** Fires once per distinct new build seen in a hello. */
export function subscribeBuildMismatch(cb: (buildId: string) => void): () => void {
  buildMismatchListeners.add(cb);
  if (mismatchedBuild) { try { cb(mismatchedBuild); } catch {} }
  return () => { buildMismatchListeners.delete(cb); };
}

export function getBuildMismatch(): string | null { return mismatchedBuild; }

export function isDegraded(): boolean { return degraded; }

export function subscribeDegraded(cb: (degraded: boolean) => void): () => void {
  degradedListeners.add(cb);
  return () => { degradedListeners.delete(cb); };
}

/** Subscribe a listener to ALL frames of a session. Opens the SSE lazily. */
export function subscribeSession(sessionId: string, cb: SessionListener): () => void {
  openStream();
  let set = listeners.get(sessionId);
  if (!set) { set = new Set(); listeners.set(sessionId, set); }
  // Only SessionBusClientEvent values are dispatched into this bucket.
  set.add(cb as GlobalListener);
  return () => {
    const s = listeners.get(sessionId);
    if (!s) return;
    s.delete(cb as GlobalListener);
    if (s.size === 0) listeners.delete(sessionId);
  };
}

/** Subscribe a listener to ALL frames of ALL sessions (+ installs, notices). */
export function subscribeAll(cb: GlobalListener): () => void {
  openStream();
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
 * Change the focus session on the server (high-volume frames follow it). A
 * repeated focus re-POSTs: POST /focus carries the presence report that reads
 * what the focus left (§14.47), so a repeated selection heals an earlier POST
 * that raced the registration. The monotonic sequence makes the latest call
 * win.
 */
export async function setFocus(sessionId: string | null): Promise<void> {
  if (currentFocus === sessionId) {
    openStream();
    if (currentFocusSeq > 0) await postFocus(sessionId, currentFocusSeq);
    return;
  }
  // Before opening: the initial URL then already carries the right focus.
  currentFocus = sessionId;
  const seq = ++currentFocusSeq;
  openStream();
  await postFocus(sessionId, seq);
}

export function getCurrentFocus(): string | null {
  return currentFocus;
}

/** Debug / introspection snapshot. */
export function getStreamHealth(): {
  readyState: number | null;
  lastActivityMsAgo: number | null;
  openCount: number;
  reconnectPending: boolean;
  attempt: number;
  degraded: boolean;
  epoch: number | null;
  lastRev: number | null;
} {
  return {
    readyState: es?.readyState ?? null,
    lastActivityMsAgo: lastActivityTs ? Date.now() - lastActivityTs : null,
    openCount,
    reconnectPending: reconnectTimer != null,
    attempt,
    degraded,
    epoch: sync.epoch,
    lastRev: sync.lastRev,
  };
}
