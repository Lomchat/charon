#!/usr/bin/env node
// OFFLINE maintenance of the hub database (CLAUDE.md §14.109; runbook: sync
// refonte SPEC §10 R2/M). Operator tool — never run by the hub, the build or
// a migration (the build migrates the LIVE DB, §14.69/§3).
//
//   node scripts/compact-thinking.mjs --db <path> [--dry-run] [--session <id>] [--report <f.json>] [--timings]
//   node scripts/compact-thinking.mjs --db <path> --offline --backup-to <file> [--no-check]
//   node scripts/compact-thinking.mjs --db <path> --offline --apply [--verify] [--batch <n>] [--session <id>] [--report <f.json>]
//   node scripts/compact-thinking.mjs --db <path> --offline --vacuum [--no-analyze]
//
// What it does: merges a delta provider's per-token reasoning rows (one
// `event` row per Codex/Cursor delta, written before the hub coalesced them)
// into their first row — rules in scripts/lib/thinkingCompaction.mjs — then
// lets the operator VACUUM. Rendering is unchanged; replay identity of every
// event above `last_seen_seq` is untouched.
//
// Why offline only: the hub writes through ONE synchronous connection with a
// 5 s busy handler on its event loop, so any external writer stalls it, and
// the "≤ cursor" rule is racy while the hub advances the cursor. Every
// writing mode therefore needs `--offline`: `PRAGMA locking_mode=EXCLUSIVE`
// plus a `BEGIN EXCLUSIVE` probe that fails while ANY other process has the
// database open, and the lock is then held until `close()`.
//
// INVARIANT: this process never opens the database file through `fs` (stat
// is fine). SQLite's locks are POSIX record locks: closing ANY descriptor of
// the inode drops every lock the process holds on it — SQLite tracks only its
// own descriptors — and the connection, still believing it is EXCLUSIVE with
// a heap WAL index, would delete another process's fresh -wal at `close()`.
// The backup's byte copy and hashes run in a child process (BYTE_COPY_CHILD).
//
// Node 20 + better-sqlite3 directly: no lib/db, no `server-only`, no `.env`
// (`--db` is required). better-sqlite3 is loaded lazily, AFTER
// `SQLITE_TMPDIR` is set for `--vacuum` (SQLite reads it at initialization).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_CHARS, DELTA_KINDS, createRunPlanner, mergeableThinkingText, mergedThinkingContent,
} from './lib/thinkingCompaction.mjs';

/** Rows read per keyset page of the chronological index. */
export const PAGE_ROWS = 20_000;
/** Deleted rows per write transaction (an op is never split across two). */
export const DEFAULT_BATCH = 50_000;
/** `wal_checkpoint(TRUNCATE)` after every N committed batches. */
export const CHECKPOINT_EVERY = 10;
/** Ids per DELETE statement (below SQLite's common 999-variable ceiling). */
const DELETE_CHUNK = 900;

export const USAGE = `Usage: node scripts/compact-thinking.mjs --db <path> [mode] [options]

Modes (one per run; default --dry-run):
  --dry-run                       plan + per-session counts; writes nothing
  --offline --backup-to <file>    byte-exact copy: checkpoint(TRUNCATE) to an empty WAL, copy to
                                  <file>.part, chmod 600, fsync, sha256 of both, link (never over a
                                  file), quick_check
  --offline --apply               merge consecutive delta-provider thinking rows (<= last_seen_seq);
                                  Ctrl-C stops after the current batch (rerun to resume)
  --offline --vacuum              checkpoint, conversation index, ANALYZE, VACUUM, checkpoint, quick_check,
                                  foreign_key_check, FTS integrity-check (temp files: <db dir>/tmp)
                                  (writing modes fail only on foreign-key violations they ADDED;
                                  pre-existing ones are reported and left alone)
Options:
  --db <path>        REQUIRED (never read from .env)
  --offline          required by every writing mode: the EXCLUSIVE lock probe must succeed
                     (the hub, its autodeploy and every other reader stopped)
  --verify           (--apply) re-read every merge: kept text == concatenation, no row left in the run
  --session <id>     (--dry-run/--apply) restrict to one session
  --batch <n>        (--apply) deleted rows per transaction (default ${DEFAULT_BATCH})
  --report <f.json>  write counts, durations and per-session before/after to a NEW file (never
                     the database, its side files or the backup: refused before any work)
  --no-check         (--backup-to) skip the quick_check of the copy
  --no-analyze       (--vacuum) keep the existing sqlite_stat* (no ANALYZE)
  --timings          print the wall time of every phase
Exit codes: 0 done, 1 refused or failed (nothing half-applied: batches are atomic), 2 usage.`;

export class UsageError extends Error {}
/** A precondition the operator must fix (probe, WAL, existing file…): exit 1. */
export class RefusedError extends Error {}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ db: string | null, dryRun: boolean, offline: boolean, apply: boolean, verify: boolean,
   *  session: string | null, batch: number, report: string | null, backupTo: string | null, noCheck: boolean,
   *  vacuum: boolean, noAnalyze: boolean, timings: boolean, help: boolean,
   *  mode: 'dry-run' | 'apply' | 'backup' | 'vacuum' }} */
  const o = {
    db: null, dryRun: false, offline: false, apply: false, verify: false, session: null, batch: DEFAULT_BATCH,
    report: null, backupTo: null, noCheck: false, vacuum: false, noAnalyze: false, timings: false, help: false,
    mode: 'dry-run',
  };
  let batchGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--db': o.db = value(); break;
      case '--dry-run': o.dryRun = true; break;
      case '--offline': o.offline = true; break;
      case '--apply': o.apply = true; break;
      case '--verify': o.verify = true; break;
      case '--session': o.session = value(); break;
      case '--batch': {
        const raw = value();
        const n = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new UsageError(`--batch needs a positive integer, got ${raw}`);
        o.batch = n;
        batchGiven = true;
        break;
      }
      case '--report': o.report = value(); break;
      case '--backup-to': o.backupTo = value(); break;
      case '--no-check': o.noCheck = true; break;
      case '--vacuum': o.vacuum = true; break;
      case '--no-analyze': o.noAnalyze = true; break;
      case '--timings': o.timings = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new UsageError(`unknown argument ${arg}`);
    }
  }
  if (o.help) return o;
  if (!o.db) throw new UsageError('--db <path> is required (this script never reads .env)');
  const writing = [o.apply && '--apply', o.backupTo != null && '--backup-to', o.vacuum && '--vacuum'].filter(Boolean);
  if (writing.length > 1) throw new UsageError(`one maintenance step per run: ${writing.join(' + ')}`);
  if (o.dryRun && writing.length) throw new UsageError(`--dry-run writes nothing: drop ${writing[0]}`);
  if (writing.length && !o.offline) {
    throw new UsageError(`${writing[0]} requires --offline (hub masked and stopped, autodeploy stopped — CLAUDE.md §14.109)`);
  }
  if (o.offline && !writing.length) throw new UsageError('--offline only applies to --apply, --backup-to or --vacuum');
  if (o.verify && !o.apply) throw new UsageError('--verify only applies to --apply');
  if (batchGiven && !o.apply) throw new UsageError('--batch only applies to --apply');
  if (o.session != null && (o.backupTo != null || o.vacuum)) throw new UsageError('--session only applies to --dry-run/--apply');
  if (o.noCheck && o.backupTo == null) throw new UsageError('--no-check only applies to --backup-to');
  if (o.noAnalyze && !o.vacuum) throw new UsageError('--no-analyze only applies to --vacuum');
  o.mode = o.apply ? 'apply' : o.backupTo != null ? 'backup' : o.vacuum ? 'vacuum' : 'dry-run';
  return o;
}

/** Wall-time recorder for `--timings` and the report. */
export function createTimer({ print = false, log = console.log } = {}) {
  /** @type {Array<{ label: string, ms: number }>} */
  const phases = [];
  const record = (/** @type {string} */ label, /** @type {number} */ ms) => {
    const rounded = Math.round(ms * 10) / 10;
    phases.push({ label, ms: rounded });
    if (print) log(`[timing] ${label} ${rounded} ms`);
  };
  const done = (/** @type {string} */ label, /** @type {number} */ t0) => record(label, performance.now() - t0);
  return {
    phases,
    record,
    /** @template T @param {string} label @param {() => T} fn @returns {T} */
    time(label, fn) {
      const t0 = performance.now();
      try { return fn(); } finally { done(label, t0); }
    },
    /** @template T @param {string} label @param {() => Promise<T>} fn @returns {Promise<T>} */
    async timeAsync(label, fn) {
      const t0 = performance.now();
      try { return await fn(); } finally { done(label, t0); }
    },
  };
}

// ─── Opening ───────────────────────────────────────────────────────────────

/** Read-only handle for `--dry-run` (never writes the main file). */
export function openReadOnly(Database, dbPath) {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * Exclusive handle for the writing modes. `locking_mode=EXCLUSIVE` is set
 * before the first access (WAL index in heap memory, no -shm use); the
 * `BEGIN EXCLUSIVE` probe, with no busy wait, fails while any other process
 * has the database open, and the lock is then held until `close()` — provided
 * this process never opens the file through `fs` (header INVARIANT).
 */
export function openOffline(Database, dbPath) {
  const db = new Database(dbPath, { fileMustExist: true, timeout: 0 });
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
  } catch (e) {
    try { db.close(); } catch { /* already failing */ }
    throw new RefusedError(`--offline probe failed on ${dbPath} (${errorText(e)}): another process has the database `
      + 'open — mask and stop the hub, stop charon-autodeploy, close every sqlite3 reader (runbook §10 M step 2)');
  }
  db.pragma('foreign_keys = ON');
  return db;
}

/** `wal_checkpoint(TRUNCATE)`; `busy` must be 0 (holding the exclusive lock, it is). */
export function checkpointTruncate(db) {
  const [row] = db.pragma('wal_checkpoint(TRUNCATE)');
  return row ?? { busy: 0, log: -1, checkpointed: -1 };
}

function walBytes(dbPath) {
  try { return fs.statSync(dbPath + '-wal').size; } catch { return 0; }
}

/**
 * `PRAGMA foreign_key_check`, grouped by (child table, parent table, fk id).
 * A database can carry violations no maintenance step created (prod: rows
 * of sessions deleted without the cascade, long ago): the writing modes take
 * this baseline BEFORE any write and fail only on violations the run added.
 * Grouped COUNTS, not rowids: VACUUM may renumber the rowids of a table
 * without an INTEGER PRIMARY KEY, which would make an old orphan look new.
 * Pre-existing violations are reported, never deleted.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<string, { table: string, parent: string, fkid: number, rowids: Array<number | null> }>}
 */
export function foreignKeyViolations(db) {
  const groups = new Map();
  for (const v of /** @type {Array<{ table: string, rowid: number | null, parent: string, fkid: number }>} */ (
    db.pragma('foreign_key_check'))) {
    const key = `${v.table}\u0000${v.parent}\u0000${v.fkid}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { table: v.table, parent: v.parent, fkid: v.fkid, rowids: [] });
    g.rowids.push(v.rowid);
  }
  return groups;
}

/** Total violations of a `foreignKeyViolations` map. */
export function violationCount(groups) {
  let n = 0;
  for (const g of groups.values()) n += g.rowids.length;
  return n;
}

/** The groups that grew since `before`: what this run created. */
export function newForeignKeyViolations(before, after) {
  const grown = [];
  for (const [key, g] of after) {
    const had = before.get(key)?.rowids.length ?? 0;
    if (g.rowids.length > had) {
      const old = new Set(before.get(key)?.rowids ?? []);
      grown.push({ table: g.table, parent: g.parent, fkid: g.fkid, before: had, after: g.rowids.length,
        rowids: g.rowids.filter((r) => !old.has(r)).slice(0, 10) });
    }
  }
  return grown;
}

/** One line per group: `session_messages → agent_sessions ×6 (rowids 393, 394, …)`. */
export function describeViolations(groups) {
  return [...groups.values()].map((g) => `${g.table} → ${g.parent} ×${g.rowids.length}`
    + ` (rowids ${g.rowids.slice(0, 10).join(', ')}${g.rowids.length > 10 ? ', …' : ''})`).join('; ');
}

/** Throws when the run added violations; logs the pre-existing ones. */
function checkForeignKeys(before, after, log) {
  const grown = newForeignKeyViolations(before, after);
  if (grown.length) {
    throw new Error(`foreign_key_check: ${grown.reduce((n, g) => n + g.after - g.before, 0)} NEW violations `
      + `(${violationCount(before)} pre-existing), first ${JSON.stringify(grown[0])}`);
  }
  const old = violationCount(after);
  if (old) log(`warning: foreign_key_check: ${old} pre-existing violations, left untouched: ${describeViolations(after)}`);
  return old;
}

function errorText(e) {
  return e instanceof Error ? e.message : String(e);
}

// ─── Compaction ────────────────────────────────────────────────────────────

const CHRONO = 'coalesce(ts_ms, created_at * 1000)';

/** The keyset page over `idx_session_messages_session_chrono_id`. The
 *  redundant `>= @k` bound keeps it ONE index range (an OR alone plans as
 *  MULTI-INDEX OR + TEMP B-TREE, C03 §1). */
export const PAGE_SQL = `SELECT id, role, seq, ts_ms, created_at, wire_content IS NULL AS wnull,
    CASE WHEN role = 'event' THEN content END AS content, ${CHRONO} AS k
  FROM session_messages
  WHERE session_id = @sid AND ${CHRONO} >= @k AND (${CHRONO} > @k OR id > @id)
  ORDER BY ${CHRONO}, id
  LIMIT @limit`;

/** Rows left strictly after the kept row and up to the last deleted one (--verify). */
export const BETWEEN_SQL = `SELECT count(*) AS n FROM session_messages
  WHERE session_id = @sid AND ${CHRONO} >= @k1 AND ${CHRONO} <= @k2
    AND (${CHRONO} > @k1 OR id > @id1) AND (${CHRONO} < @k2 OR id <= @id2)`;

/** Seq of the session's LAST seq-stamped row in rebuild order (a backward
 *  walk of the chrono index; `+seq` keeps the seq index out of the plan). */
export const LATEST_SEQ_SQL = `SELECT seq FROM session_messages
  WHERE session_id = ? AND +seq IS NOT NULL
  ORDER BY ${CHRONO} DESC, id DESC LIMIT 1`;

/** MAX(seq) of the session: one seek on `idx_…_session_seq`. */
export const MAX_SEQ_SQL = 'SELECT max(seq) AS seq FROM session_messages WHERE session_id = ?';

/** One chunk's DELETE: `n` rowid lookups. The unary `+` keeps `session_id`/
 *  `role` out of index selection — under prod statistics a chunk of ≥ 20 ids
 *  planned as (session_id, role) on idx_…_snapshot_lookup, so EVERY chunk
 *  walked the session's whole event prefix (2.9 M entries for the heavy
 *  session: ~1000 s of rehearsal apply, quadratic in the session's size). The
 *  terms still guard each deleted row. @param {number} n */
export const DELETE_SQL = (n) => `DELETE FROM session_messages
  WHERE id IN (${new Array(n).fill('?').join(',')}) AND +session_id = ? AND +role = 'event'`;

function compactionStatements(db) {
  const deletes = new Map();
  return {
    sessions: db.prepare('SELECT id, kind, last_seen_seq AS cursor FROM agent_sessions'),
    session: db.prepare('SELECT id, kind, last_seen_seq AS cursor FROM agent_sessions WHERE id = ?'),
    rowCount: db.prepare('SELECT count(*) AS n FROM session_messages WHERE session_id = ?'),
    nullTs: db.prepare('SELECT 1 AS one FROM session_messages WHERE session_id = ? AND ts_ms IS NULL LIMIT 1'),
    cursor: db.prepare('SELECT last_seen_seq AS cursor FROM agent_sessions WHERE id = ?'),
    latestSeq: db.prepare(LATEST_SEQ_SQL),
    maxSeq: db.prepare(MAX_SEQ_SQL),
    page: db.prepare(PAGE_SQL),
    keep: db.prepare(`SELECT role, content, seq, wire_content IS NULL AS wnull, ${CHRONO} AS k
      FROM session_messages WHERE id = ? AND session_id = ?`),
    between: db.prepare(BETWEEN_SQL),
    update: db.prepare(`UPDATE session_messages SET content = ?
      WHERE id = ? AND session_id = ? AND role = 'event' AND wire_content IS NULL`),
    refsTable: db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'session_scheduled_resumes'"),
    refs: () => db.prepare('SELECT source_message_id AS a, message_id AS b, user_message_id AS c FROM session_scheduled_resumes'),
    /** @param {number} n */
    del(n) {
      let st = deletes.get(n);
      if (!st) {
        st = db.prepare(DELETE_SQL(n));
        deletes.set(n, st);
      }
      return st;
    },
  };
}

/** Every page of one session, in rebuild order. */
function* pages(st, sid, pageRows) {
  let k = Number.MIN_SAFE_INTEGER;
  let id = -1;
  for (;;) {
    const rows = st.page.all({ sid, k, id, limit: pageRows });
    if (!rows.length) return;
    yield rows;
    const last = rows[rows.length - 1];
    k = last.k;
    id = last.id;
    if (rows.length < pageRows) return;
  }
}

/** One event-loop turn. A signal handler (the CLI's SIGINT → `shouldStop`)
 *  runs as an event-loop callback, never between microtasks: a loop that only
 *  `await`s settled promises would swallow Ctrl-C until it ends. */
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A recreated agent log restarts seq at 1 (§14.71) while `last_seen_seq` keeps
 * the old epoch's high value (`_trackSeq` ignores lower seqs), so every row of
 * the new epoch looks "≤ cursor" — yet a reset replays that log from its
 * (possibly rotated) start, and a merged run would be re-inserted from its
 * middle. Signature: the latest seq-stamped row in rebuild order holds less
 * than MAX(seq). Such a session is planned with NO cursor (seq-NULL runs
 * only). A hub-stamped row with a skewed ts at the very end can trip it too:
 * conservative, and logged.
 */
function seqEpochSuspect(st, sid) {
  const latestSeq = st.latestSeq.get(sid)?.seq ?? null;
  const maxSeq = st.maxSeq.get(sid)?.seq ?? null;
  return latestSeq != null && maxSeq != null && latestSeq < maxSeq ? { latestSeq, maxSeq } : null;
}

/** Ids referenced by `session_scheduled_resumes` (FK children: CASCADE / SET NULL). */
function referencedIds(st) {
  const ids = new Set();
  if (!st.refsTable.get()) return ids;
  for (const r of st.refs().all()) for (const v of [r.a, r.b, r.c]) if (v != null) ids.add(v);
  return ids;
}

/**
 * Eligible sessions, largest first. A session with a NULL `ts_ms` row is
 * skipped: the window GET orders it by `created_at*1000`, the legacy delta
 * by a watermark — the two orders could disagree on which rows are adjacent.
 */
function listSessions(st, sessionId) {
  const rows = sessionId != null ? [st.session.get(sessionId)].filter(Boolean) : st.sessions.all();
  if (sessionId != null && !rows.length) throw new RefusedError(`no session ${sessionId}`);
  const eligible = [];
  const skipped = [];
  for (const s of rows) {
    if (!DELTA_KINDS.includes(s.kind)) {
      skipped.push({ id: s.id, kind: s.kind, skipped: 'kind' });
      continue;
    }
    const rowsBefore = st.rowCount.get(s.id).n;
    if (st.nullTs.get(s.id)) {
      skipped.push({ id: s.id, kind: s.kind, rowsBefore, skipped: 'null-ts' });
      continue;
    }
    eligible.push({ id: s.id, kind: s.kind, rowsBefore });
  }
  eligible.sort((a, b) => (b.rowsBefore - a.rowsBefore) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { eligible, skipped };
}

/**
 * Plan (and with `apply`, perform) the compaction of every eligible session
 * on an open handle. `apply` needs a handle no other connection writes to
 * (the CLI's `openOffline`); a dry run only reads, one snapshot per session.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ apply?: boolean, verify?: boolean, sessionId?: string | null, batch?: number,
 *   maxChars?: number, pageRows?: number, log?: (line: string) => void,
 *   timer?: ReturnType<typeof createTimer>, shouldStop?: () => boolean }} [opts]
 */
export async function compactDatabase(db, opts = {}) {
  const apply = !!opts.apply;
  const verify = !!opts.verify;
  const batch = opts.batch ?? DEFAULT_BATCH;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const pageRows = opts.pageRows ?? PAGE_ROWS;
  const log = opts.log ?? (() => {});
  const timer = opts.timer ?? createTimer();
  const shouldStop = opts.shouldStop ?? (() => false);
  const st = compactionStatements(db);
  // `totals.ops/rowsDeleted/verified` count every COMMITTED batch, including
  // those of a session a stop or an error cut short; `totals.sessions/
  // rowsBefore/rowsAfter` count complete sessions only.
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    sessions: /** @type {any[]} */ ([]),
    skipped: /** @type {any[]} */ ([]),
    totals: { sessions: 0, ops: 0, rowsDeleted: 0, rowsBefore: 0, rowsAfter: 0, verified: 0 },
    batches: 0,
    checkpoints: 0,
    stopped: false,
    /** Foreign-key violations found before the run and left untouched (apply). */
    foreignKeyViolationsPreExisting: /** @type {number | null} */ (null),
  };
  // Before any write: the run fails only on foreign-key violations it adds.
  const fkBefore = apply ? timer.time('foreign_key_check', () => foreignKeyViolations(db)) : null;
  const { eligible, skipped } = timer.time('list sessions', () => listSessions(st, opts.sessionId ?? null));
  report.skipped = skipped;
  const otherKinds = skipped.filter((s) => s.skipped === 'kind');
  if (opts.sessionId != null) {
    for (const s of otherKinds) log(`${s.id} ${s.kind}: not a delta provider (${DELTA_KINDS.join('/')}), nothing to compact`);
  } else if (otherKinds.length) {
    log(`${otherKinds.length} sessions of other kinds skipped (only ${DELTA_KINDS.join('/')} stream reasoning deltas)`);
  }
  for (const s of skipped) {
    if (s.skipped === 'null-ts') log(`${s.id} ${s.kind}: SKIPPED, a row has NULL ts_ms (two rebuild orders would disagree)`);
  }

  // Write state: one transaction at a time, never spanning two sessions.
  // `pending` holds the work of the open transaction; it reaches the report
  // only once COMMITTED (a rolled-back batch counts nothing).
  let inTx = false;
  let pending = { ops: 0, deleted: 0, verified: 0 };
  /** @param {{ ops: number, rowsDeleted: number }} entry */
  const commit = (entry) => {
    if (!inTx) return;
    db.exec('COMMIT');
    inTx = false;
    entry.ops += pending.ops;
    entry.rowsDeleted += pending.deleted;
    report.totals.verified += pending.verified;
    pending = { ops: 0, deleted: 0, verified: 0 };
    if (!apply) return;
    report.batches++;
    if (report.batches % CHECKPOINT_EVERY === 0) {
      timer.time('checkpoint', () => checkpointTruncate(db));
      report.checkpoints++;
    }
  };

  for (const s of eligible) {
    // Every session boundary follows a commit: a pending Ctrl-C lands here.
    await yieldToLoop();
    if (shouldStop()) { report.stopped = true; break; }
    const t0 = performance.now();
    const entry = {
      id: s.id, kind: s.kind, cursor: /** @type {number | null} */ (null),
      rowsBefore: 0, rowsAfter: 0, ops: 0, rowsDeleted: 0, ms: 0, complete: false,
      seqEpoch: /** @type {{ latestSeq: number, maxSeq: number } | null} */ (null),
      error: /** @type {string | undefined} */ (undefined),
    };
    report.sessions.push(entry);
    let cursor = /** @type {number | null} */ (null);
    let refs = new Set();
    // The cursor is read inside every transaction; offline it cannot move —
    // if it does, something else writes this database.
    const begin = (/** @type {boolean} */ first) => {
      db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
      inTx = true;
      const now = st.cursor.get(s.id)?.cursor ?? null;
      if (first) cursor = now;
      else if (now !== cursor) throw new RefusedError(`${s.id}: last_seen_seq moved ${cursor} → ${now} during the run — is the hub running?`);
      if (apply) refs = referencedIds(st);
    };
    /** @param {import('./lib/thinkingCompaction.mjs').CompactionOp} op */
    const applyOp = (op) => {
      for (const id of op.deleteIds) {
        if (refs.has(id)) throw new Error(`${s.id}: row ${id} is referenced by session_scheduled_resumes — refusing to delete it`);
      }
      const u = st.update.run(mergedThinkingContent(op.text), op.keepId, s.id);
      if (u.changes !== 1) throw new Error(`${s.id}: UPDATE of row ${op.keepId} changed ${u.changes} rows`);
      for (let i = 0; i < op.deleteIds.length; i += DELETE_CHUNK) {
        const chunk = op.deleteIds.slice(i, i + DELETE_CHUNK);
        const d = st.del(chunk.length).run(...chunk, s.id);
        if (d.changes !== chunk.length) {
          throw new Error(`${s.id}: DELETE of ${chunk.length} rows after ${op.keepId} changed ${d.changes}`);
        }
      }
      if (verify) {
        const kept = st.keep.get(op.keepId, s.id);
        if (!kept || mergeableThinkingText(kept) !== op.text || kept.seq !== op.keepSeq || kept.k !== op.keepKey) {
          throw new Error(`${s.id}: --verify: row ${op.keepId} does not hold the merged run`);
        }
        const left = st.between.get({ sid: s.id, k1: op.keepKey, id1: op.keepId, k2: op.lastKey, id2: op.lastId }).n;
        if (left !== 0) throw new Error(`${s.id}: --verify: ${left} rows remain between ${op.keepId} and ${op.lastId}`);
        pending.verified++;
      }
    };
    /** @param {import('./lib/thinkingCompaction.mjs').CompactionOp[]} ops @returns {Promise<boolean>} false = stop */
    const take = async (ops) => {
      for (const op of ops) {
        if (apply) applyOp(op);
        pending.ops++;
        pending.deleted += op.deleteIds.length;
        if (apply && pending.deleted >= batch) {
          commit(entry);
          if (report.batches % CHECKPOINT_EVERY === 0) log(`${s.id}: ${entry.rowsDeleted} rows deleted so far`);
          // Between batches: a Ctrl-C (shouldStop) ends the run here, on a
          // committed, consistent state.
          await yieldToLoop();
          if (shouldStop()) return false;
          begin(false);
        }
      }
      return true;
    };

    let stopped = false;
    try {
      begin(true);
      entry.cursor = cursor;
      entry.seqEpoch = seqEpochSuspect(st, s.id);
      if (entry.seqEpoch) {
        log(`${s.id} ${s.kind}: SEQ EPOCH suspect — latest row seq ${entry.seqEpoch.latestSeq} < MAX(seq) `
          + `${entry.seqEpoch.maxSeq} (a recreated agent log?): cursor ${cursor ?? 'NULL'} ignored, only seq-NULL runs merge`);
      }
      const planner = createRunPlanner({ cursor: entry.seqEpoch ? null : cursor, maxChars });
      let firstPage = true;
      outer: for (const rows of pages(st, s.id, pageRows)) {
        // Lets the SIGINT handler print at once; the stop itself waits for a commit.
        if (!firstPage) await yieldToLoop();
        firstPage = false;
        entry.rowsBefore += rows.length;
        for (const row of rows) {
          if (!(await take(planner.push(row)))) { stopped = true; break outer; }
        }
      }
      if (!stopped && !(await take(planner.end()))) stopped = true;
      commit(entry);
    } catch (e) {
      if (inTx) { try { db.exec('ROLLBACK'); } catch { /* the error below matters */ } inTx = false; }
      pending = { ops: 0, deleted: 0, verified: 0 };
      entry.ms = Math.round(performance.now() - t0);
      entry.error = errorText(e);
      // The batches this session committed before the failure stay applied.
      report.totals.ops += entry.ops;
      report.totals.rowsDeleted += entry.rowsDeleted;
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { report });
    }
    entry.ms = Math.round(performance.now() - t0);
    timer.record(`session ${s.id}`, entry.ms);
    report.totals.ops += entry.ops;
    report.totals.rowsDeleted += entry.rowsDeleted;
    if (stopped) {
      // Only committed batches count; `rowsBefore` covers the pages read.
      report.stopped = true;
      log(`${s.id} ${s.kind}: STOPPED after ${entry.ops} merges, ${entry.rowsDeleted} deleted rows (committed batches only)`);
      break;
    }
    entry.complete = true;
    entry.rowsAfter = entry.rowsBefore - entry.rowsDeleted;
    report.totals.sessions++;
    report.totals.rowsBefore += entry.rowsBefore;
    report.totals.rowsAfter += entry.rowsAfter;
    log(`${s.id} ${s.kind}: cursor ${cursor ?? 'NULL'}, rows ${entry.rowsBefore} → ${entry.rowsAfter}`
      + ` (${apply ? '' : 'would delete '}${entry.rowsDeleted}), ${entry.ops} merges, ${entry.ms} ms`);
  }
  if (apply) {
    const ck = timer.time('checkpoint', () => checkpointTruncate(db));
    report.checkpoints++;
    if (ck.busy !== 0) log(`warning: final wal_checkpoint(TRUNCATE) reported busy=${ck.busy}`);
    const fkAfter = timer.time('foreign_key_check', () => foreignKeyViolations(db));
    try {
      report.foreignKeyViolationsPreExisting = checkForeignKeys(/** @type {any} */ (fkBefore), fkAfter, log);
    } catch (e) {
      throw Object.assign(/** @type {Error} */ (e), { report });
    }
  }
  return report;
}

// ─── Backup ────────────────────────────────────────────────────────────────

/**
 * The byte work of `--backup-to`, run as `node -e BYTE_COPY_CHILD -- <db> <part>`
 * in a CHILD process: POSIX locks belong to a process, so the child's open and
 * close of the database never touch the parent's offline lock (header
 * INVARIANT). Copies `<db>` to `<part>` (COPYFILE_EXCL), chmod 600, fsync, then
 * the streamed sha256 of both; prints `{ source, copy, ms }` as JSON.
 */
export const BYTE_COPY_CHILD = `'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const [src, part] = process.argv.slice(1);
const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
const ms = {};
const time = (label, fn) => { const t0 = performance.now(); try { return fn(); } finally { ms[label] = performance.now() - t0; } };
const sha256 = (file) => {
  const fd = fs.openSync(file, 'r');
  try {
    const hash = crypto.createHash('sha256');
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
};
// COPYFILE_EXCL never writes over an existing <part> (EEXIST: someone else's,
// left alone); a copy that fails once it created <part> is removed by libuv.
time('copy', () => fs.copyFileSync(src, part, fs.constants.COPYFILE_EXCL));
// <part> is ours from here (the parent removes it if this process is killed).
process.stdout.write('{"created":true}\\n');
try {
  fs.chmodSync(part, 0o600);
  time('fsync', () => { const fd = fs.openSync(part, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } });
  const source = time('sha256 source', () => sha256(src));
  const copy = time('sha256 copy', () => sha256(part));
  process.stdout.write(JSON.stringify({ source, copy, ms }));
} catch (e) {
  // <part> is this copy's: never leave a half-made one behind.
  try { fs.unlinkSync(part); } catch {}
  throw e;
}
`;

function fsyncPath(p) {
  const fd = fs.openSync(p, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * BYTE-EXACT backup of the main file (identical pages, freelist and
 * sqlite_stat*: a restore keeps prod's plans). `db` must be the `openOffline`
 * handle of `dbPath`: with the lock held, `wal_checkpoint(TRUNCATE)` folds
 * the WAL into the main file — refused unless it reports busy=0 AND leaves an
 * empty -wal (the main file alone would not be the database). Then copy to
 * `<dest>.part` (never over an existing file), chmod 600, fsync; the streamed
 * sha256 of source and copy must match before the no-replace link to `dest` (and the
 * directory fsync); `PRAGMA quick_check` on the copy unless `check: false`.
 * Copy and hashes run in a child process (BYTE_COPY_CHILD): the lock held by
 * `db` survives the backup.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} dbPath
 * @param {string} destination
 * @param {{ check?: boolean, timer?: ReturnType<typeof createTimer>, log?: (line: string) => void,
 *   checkpoint?: (db: import('better-sqlite3').Database) => { busy: number, log: number, checkpointed: number } }} [opts]
 */
export async function backupDatabase(db, dbPath, destination, opts = {}) {
  const timer = opts.timer ?? createTimer();
  const log = opts.log ?? (() => {});
  const checkpoint = opts.checkpoint ?? checkpointTruncate;
  const dest = path.resolve(destination);
  const part = `${dest}.part`;
  if (fs.existsSync(dest)) throw new RefusedError(`${dest} exists: a backup is never overwritten`);
  if (fs.existsSync(part)) throw new RefusedError(`${part} exists (an interrupted copy?): remove it first`);
  const ck = timer.time('checkpoint', () => checkpoint(db));
  if (!ck || ck.busy !== 0) {
    throw new RefusedError(`wal_checkpoint(TRUNCATE) reported busy=${ck?.busy}: refusing to copy a database whose WAL is not folded in`);
  }
  const wal = walBytes(dbPath);
  if (wal !== 0) {
    throw new RefusedError(`${dbPath}-wal still holds ${wal} bytes after the checkpoint: refusing (the main file alone would not be the database)`);
  }
  // The copy is hashed under its `.part` name: `dest` only ever names a
  // verified byte-exact copy.
  const child = spawnSync(process.execPath, ['-e', BYTE_COPY_CHILD, '--', dbPath, part], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
  });
  // `.part` is this run's only once the child says it created it: a failure
  // before (EEXIST: a `.part` that appeared since the check above is someone
  // else's) leaves the file alone. A child that failed after removed its own;
  // one killed after is cleaned here.
  const lines = String(child.stdout ?? '').split('\n').filter(Boolean);
  const created = lines[0] === '{"created":true}';
  if (child.error || child.status !== 0) {
    if (created) { try { fs.unlinkSync(part); } catch { /* the child removed it */ } }
    if (child.error) throw child.error;
    throw new Error(`byte copy failed (${child.signal ?? `exit ${child.status}`}): ${(child.stderr || '').trim()}`);
  }
  let sourceSha;
  let copySha;
  try {
    const result = JSON.parse(lines[lines.length - 1] ?? '');
    for (const [label, ms] of Object.entries(result.ms)) timer.record(label, /** @type {number} */ (ms));
    sourceSha = result.source;
    copySha = result.copy;
    for (const sha of [sourceSha, copySha]) {
      if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) throw new Error(`byte copy returned no sha256: ${child.stdout}`);
    }
    log(`sha256 source ${sourceSha}`);
    log(`sha256 copy   ${copySha}  ${dest}`);
    if (sourceSha !== copySha) throw new Error(`sha256 mismatch: source ${sourceSha}, copy ${copySha} — the copy is NOT a backup`);
  } catch (e) {
    try { fs.unlinkSync(part); } catch { /* already gone */ }
    throw e;
  }
  // Publish WITHOUT replacing: rename(2) would silently replace a `dest`
  // created during the copy (another operator, a manual cp). link(2) fails
  // with EEXIST instead; the verified copy then stays under its `.part` name.
  try {
    fs.linkSync(part, dest);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e)?.code;
    if (code === 'EEXIST') {
      throw new RefusedError(`${dest} appeared during the copy: a backup is never overwritten — the verified copy `
        + `(sha256 ${copySha}) is kept as ${part}`);
    }
    throw new Error(`publishing ${dest} failed (${errorText(e)}): the verified copy (sha256 ${copySha}) is kept as ${part}`);
  }
  fs.unlinkSync(part);
  fs.chmodSync(dest, 0o600);
  fsyncPath(path.dirname(dest));
  const bytes = fs.statSync(dest).size;
  let quickCheck = null;
  if (opts.check !== false) {
    const Database = /** @type {any} */ (db).constructor;
    quickCheck = timer.time('quick_check copy', () => {
      const copy = new Database(dest, { readonly: true, fileMustExist: true });
      try { return copy.pragma('quick_check', { simple: true }); } finally { copy.close(); }
    });
    // The read-only open left an EMPTY -wal and a -shm beside the copy: the
    // backup is the one file.
    if (walBytes(dest) === 0) {
      for (const side of ['-wal', '-shm']) { try { fs.unlinkSync(dest + side); } catch { /* absent */ } }
    }
    if (quickCheck !== 'ok') throw new Error(`quick_check of the copy: ${quickCheck}`);
    log(`quick_check copy: ok`);
  }
  return { dest, bytes, sha256: copySha, quickCheck };
}

// ─── VACUUM ────────────────────────────────────────────────────────────────

/**
 * The conversation view's partial index (lib/db/conversationIndex.ts §
 * CONVERSATION_INDEX_SQL — the SAME text, pinned by tests/conversationIndex.test.ts).
 * The hub creates it at boot only on a small table; a large DB gets it here,
 * offline, before ANALYZE (never from a migration on the live DB, SPEC I12).
 */
export const CONVERSATION_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_session_messages_conversation_chrono ON session_messages (session_id, coalesce(ts_ms, created_at * 1000), id) WHERE (role NOT IN ('edit_snapshot', 'event', 'tool_use', 'tool_result', 'thinking', 'user_question', 'exit_plan_request') OR (role = 'event' AND (CASE WHEN json_valid(content) THEN json_extract(content, '$.type') END) IN ('compaction', 'scheduled_fire', 'structured_output', 'fork_point', 'external_message', 'peer_message_status', 'bg_task', 'interaction_resolved')))";

/** Build the conversation index, replacing one built for an older predicate
 *  (sqlite_master stores it without `IF NOT EXISTS`). */
export function ensureConversationIndexOffline(db) {
  const name = 'idx_session_messages_conversation_chrono';
  const stored = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
  if (stored && stored.sql !== CONVERSATION_INDEX_SQL.replace('CREATE INDEX IF NOT EXISTS ', 'CREATE INDEX ')) {
    db.exec(`DROP INDEX ${name}`);
  }
  db.exec(CONVERSATION_INDEX_SQL);
}

/**
 * In-place VACUUM on the `openOffline` handle (WAL mode: the rebuilt file goes
 * through the WAL; temp files where `SQLITE_TMPDIR` points — the CLI sets
 * `<db dir>/tmp`). `analyze: false` keeps the existing sqlite_stat* (prod's
 * planner statistics) untouched.
 *
 * The foreign-key check fails only on violations the run ADDED: its baseline
 * is taken before anything is written (`foreignKeyViolations`).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ analyze?: boolean, timer?: ReturnType<typeof createTimer>, log?: (line: string) => void,
 *   checkpoint?: (db: import('better-sqlite3').Database) => { busy: number, log: number, checkpointed: number } }} [opts]
 */
export function vacuumDatabase(db, opts = {}) {
  const timer = opts.timer ?? createTimer();
  const log = opts.log ?? (() => {});
  const checkpoint = opts.checkpoint ?? checkpointTruncate;
  db.pragma('temp_store = FILE');
  const before = { pages: db.pragma('page_count', { simple: true }), free: db.pragma('freelist_count', { simple: true }) };
  const fkBefore = timer.time('foreign_key_check', () => foreignKeyViolations(db));
  const ck1 = timer.time('checkpoint', () => checkpoint(db));
  if (ck1.busy !== 0) throw new RefusedError(`wal_checkpoint(TRUNCATE) reported busy=${ck1.busy}`);
  const hasMessages = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'session_messages'").get();
  if (hasMessages) timer.time('conversation index', () => ensureConversationIndexOffline(db));
  if (opts.analyze !== false) timer.time('analyze', () => db.exec('ANALYZE'));
  timer.time('vacuum', () => db.exec('VACUUM'));
  const ck2 = timer.time('checkpoint', () => checkpoint(db));
  if (ck2.busy !== 0) throw new Error(`wal_checkpoint(TRUNCATE) after VACUUM reported busy=${ck2.busy}`);
  // The summary names only the checks that ran and passed. (SQLite ≥ 3.44's
  // quick_check already runs FTS5's own integrity check; the explicit command
  // stays as the spec's last gate.)
  const passed = [];
  const quickCheck = timer.time('quick_check', () => db.pragma('quick_check', { simple: true }));
  if (quickCheck !== 'ok') throw new Error(`quick_check: ${quickCheck}`);
  passed.push('quick_check ok');
  const fkAfter = timer.time('foreign_key_check', () => foreignKeyViolations(db));
  const preExisting = checkForeignKeys(fkBefore, fkAfter, log);
  passed.push(preExisting ? `foreign_key_check: no new violation (${preExisting} pre-existing)` : 'foreign_key_check clean');
  const hasFts = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE name = 'session_messages_fts'").get();
  if (hasFts) {
    try {
      timer.time('fts integrity-check', () => db.exec(
        "INSERT INTO session_messages_fts(session_messages_fts) VALUES('integrity-check')"));
    } catch (e) {
      throw new Error(`FTS integrity-check: ${errorText(e)}`);
    }
    passed.push('FTS integrity-check ok');
  }
  const pageSize = db.pragma('page_size', { simple: true });
  const after = { pages: db.pragma('page_count', { simple: true }), free: db.pragma('freelist_count', { simple: true }) };
  log(`pages ${before.pages} (free ${before.free}) → ${after.pages} (free ${after.free}), page_size ${pageSize}`);
  log(passed.join('; '));
  return {
    pageSize, before, after, quickCheck, analyzed: opts.analyze !== false, fts: !!hasFts,
    foreignKeyViolationsPreExisting: preExisting,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

/** `path.resolve`, through the real path of the nearest existing ancestor
 *  directory (a symlinked directory names the same file). */
function realTarget(file) {
  const resolved = path.resolve(file);
  let dir = path.dirname(resolved);
  const rest = [path.basename(resolved)];
  for (;;) {
    try { return path.join(fs.realpathSync(dir), ...rest); } catch { /* missing: go up */ }
    const up = path.dirname(dir);
    if (up === dir) return resolved;
    rest.unshift(path.basename(dir));
    dir = up;
  }
}

/**
 * Why the `--report` target must be refused, or null. The report is written
 * last, whatever the mode (the dry run included), so it must be a NEW file
 * and none of the files this run maintains — the database and its
 * -wal/-shm/-journal (a report renamed over the main file replaced the
 * database), the `--backup-to` copy, its `.part` and its quick_check's side
 * files — compared through real paths. `usage` ⇒ exit 2, else 1 (an existing
 * file, like a backup, is never overwritten). Stat only: nothing is opened.
 *
 * @param {string} report @param {string} dbPath @param {string | null} backupTo
 * @returns {{ usage: boolean, message: string } | null}
 */
export function reportTargetProblem(report, dbPath, backupTo) {
  const target = realTarget(report);
  if (!fs.existsSync(path.dirname(target))) {
    return { usage: true, message: `--report: no directory ${path.dirname(target)}` };
  }
  const guarded = [];
  // SQLite names the side files after the database's resolved path.
  for (const base of new Set([dbPath, realTarget(dbPath), fs.realpathSync(dbPath)])) {
    for (const side of ['', '-wal', '-shm', '-journal']) guarded.push([base + side, 'the database']);
  }
  if (backupTo != null) {
    const dest = realTarget(backupTo);
    for (const side of ['', '.part', '-wal', '-shm', '-journal']) guarded.push([dest + side, 'the --backup-to copy']);
  }
  const hit = guarded.find(([p]) => p === target);
  if (hit) return { usage: true, message: `--report ${target} is a file of ${hit[1]}: name a new .json file` };
  let exists = true;
  try { fs.lstatSync(target); } catch { exists = false; }
  if (exists) return { usage: false, message: `--report ${target} exists: a report is never overwritten` };
  return null;
}

/**
 * Why the `--backup-to` target must be refused, or null: the database or one
 * of its -wal/-shm/-journal side files (all spellings, real paths). A copy
 * published as `<db>-journal` passes the existence check (WAL mode has none)
 * and is then taken for a hot journal and deleted by the next open of the
 * database. Exit 2. Stat only.
 *
 * @param {string} backupTo @param {string} dbPath
 * @returns {string | null}
 */
export function backupTargetProblem(backupTo, dbPath) {
  const dest = realTarget(backupTo);
  for (const base of new Set([dbPath, realTarget(dbPath), fs.realpathSync(dbPath)])) {
    for (const side of ['', '-wal', '-shm', '-journal']) {
      if (dest === base + side || dest + '.part' === base + side) {
        return `--backup-to ${dest} is a file of the database: name a new file`;
      }
    }
  }
  return null;
}

/** O_CREAT|O_EXCL: never over an existing file, nor through a symlink. */
function writeReport(file, report) {
  const target = path.resolve(file);
  const fd = fs.openSync(target, 'wx', 0o600);
  let written = false;
  try {
    fs.writeFileSync(fd, JSON.stringify(report, null, 2) + '\n');
    fs.fsyncSync(fd);
    written = true;
  } finally {
    fs.closeSync(fd);
    if (!written) { try { fs.unlinkSync(target); } catch { /* the error that matters is thrown */ } }
  }
}

/**
 * @param {string[]} argv
 * @param {{ out?: (line: string) => void, err?: (line: string) => void }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`compact-thinking: ${e.message}`);
    err(USAGE);
    return 2;
  }
  if (o.help) { out(USAGE); return 0; }
  const dbPath = path.resolve(/** @type {string} */ (o.db));
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    err(`compact-thinking: no database file at ${dbPath}`);
    return 2;
  }
  // Before any work: the backup must never be a file SQLite manages.
  const backupProblem = o.backupTo != null ? backupTargetProblem(o.backupTo, dbPath) : null;
  if (backupProblem) {
    err(`compact-thinking: ${backupProblem}`);
    return 2;
  }
  // Before any work: the report is written last, in every mode.
  const reportProblem = o.report != null ? reportTargetProblem(o.report, dbPath, o.backupTo) : null;
  if (reportProblem) {
    err(`compact-thinking: ${reportProblem.message}`);
    return reportProblem.usage ? 2 : 1;
  }
  if (o.mode === 'vacuum') {
    // Before better-sqlite3 loads: SQLite reads SQLITE_TMPDIR at init. Temp
    // files of an in-place VACUUM are about the live size — same disk as the
    // database, never a tmpfs.
    const tmp = path.join(path.dirname(dbPath), 'tmp');
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    process.env.SQLITE_TMPDIR = tmp;
    out(`temp files: ${tmp}`);
  }
  const Database = (await import('better-sqlite3')).default;
  const timer = createTimer({ print: o.timings, log: out });
  const startedAt = new Date().toISOString();
  const report = /** @type {Record<string, any>} */ ({ db: dbPath, mode: o.mode, startedAt, options: { ...o, db: dbPath } });
  let code = 0;
  let stop = false;
  const onSigint = () => {
    if (stop) return;
    stop = true;
    err('compact-thinking: stopping after the current batch (committed batches stay; Ctrl-\\ to abort now)');
  };
  let db = null;
  try {
    db = timer.time('open', () => (o.mode === 'dry-run' ? openReadOnly(Database, dbPath) : openOffline(Database, dbPath)));
    if (o.mode === 'dry-run' || o.mode === 'apply') {
      if (o.mode === 'apply') process.on('SIGINT', onSigint);
      const result = await compactDatabase(db, {
        apply: o.mode === 'apply', verify: o.verify, sessionId: o.session, batch: o.batch,
        log: out, timer, shouldStop: () => stop,
      });
      Object.assign(report, result);
      const t = result.totals;
      out(`${o.mode === 'apply' ? 'applied' : 'planned'}: ${t.ops} merges, ${t.rowsDeleted} rows`
        + `${o.mode === 'apply' ? ' deleted' : ' to delete'} across ${t.sessions} sessions`
        + ` (rows ${t.rowsBefore} → ${t.rowsAfter})`
        + (o.verify ? `; ${t.verified} merges verified` : '')
        + (o.mode === 'apply' ? `; ${result.batches} batches, ${result.checkpoints} checkpoints` : ''));
      if (result.stopped) { out('STOPPED early: rerun to resume (already merged runs plan nothing)'); code = 1; }
    } else if (o.mode === 'backup') {
      report.backup = await backupDatabase(db, dbPath, /** @type {string} */ (o.backupTo), {
        check: !o.noCheck, timer, log: out,
      });
      out(`backup: ${report.backup.dest} (${report.backup.bytes} bytes, mode 600)`);
    } else {
      report.vacuum = vacuumDatabase(db, { analyze: !o.noAnalyze, timer, log: out });
    }
  } catch (e) {
    code = 1;
    report.error = errorText(e);
    const partial = /** @type {any} */ (e)?.report;
    if (partial) Object.assign(report, partial);
    err(`compact-thinking: ${report.error}`);
  } finally {
    process.off('SIGINT', onSigint);
    if (db) {
      try { timer.time('close', () => db.close()); } catch (e) { err(`compact-thinking: close: ${errorText(e)}`); code = code || 1; }
    }
  }
  report.finishedAt = new Date().toISOString();
  report.durations = timer.phases;
  report.ok = code === 0;
  if (o.report) {
    try { writeReport(o.report, report); out(`report: ${path.resolve(o.report)}`); } catch (e) {
      err(`compact-thinking: report: ${errorText(e)}`);
      code = code || 1;
    }
  }
  return code;
}

/** Real paths on both sides: Node resolves the main module's symlinks, argv[1] keeps them. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
