// THE sync bus (CLAUDE.md §14.14, §14.106). Pure: no DB, no `server-only`
// module — every piece of state lives on ONE `globalThis.__charonSync` object
// (module copies (tests' `vi.resetModules()`, dev rebuilds): a module-level `let` would be per copy and the
// revision counter would fork).
//
// publish(ev) stamps the next revision, encodes the frame ONCE
// (`id: <epoch>.<rev>\ndata: <json>\n\n`) and hands that same Uint8Array to the
// ring and to every subscriber (the SSE router pushes it to each matching
// connection — one stringify and one encode per frame, not per connection).
// The ring is bounded by bytes and age; a frame over RING_FRAME_MAX_BYTES is
// fanned out live in full but kept in the ring as a `session_resync` stub,
// so a resume across it makes that connection refetch instead of replaying
// megabytes.
//
// INVARIANTS (§2.3 I1/I2/I4): persist then publish in the same synchronous
// tick; a snapshot reads `currentRev()` after flushing coalescers, with no
// await in between; every bus frame carries `id: E.R`.
import type { SyncRev } from '@/lib/sync/rev';
import type { SyncStats } from '@/lib/sync/protocol';
import { routeOf, SUMMARY_TRIGGERS, type FrameRoute } from './frameRouting';

export type Frame = {
  rev: number; type: string; sessionId: string | null; route: FrameRoute;
  chunk: Uint8Array; size: number; at: number;
};

export type FrameSubscriber = (f: Frame, ev: Record<string, unknown>) => void;
type SummaryProvider = (ids: string[], vpsIds: string[]) => void;

/** A positive finite env number, else the default (then capped). Multiplied,
 *  never shifted: `<<` truncates to int32 (2048 MiB → negative, 0.5 → 0, i.e.
 *  a ring that evicts every frame at once). */
export function ringEnvNumber(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : dflt;
}
export const RING_MAX_BYTES = Math.floor(ringEnvNumber(process.env.CHARON_SYNC_RING_MB, 32, 1, 1024) * 1048576);
export const RING_MAX_AGE_MS = Math.floor(ringEnvNumber(process.env.CHARON_SYNC_RING_MIN, 15, 0.1, 24 * 60) * 60_000);
/** Above this, the ring keeps a `session_resync` stub instead of the frame. */
export const RING_FRAME_MAX_BYTES = 256 << 10;
/** Heap a ring frame costs beyond its payload bytes (the Frame object, its
 *  own Uint8Array + ArrayBuffer from a separate encode, the array slot) —
 *  measured ≈ 290 B on node 20. Charged to the byte budget and reported in
 *  `ringBytes`, so the cap bounds the real footprint: with payload-only
 *  accounting, small coalesced deltas (~130 B) held ≈ 3× RING_MAX_BYTES. */
export const RING_FRAME_OVERHEAD = 320;
const RING_COMPACT_AT = 1024;
const STATS_LOG_MS = 10 * 60_000;

type RateBucket = { sec: number; frames: number; bytes: number };

type SyncState = {
  epoch: number;
  rev: number;
  /** ring[head..] = frames with contiguous revs (oldest first) */
  ring: Array<Frame | undefined>;
  head: number;
  ringBytes: number;
  subs: Set<FrameSubscriber>;
  /** sessionId → rev of the last browser-routed frame carrying it */
  sessionRev: Map<string, number>;
  dirtyIds: Set<string>;
  dirtyVps: Set<string>;
  flushQueued: boolean;
  summaryProvider: SummaryProvider | null;
  routerInstalled: boolean;
  connStats: (() => { conns: number; outboxBytes: number }) | null;
  stubs: number;
  resumes: number;
  resyncs: Record<string, number>;
  closes: Record<string, number>;
  rate: RateBucket[];
  statsLoggedAt: number;
};

const encoder = new TextEncoder();

function state(): SyncState {
  const g = globalThis as unknown as { __charonSync?: SyncState };
  if (g.__charonSync) return g.__charonSync;
  const S: SyncState = {
    epoch: Date.now(),
    rev: 0,
    ring: [], head: 0, ringBytes: 0,
    subs: new Set(),
    sessionRev: new Map(),
    dirtyIds: new Set(), dirtyVps: new Set(), flushQueued: false,
    summaryProvider: null,
    routerInstalled: false,
    connStats: null,
    stubs: 0, resumes: 0, resyncs: {}, closes: {},
    rate: Array.from({ length: 60 }, () => ({ sec: -1, frames: 0, bytes: 0 })),
    statsLoggedAt: 0,
  };
  S.statsLoggedAt = S.epoch;
  g.__charonSync = S;
  return S;
}

function formatStats(s: SyncStats): string {
  const kv = (r: Record<string, number>) => Object.entries(r).map(([k, v]) => `${k}:${v}`).join(',') || '-';
  return `epoch=${s.epoch} rev=${s.rev} ring=${s.ringFrames}f/${(s.ringBytes / 1048576).toFixed(1)}MiB`
    + ` oldest=${s.oldestRev}@${Math.round(s.oldestAgeMs / 1000)}s rate=${s.framesPerMin}f/${s.bytesPerMin}B/min`
    + ` stubs=${s.stubs} conns=${s.conns} outbox=${s.outboxBytes}B resumes=${s.resumes}`
    + ` resyncs=${kv(s.resyncs)} closes=${kv(s.closes)}`;
}

// ── Ring ────────────────────────────────────────────────────────────────────

function ringLength(S: SyncState): number { return S.ring.length - S.head; }

function evictOne(S: SyncState): void {
  const f = S.ring[S.head];
  S.ring[S.head] = undefined;
  S.head++;
  if (f) S.ringBytes -= f.size + RING_FRAME_OVERHEAD;
}

/** Evict expired / over-budget frames, then compact ONCE per pass: a burst of
 *  k evictions (a quiet spell after a busy one, a full 15 min expiry) costs
 *  O(k + n), never k/1024 copies of the whole array inside the loop (G1). */
function evict(S: SyncState, now: number): void {
  while (ringLength(S) > 0) {
    const oldest = S.ring[S.head]!;
    if (S.ringBytes > RING_MAX_BYTES || now - oldest.at > RING_MAX_AGE_MS) evictOne(S);
    else break;
  }
  if (S.head > RING_COMPACT_AT) {
    S.ring.splice(0, S.head);
    S.head = 0;
  }
}

/** Oldest revision still replayable (S.rev + 1 when the ring is empty). */
function oldestRev(S: SyncState): number {
  return ringLength(S) > 0 ? S.ring[S.head]!.rev : S.rev + 1;
}

// ── Publish ─────────────────────────────────────────────────────────────────

function noteRate(S: SyncState, now: number, bytes: number): void {
  const sec = Math.floor(now / 1000);
  const b = S.rate[sec % 60];
  if (b.sec !== sec) { b.sec = sec; b.frames = 0; b.bytes = 0; }
  b.frames++;
  b.bytes += bytes;
}

/**
 * Stamp, encode once, ring, fan out. Returns the frame's revision (0 when the
 * event cannot be serialized — it then reaches nobody, browser or in-process).
 * `ev` goes on the wire exactly as given (no field is added).
 */
export function publish(ev: { type: string; sessionId?: string | null } & Record<string, unknown>): number {
  const S = state();
  let json: string;
  try {
    json = JSON.stringify(ev);
  } catch (err) {
    console.warn(`[sync] unserializable ${String(ev?.type)} frame dropped: ${(err as Error)?.message ?? err}`);
    return 0;
  }
  const rev = ++S.rev;
  const now = Date.now();
  const type = ev.type;
  const sessionId = typeof ev.sessionId === 'string' ? ev.sessionId : null;
  const route = routeOf(type);
  const chunk = encoder.encode(`id: ${S.epoch}.${rev}\ndata: ${json}\n\n`);
  const frame: Frame = { rev, type, sessionId, route, chunk, size: chunk.byteLength, at: now };

  if (frame.size > RING_FRAME_MAX_BYTES) {
    const stub = encoder.encode(`id: ${S.epoch}.${rev}\ndata: ${JSON.stringify({
      type: 'session_resync', sessionId, reason: 'large_frame',
    })}\n\n`);
    S.ring.push({ rev, type: 'session_resync', sessionId, route, chunk: stub, size: stub.byteLength, at: now });
    S.ringBytes += stub.byteLength + RING_FRAME_OVERHEAD;
    S.stubs++;
  } else {
    S.ring.push(frame);
    S.ringBytes += frame.size + RING_FRAME_OVERHEAD;
  }
  evict(S, now);
  noteRate(S, now, frame.size);
  // The `[sync]` line (ring/outbox numbers to tune the caps): at most every
  // 10 min, from the publish path — no timer, so nothing runs while idle and
  // fake-timer tests never see one.
  if (now - S.statsLoggedAt >= STATS_LOG_MS) {
    S.statsLoggedAt = now;
    try { console.log(`[sync] ${formatStats(syncStats())}`); } catch { /* logging only */ }
  }

  // What a browser can observe of this session (the probe's `sessionRev`).
  if (route !== 'internal' && sessionId) S.sessionRev.set(sessionId, rev);

  if (SUMMARY_TRIGGERS.has(type) && sessionId) {
    if (type === 'vps_status') markVpsSummariesDirty(sessionId);
    else {
      markSummaryDirty(sessionId);
      // `session_list_changed` may carry a VPS id (sidebar reorder): marking it
      // as a VPS too lets the provider recompute that VPS's sessions; a
      // session id matches no VPS and a VPS id no session (the provider owns
      // that lookup — this module never touches the DB).
      if (type === 'session_list_changed') markVpsSummariesDirty(sessionId);
    }
  }

  for (const sub of S.subs) {
    try { sub(frame, ev); } catch { /* one subscriber cannot veto the others */ }
  }
  return rev;
}

export function currentRev(): SyncRev {
  const S = state();
  return { epoch: S.epoch, rev: S.rev };
}

export function epoch(): number { return state().epoch; }

/** Rev of the last BROWSER-ROUTED frame carrying this sessionId (0 = none). */
export function sessionRevOf(id: string): number {
  return state().sessionRev.get(id) ?? 0;
}

/**
 * The ring's chunks with rev > `since` that `accept` keeps, oldest first —
 * the very instances live connections received. null ⇒ not resumable: the
 * ring no longer holds `since + 1` (gap), `since` is in the future, or the
 * accepted bytes exceed `capBytes`.
 */
export function replayFrom(since: number, accept: (f: Frame) => boolean, capBytes: number): Uint8Array[] | null {
  const S = state();
  evict(S, Date.now());
  if (!Number.isSafeInteger(since) || since < 0 || since > S.rev) return null;
  if (since === S.rev) return [];
  if (since < oldestRev(S) - 1) return null;
  const out: Uint8Array[] = [];
  let bytes = 0;
  const start = S.head + (since + 1 - S.ring[S.head]!.rev);
  for (let i = start; i < S.ring.length; i++) {
    const f = S.ring[i]!;
    if (!accept(f)) continue;
    bytes += f.size;
    if (bytes > capBytes) return null;
    out.push(f.chunk);
  }
  return out;
}

export function subscribeFrames(cb: FrameSubscriber): () => void {
  const S = state();
  S.subs.add(cb);
  return () => { S.subs.delete(cb); };
}

/** Subscribe the SSE router ONCE per process, whichever module copy asks
 *  first (its state is on `globalThis`, so any copy's router is the same). */
export function installFrameRouter(router: FrameSubscriber): void {
  const S = state();
  if (S.routerInstalled) return;
  S.routerInstalled = true;
  S.subs.add(router);
}

// ── Summaries (§14.108): dirty set, flushed once per tick ───────────────────

function queueFlush(S: SyncState): void {
  if (S.flushQueued) return;
  S.flushQueued = true;
  queueMicrotask(() => {
    S.flushQueued = false;
    flushSummaries();
  });
}

export function markSummaryDirty(id: string): void {
  if (!id) return;
  const S = state();
  S.dirtyIds.add(id);
  queueFlush(S);
}

export function markVpsSummariesDirty(vpsId: string): void {
  if (!vpsId) return;
  const S = state();
  S.dirtyVps.add(vpsId);
  queueFlush(S);
}

/** Publish this session's summary NOW if it changed (push trails summary, I17). */
export function flushSummaryNow(id: string): void {
  const S = state();
  S.dirtyIds.delete(id);
  const provider = S.summaryProvider;
  if (!provider) return;
  try { provider([id], []); } catch (err) {
    console.warn(`[sync] summary provider failed: ${(err as Error)?.message ?? err}`);
  }
}

/** Synchronous flush of the whole dirty set (snapshots call it, I2). */
export function flushSummaries(): void {
  const S = state();
  if (!S.dirtyIds.size && !S.dirtyVps.size) return;
  const ids = [...S.dirtyIds];
  const vpsIds = [...S.dirtyVps];
  S.dirtyIds.clear();
  S.dirtyVps.clear();
  const provider = S.summaryProvider;
  if (!provider) return;
  try { provider(ids, vpsIds); } catch (err) {
    console.warn(`[sync] summary provider failed: ${(err as Error)?.message ?? err}`);
  }
}

/** Registered by the summary builder module (C13) at its import. */
export function setSummaryProvider(p: SummaryProvider): void {
  state().summaryProvider = p;
}

// ── Stats (`GET /api/perf` → sync, the `[sync]` line) ───────────────────────

/** The connection registry reports its size and queued bytes. */
export function setConnStatsProvider(fn: () => { conns: number; outboxBytes: number }): void {
  state().connStats = fn;
}
export function recordResume(): void { state().resumes++; }
export function recordResync(reason: string): void {
  const r = state().resyncs;
  r[reason] = (r[reason] ?? 0) + 1;
}
export function recordClose(reason: string): void {
  const r = state().closes;
  r[reason] = (r[reason] ?? 0) + 1;
}

export function syncStats(): SyncStats {
  const S = state();
  const now = Date.now();
  evict(S, now);
  const nowSec = Math.floor(now / 1000);
  let framesPerMin = 0;
  let bytesPerMin = 0;
  for (const b of S.rate) {
    if (b.sec > nowSec - 60 && b.sec <= nowSec) { framesPerMin += b.frames; bytesPerMin += b.bytes; }
  }
  let conns = 0;
  let outboxBytes = 0;
  try {
    const c = S.connStats?.();
    if (c) { conns = c.conns; outboxBytes = c.outboxBytes; }
  } catch { /* stats only */ }
  const len = ringLength(S);
  return {
    epoch: S.epoch, rev: S.rev,
    ringFrames: len, ringBytes: S.ringBytes,
    oldestRev: oldestRev(S),
    oldestAgeMs: len > 0 ? Math.max(0, now - S.ring[S.head]!.at) : 0,
    framesPerMin, bytesPerMin,
    stubs: S.stubs, conns, outboxBytes,
    resumes: S.resumes, resyncs: { ...S.resyncs }, closes: { ...S.closes },
  };
}
