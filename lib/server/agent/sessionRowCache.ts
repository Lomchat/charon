import 'server-only';
import type Database from 'better-sqlite3';
import { rawSqlite } from '@/lib/db';
import { timeSection } from '@/lib/server/perf/loopLag';

// Incremental, validated, evicting folds over a session's `event` rows
// (CLAUDE.md §4, I11). Token totals, recorded turn usage and the background-
// task registry were each a LIKE scan of EVERY row of the session — on every
// window/delta/context GET and every `endpoint_usage` event. They are pure
// left folds in id order (first-by-id dedup), and ids are AUTOINCREMENT
// (never reused; every new row, a late "repaired" one included, gets a higher
// id), so folding only `id > lastId` on top of the cached state equals the
// full scan.
//
// Validation on every call (indexed point reads, no scan):
//   - the last row `step` accepted is gone ⇒ the session was deleted or wiped
//     (tests reuse a SID): drop the entry;
//   - `max(id)` fell below `lastId` ⇒ a suffix was deleted: drop the entry.
// A path deleting/updating a usage/turn_usage/bg_task row anywhere else
// (rollback) must call `invalidateSessionRowCaches(id)` (I11). A fold must not
// run inside a transaction that may roll back (none does today).
//
// The scan reads EVENT rows only: `idx_…_snapshot_lookup` = (session_id,
// role, snapshot_file_path, snapshot_phase, id), whose snapshot columns are
// NULL on every non-edit row (messageWire.ts § deriveMessageStorage), so the
// equality prefix + `id` range seeks them in id order. Walking (session_id, id)
// instead read every tool_result/edit_snapshot row of the span from disk
// (hundreds of MB in a heavy session) just to test its role.
//
// Work is CHUNKED by event rows (CHUNK_EVENT_ROWS, bounded by an index-only
// seek: one SQLite call never walks an unbounded run of non-matching rows). A
// TOLERANT fold (`sliceRows`) does at most one slice in the caller's tick —
// `sliceRows` event rows and FOLD_SLICE_MS of work — answers `complete:false`,
// and ONE background chain per (key, session) finishes it; a tolerant call
// finding that chain running answers at once. Every chain runs from ONE
// shared pump (≤ PUMP_BUDGET_MS of slices per event-loop turn, round-robin):
// N cold sessions (a hub boot) never queue N slices into one check phase.
// Entries untouched for ROW_CACHE_IDLE_EVICT_MS are evicted by one `unref`
// 60 s sweeper; an evicted entry simply re-folds.
//
// All state lives on `globalThis.__charonRowCaches` (module copies, §14.106):
// every copy shares entries, chains, the pump and the prepared statements
// (bound to the shared handle).

export type FoldKey = 'tokens' | 'recorded' | 'bg';

export type FoldRow = { id: number; content: string; createdAt: number; seq: number | null; tsMs: number | null };

export type FoldOptions<T> = {
  /** `content LIKE` patterns, OR-ed (role is always `event`). */
  likes: string[];
  init: () => T;
  /** Deep enough that a caller (a broadcast) never aliases the accumulator. */
  clone: (s: T) => T;
  /** Applies one row in id order; true = the row counted (it becomes the
   *  validation anchor `lastHitId`). */
  step: (s: T, row: FoldRow) => boolean;
  /** TOLERANT: at most this many EVENT rows (and FOLD_SLICE_MS) per slice,
   *  the rest in the background. Undefined = STRICT: to the end, now. */
  sliceRows?: number;
  /** Called once when a sliced fold finishes in the background. */
  onComplete?: (state: T) => void;
};

/** Event rows read per SQLite call. */
export const CHUNK_EVENT_ROWS = 256;
/** Work one tolerant slice may do (checked between chunks). */
export const FOLD_SLICE_MS = 8;
/** Slices the shared pump runs per event-loop turn. */
export const PUMP_BUDGET_MS = 12;
/** Event rows per tolerant slice (the three folds' default). */
export const FOLD_SLICE_EVENT_ROWS = 4_096;

type Entry = {
  state: unknown;
  /** Every row of the session with id ≤ lastId has been folded. */
  lastId: number;
  /** Id of the last row `step` accepted (validation anchor). */
  lastHitId: number | null;
  touchedAt: number;
};

type Statements = {
  handle: Database.Database;
  maxId: Database.Statement;
  hit: Database.Statement;
  chunkEnd: Database.Statement;
  scans: Map<number, Database.Statement>;
};

type Job = { key: FoldKey; chainKey: string; token: number; run: () => boolean };

type RowCaches = {
  byKey: Map<FoldKey, Map<string, Entry>>;
  sweeper: ReturnType<typeof setInterval> | null;
  /** `${key}\0${sessionId}` → token of the live continuation chain. */
  chains: Map<string, number>;
  nextChain: number;
  /** The background chains' next slices, round-robin (one pump). */
  jobs: Job[];
  pumping: boolean;
  statements: Statements | null;
  stats: RowCacheStats;
};

export type RowCacheStats = {
  /** Rows returned by the incremental scans (matched rows, all keys). */
  rowsScanned: number;
  slices: number;
  dropped: number;
  evicted: number;
};

/** Idle time before an entry is dropped. Every resync and summary publish
 *  reads each non-archived session's registry, so this only frees sessions
 *  nobody looked at for hours (archive/delete free theirs at once). */
export const ROW_CACHE_IDLE_EVICT_MS = 6 * 3_600_000;
const SWEEP_EVERY_MS = 60_000;

const EVENT_ROWS = `session_id = ? AND role = 'event' AND snapshot_file_path IS NULL AND snapshot_phase IS NULL`;
const EVENT_INDEX = 'idx_session_messages_snapshot_lookup';

const g = globalThis as typeof globalThis & { __charonRowCaches?: RowCaches };

function caches(): RowCaches {
  const c = g.__charonRowCaches ??= {
    byKey: new Map(),
    sweeper: null,
    chains: new Map(),
    nextChain: 0,
    jobs: [],
    pumping: false,
    statements: null,
    stats: { rowsScanned: 0, slices: 0, dropped: 0, evicted: 0 },
  };
  c.jobs ??= [];
  c.pumping ??= false;
  return c;
}

// Prepared lazily (nothing needs the schema at import time, §14.69). A new
// handle (another DB) also invalidates every entry.
function statements(c: RowCaches): Statements {
  const handle = rawSqlite();
  if (c.statements?.handle === handle) return c.statements;
  for (const m of c.byKey.values()) m.clear();
  c.chains.clear();
  c.jobs.length = 0;
  c.statements = {
    handle,
    // idx_…_session_id_id, covering.
    maxId: handle.prepare('SELECT max(id) AS m FROM session_messages WHERE session_id = ?'),
    hit: handle.prepare('SELECT 1 AS one FROM session_messages WHERE id = ? AND session_id = ?'),
    // Index-only seek: the id of the Nth event row past lastId.
    chunkEnd: handle.prepare(
      `SELECT id FROM session_messages INDEXED BY ${EVENT_INDEX}
        WHERE ${EVENT_ROWS} AND id > ? ORDER BY id LIMIT 1 OFFSET ?`),
    scans: new Map(),
  };
  return c.statements;
}

function scanStatement(s: Statements, likes: number): Database.Statement {
  let st = s.scans.get(likes);
  if (!st) {
    const like = Array.from({ length: likes }, () => 'content LIKE ?').join(' OR ');
    // PINNED to the event-row index (header): under real statistics the
    // planner may pick the table's rowid range (every session's rows below
    // `hi`) or (session_id, id) (every role of the span).
    st = s.handle.prepare(
      `SELECT id, content, created_at AS createdAt, seq, ts_ms AS tsMs
        FROM session_messages INDEXED BY ${EVENT_INDEX}
        WHERE ${EVENT_ROWS} AND id > ? AND id <= ? AND (${like}) ORDER BY id`);
    s.scans.set(likes, st);
  }
  return st;
}

function keyMap(c: RowCaches, key: FoldKey): Map<string, Entry> {
  let m = c.byKey.get(key);
  if (!m) c.byKey.set(key, m = new Map());
  return m;
}

function ensureSweeper(c: RowCaches): void {
  if (c.sweeper) return;
  c.sweeper = setInterval(() => { sweepSessionRowCaches(); }, SWEEP_EVERY_MS);
  c.sweeper.unref?.();
}

function stopSweeper(c: RowCaches): void {
  if (c.sweeper) clearInterval(c.sweeper);
  c.sweeper = null;
}

/** The validated entry (a fresh one when absent or invalid) + max(id). */
function entryFor<T>(c: RowCaches, s: Statements, key: FoldKey, sessionId: string, opts: FoldOptions<T>): { entry: Entry; maxId: number } {
  const map = keyMap(c, key);
  let entry = map.get(sessionId);
  if (entry && entry.lastHitId != null && !s.hit.get(entry.lastHitId, sessionId)) {
    map.delete(sessionId);
    c.stats.dropped++;
    entry = undefined;
  }
  const maxId = (s.maxId.get(sessionId) as { m: number | null } | undefined)?.m ?? 0;
  if (entry && maxId < entry.lastId) {
    map.delete(sessionId);
    c.stats.dropped++;
    entry = undefined;
  }
  if (!entry) {
    entry = { state: opts.init(), lastId: 0, lastHitId: null, touchedAt: Date.now() };
    map.set(sessionId, entry);
    ensureSweeper(c);
  }
  entry.touchedAt = Date.now();
  return { entry, maxId };
}

/** Validate, then fold one slice (TOLERANT) or to the end (STRICT). */
function advance<T>(c: RowCaches, key: FoldKey, sessionId: string, opts: FoldOptions<T>): { entry: Entry; complete: boolean } {
  const s = statements(c);
  const { entry, maxId } = entryFor(c, s, key, sessionId, opts);
  if (maxId <= entry.lastId) return { entry, complete: true };
  const tolerant = opts.sliceRows != null && opts.sliceRows > 0;
  const sliceRows = tolerant ? opts.sliceRows! : Infinity;
  const started = performance.now();
  const scan = scanStatement(s, opts.likes.length);
  const state = entry.state as T;
  let eventRows = 0;
  while (entry.lastId < maxId) {
    const n = Math.min(CHUNK_EVENT_ROWS, sliceRows - eventRows);
    const end = s.chunkEnd.get(sessionId, entry.lastId, n - 1) as { id: number } | undefined;
    const hi = end && end.id < maxId ? end.id : maxId;
    // `.all()` before any `step`: a failing read leaves the entry untouched.
    const rows = scan.all(sessionId, entry.lastId, hi, ...opts.likes) as FoldRow[];
    let lastHitId = entry.lastHitId;
    try {
      for (const row of rows) if (opts.step(state, row)) lastHitId = row.id;
    } catch (e) {
      // A half-applied chunk cannot be resumed exactly: start over next time.
      keyMap(c, key).delete(sessionId);
      throw e;
    }
    entry.lastHitId = lastHitId;
    entry.lastId = hi;
    c.stats.rowsScanned += rows.length;
    eventRows += n;
    if (tolerant && (eventRows >= sliceRows || performance.now() - started >= FOLD_SLICE_MS)) break;
  }
  c.stats.slices++;
  return { entry, complete: entry.lastId >= maxId };
}

function pump(): void {
  const c = caches();
  const started = performance.now();
  while (c.jobs.length && performance.now() - started < PUMP_BUDGET_MS) {
    const job = c.jobs.shift()!;
    // Invalidated (or replaced by a newer chain) meanwhile: dropped.
    if (c.chains.get(job.chainKey) !== job.token) continue;
    if (!timeSection(`fold:${job.key}`, job.run)) c.jobs.push(job);
  }
  // NOT unref'd: an unref'd immediate leaves libuv's poll phase free to
  // block, so each slice would wait for an unrelated wake-up. The queue is
  // finite (a chain ends when its fold completes or is invalidated).
  if (c.jobs.length) setImmediate(pump);
  else c.pumping = false;
}

function continueInBackground<T>(c: RowCaches, key: FoldKey, sessionId: string, opts: FoldOptions<T>): void {
  const chainKey = `${key}\u0000${sessionId}`;
  if (c.chains.has(chainKey)) return;
  const token = ++c.nextChain;
  c.chains.set(chainKey, token);
  const sliced: FoldOptions<T> = { ...opts, sliceRows: opts.sliceRows ?? FOLD_SLICE_EVENT_ROWS };
  // One slice; true = the chain is over.
  const run = (): boolean => {
    const cur = caches();
    if (!cur.byKey.get(key)?.has(sessionId)) { cur.chains.delete(chainKey); return true; }
    let res: { entry: Entry; complete: boolean };
    try {
      res = advance(cur, key, sessionId, sliced);
    } catch (e) {
      cur.chains.delete(chainKey);
      console.warn(`[rowcache] ${key} fold of ${sessionId} failed: ${(e as Error)?.message ?? e}`);
      return true;
    }
    if (!res.complete) return false;
    cur.chains.delete(chainKey);
    try { opts.onComplete?.(opts.clone(res.entry.state as T)); } catch (e) {
      console.warn(`[rowcache] ${key} completion of ${sessionId} failed: ${(e as Error)?.message ?? e}`);
    }
    return true;
  };
  c.jobs.push({ key, chainKey, token, run });
  if (!c.pumping) {
    c.pumping = true;
    setImmediate(pump);
  }
}

/** The session's fold for `key`, brought up to date. `complete:false` = a cold
 *  sliced fold still warming (a background chain finishes it, then calls
 *  `onComplete`); the state is then partial and must not be shown as totals. */
export function foldSessionEventRows<T>(key: FoldKey, sessionId: string, opts: FoldOptions<T>): { state: T; complete: boolean } {
  return timeSection(`fold:${key}`, () => {
    const c = caches();
    if (opts.sliceRows != null && c.chains.has(`${key}\u0000${sessionId}`)) {
      // Warming already: the pump owns the pace, nothing is folded in this
      // tick. A strict read may have finished it meanwhile (the chain still
      // owes its onComplete): then it is complete.
      const { entry, maxId } = entryFor(c, statements(c), key, sessionId, opts);
      return { state: opts.clone(entry.state as T), complete: entry.lastId >= maxId };
    }
    const { entry, complete } = advance(c, key, sessionId, opts);
    if (!complete) continueInBackground(c, key, sessionId, opts);
    return { state: opts.clone(entry.state as T), complete };
  });
}

/** Warm the fold in the background, nothing folded in the caller's tick
 *  (boot: every live session's folds, paced by the pump). No-op when warm or
 *  already warming. */
export function warmSessionEventRows<T>(key: FoldKey, sessionId: string, opts: FoldOptions<T>): void {
  const c = caches();
  if (c.chains.has(`${key}\u0000${sessionId}`)) return;
  const { entry, maxId } = entryFor(c, statements(c), key, sessionId, opts);
  if (maxId > entry.lastId) continueInBackground(c, key, sessionId, opts);
}

/** Drop a session's entries (every key), or every entry when no id is given.
 *  Owed by every path that deletes/updates a usage, turn_usage or bg_task row
 *  (I11); archive and delete free the memory. */
export function invalidateSessionRowCaches(sessionId?: string): void {
  const c = caches();
  if (sessionId == null) {
    for (const m of c.byKey.values()) m.clear();
    c.chains.clear();
    c.jobs.length = 0;
    stopSweeper(c);
    return;
  }
  for (const [key, m] of c.byKey) {
    m.delete(sessionId);
    c.chains.delete(`${key}\u0000${sessionId}`);
  }
}

/** Evict entries untouched for ROW_CACHE_IDLE_EVICT_MS (the sweeper's tick).
 *  Returns how many. */
export function sweepSessionRowCaches(now = Date.now()): number {
  const c = caches();
  let evicted = 0;
  let left = 0;
  for (const [key, m] of c.byKey) {
    for (const [sessionId, entry] of m) {
      if (now - entry.touchedAt >= ROW_CACHE_IDLE_EVICT_MS) {
        m.delete(sessionId);
        c.chains.delete(`${key}\u0000${sessionId}`);
        evicted++;
      } else left++;
    }
  }
  c.stats.evicted += evicted;
  if (left === 0) stopSweeper(c);
  return evicted;
}

/** Observability (tests, perf): counters and live entry count. */
export function sessionRowCacheStats(): RowCacheStats & { entries: number; chains: number; sweeping: boolean } {
  const c = caches();
  let entries = 0;
  for (const m of c.byKey.values()) entries += m.size;
  return { ...c.stats, entries, chains: c.chains.size, sweeping: c.sweeper != null };
}
