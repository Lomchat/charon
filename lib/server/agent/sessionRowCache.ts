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
// A cold fold of a huge session is SLICED (`sliceRows` session rows per
// synchronous slice, G1): the caller gets `complete:false`, and ONE
// `setImmediate` chain per (key, session) finishes it in the background, then
// calls `onComplete`. Entries untouched for 30 min are evicted by one `unref`
// 60 s sweeper; an evicted entry simply re-folds on next use.
//
// All state lives on `globalThis.__charonRowCaches` (Next loads server
// modules in several copies, §14.106): every copy shares entries, chains and
// the prepared statements (bound to the shared handle).

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
  /** Cold-fold slicing; undefined = synchronous to the end. */
  sliceRows?: number;
  /** Called once when a sliced fold finishes in the background. */
  onComplete?: (state: T) => void;
};

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
  sliceEnd: Database.Statement;
  scans: Map<number, Database.Statement>;
};

type RowCaches = {
  byKey: Map<FoldKey, Map<string, Entry>>;
  sweeper: ReturnType<typeof setInterval> | null;
  /** `${key}\0${sessionId}` → token of the live continuation chain. */
  chains: Map<string, number>;
  nextChain: number;
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

export const ROW_CACHE_IDLE_EVICT_MS = 30 * 60_000;
const SWEEP_EVERY_MS = 60_000;

const g = globalThis as typeof globalThis & { __charonRowCaches?: RowCaches };

function caches(): RowCaches {
  return g.__charonRowCaches ??= {
    byKey: new Map(),
    sweeper: null,
    chains: new Map(),
    nextChain: 0,
    statements: null,
    stats: { rowsScanned: 0, slices: 0, dropped: 0, evicted: 0 },
  };
}

// Prepared lazily: during `next build` the DB is `:memory:` without tables
// (§14.69). A new handle (another DB) also invalidates every entry.
function statements(c: RowCaches): Statements {
  const handle = rawSqlite();
  if (c.statements?.handle === handle) return c.statements;
  for (const m of c.byKey.values()) m.clear();
  c.chains.clear();
  c.statements = {
    handle,
    // idx_…_session_id_id, covering.
    maxId: handle.prepare('SELECT max(id) AS m FROM session_messages WHERE session_id = ?'),
    hit: handle.prepare('SELECT 1 AS one FROM session_messages WHERE id = ? AND session_id = ?'),
    // Index-only seek: the id `sliceRows` rows past lastId.
    sliceEnd: handle.prepare(
      'SELECT id FROM session_messages WHERE session_id = ? AND id > ? ORDER BY id LIMIT 1 OFFSET ?'),
    scans: new Map(),
  };
  return c.statements;
}

function scanStatement(s: Statements, likes: number): Database.Statement {
  let st = s.scans.get(likes);
  if (!st) {
    const like = Array.from({ length: likes }, () => 'content LIKE ?').join(' OR ');
    // The plan is PINNED to idx_…_session_id_id (session_id=? AND id range):
    // the slice bound is a session-row count only on that index. Under real
    // statistics the planner may pick the table's rowid range instead, which
    // walks EVERY session's rows below `hi` (a cold fold read the whole
    // table), or (session_id, role) (idx_…_snapshot_lookup: every event row
    // of a reasoning-heavy session; `+role` keeps it out too).
    st = s.handle.prepare(
      `SELECT id, content, created_at AS createdAt, seq, ts_ms AS tsMs
        FROM session_messages INDEXED BY idx_session_messages_session_id_id
        WHERE session_id = ? AND id > ? AND id <= ? AND +role = 'event' AND (${like}) ORDER BY id`);
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

/** Validate, then fold at most one slice. */
function advance<T>(c: RowCaches, key: FoldKey, sessionId: string, opts: FoldOptions<T>): { entry: Entry; complete: boolean } {
  const s = statements(c);
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
  if (maxId <= entry.lastId) return { entry, complete: true };
  let hi = maxId;
  if (opts.sliceRows != null && opts.sliceRows > 0) {
    const end = s.sliceEnd.get(sessionId, entry.lastId, opts.sliceRows - 1) as { id: number } | undefined;
    if (end && end.id < maxId) hi = end.id;
  }
  // `.all()` before any `step`: a failing read leaves the entry untouched.
  const rows = scanStatement(s, opts.likes.length).all(sessionId, entry.lastId, hi, ...opts.likes) as FoldRow[];
  const state = entry.state as T;
  let lastHitId = entry.lastHitId;
  try {
    for (const row of rows) if (opts.step(state, row)) lastHitId = row.id;
  } catch (e) {
    // A half-applied slice cannot be resumed exactly: start over next time.
    map.delete(sessionId);
    throw e;
  }
  entry.lastHitId = lastHitId;
  entry.lastId = hi;
  c.stats.rowsScanned += rows.length;
  c.stats.slices++;
  return { entry, complete: hi >= maxId };
}

function continueInBackground<T>(c: RowCaches, key: FoldKey, sessionId: string, opts: FoldOptions<T>): void {
  const chainKey = `${key}\u0000${sessionId}`;
  if (c.chains.has(chainKey)) return;
  const token = ++c.nextChain;
  c.chains.set(chainKey, token);
  const run = (): void => {
    const cur = caches();
    // Invalidated (or replaced by a newer chain) meanwhile: stop.
    if (cur.chains.get(chainKey) !== token) return;
    if (!cur.byKey.get(key)?.has(sessionId)) { cur.chains.delete(chainKey); return; }
    let res: { entry: Entry; complete: boolean };
    try {
      res = timeSection(`fold:${key}`, () => advance(cur, key, sessionId, opts));
    } catch (e) {
      cur.chains.delete(chainKey);
      console.warn(`[rowcache] ${key} fold of ${sessionId} failed: ${(e as Error)?.message ?? e}`);
      return;
    }
    if (!res.complete) { setImmediate(run); return; }
    cur.chains.delete(chainKey);
    try { opts.onComplete?.(opts.clone(res.entry.state as T)); } catch (e) {
      console.warn(`[rowcache] ${key} completion of ${sessionId} failed: ${(e as Error)?.message ?? e}`);
    }
  };
  // NOT unref'd: an unref'd immediate leaves libuv's poll phase free to
  // block, so each slice would wait for an unrelated wake-up. The chain is
  // short (ends when the fold completes or is invalidated).
  setImmediate(run);
}

/** The session's fold for `key`, brought up to date. `complete:false` = a cold
 *  sliced fold still warming (a background chain finishes it, then calls
 *  `onComplete`); the state is then partial and must not be shown as totals. */
export function foldSessionEventRows<T>(key: FoldKey, sessionId: string, opts: FoldOptions<T>): { state: T; complete: boolean } {
  return timeSection(`fold:${key}`, () => {
    const c = caches();
    const { entry, complete } = advance(c, key, sessionId, opts);
    if (!complete) continueInBackground(c, key, sessionId, opts);
    return { state: opts.clone(entry.state as T), complete };
  });
}

/** Drop a session's entries (every key), or every entry when no id is given.
 *  Owed by every path that deletes/updates a usage, turn_usage or bg_task row
 *  (I11); archive and delete free the memory. */
export function invalidateSessionRowCaches(sessionId?: string): void {
  const c = caches();
  if (sessionId == null) {
    for (const m of c.byKey.values()) m.clear();
    c.chains.clear();
    stopSweeper(c);
    return;
  }
  for (const [key, m] of c.byKey) {
    m.delete(sessionId);
    c.chains.delete(`${key}\u0000${sessionId}`);
  }
}

/** Evict entries untouched for 30 min (the sweeper's tick). Returns how many. */
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
