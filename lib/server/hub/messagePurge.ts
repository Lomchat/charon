import 'server-only';
import type Database from 'better-sqlite3';
import { rawSqlite } from '@/lib/db';
import { timeSection } from '@/lib/server/perf/loopLag';

// A deleted session's message rows (CLAUDE.md §14.29). Its row and every
// other child go in ONE transaction run with foreign keys OFF (`detached`);
// its messages — thousands of rows, each with index and FTS entries: seconds
// of disk work when the cascade did it in one statement — leave here, in
// ≤ PURGE_SLICE_MS slices, one transaction each. Orphan rows are invisible
// (every reader keys on an existing session; search joins it); a restart
// mid-purge finds them again at boot (`resumeMessagePurges`).

export const PURGE_SLICE_MS = 8;
const PURGE_BATCH_ROWS = 32;

type Child = { tbl: string; col: string; onDelete: string };
type PurgeState = {
  queue: string[];
  running: boolean;
  handle: Database.Database | null;
  children: Child[] | null;
  del: Database.Statement | null;
  exists: Database.Statement | null;
};

const g = globalThis as typeof globalThis & { __charonMessagePurge?: PurgeState };

function state(): PurgeState {
  const st = g.__charonMessagePurge ??= { queue: [], running: false, handle: null, children: null, del: null, exists: null };
  const handle = rawSqlite();
  if (st.handle !== handle) {
    st.handle = handle;
    st.children = null;
    st.del = handle.prepare(`DELETE FROM session_messages WHERE id IN (
      SELECT id FROM session_messages WHERE session_id = ? ORDER BY id LIMIT ${PURGE_BATCH_ROWS})`);
    st.exists = handle.prepare('SELECT 1 FROM agent_sessions WHERE id = ?');
  }
  return st;
}

/** The tables referencing agent_sessions, session_messages aside (read from
 *  the schema: a new child is covered without touching this module). */
function sessionChildren(st: PurgeState): Child[] {
  return st.children ??= st.handle!.prepare(`
    SELECT m.name AS tbl, f."from" AS col, upper(f.on_delete) AS onDelete
      FROM sqlite_master m, pragma_foreign_key_list(m.name) f
     WHERE m.type = 'table' AND f."table" = 'agent_sessions' AND m.name <> 'session_messages'`).all() as Child[];
}

/** Runs `deleteRow` (the transaction deleting the session row) with foreign
 *  keys OFF, deletes every other child itself in the same transaction, then
 *  queues the message purge. Falls back to the plain cascade (FK on) inside an open transaction
 *  (the pragma is a no-op there) or when a child is not CASCADE/SET NULL. */
export function deleteSessionDetached(sessionId: string, deleteRow: () => void): void {
  const st = state();
  const sqlite = st.handle!;
  const children = sessionChildren(st);
  if (sqlite.inTransaction || children.some((c) => c.onDelete !== 'CASCADE' && c.onDelete !== 'SET NULL')) {
    deleteRow();
    return;
  }
  sqlite.pragma('foreign_keys = OFF');
  try {
    sqlite.transaction(() => {
      // The row first: its transaction reads children it publishes (gates).
      deleteRow();
      for (const c of children) {
        sqlite.prepare(c.onDelete === 'CASCADE'
          ? `DELETE FROM "${c.tbl}" WHERE "${c.col}" = ?`
          : `UPDATE "${c.tbl}" SET "${c.col}" = NULL WHERE "${c.col}" = ?`).run(sessionId);
      }
    })();
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
  queueMessagePurge(sessionId);
}

export function queueMessagePurge(sessionId: string): void {
  const st = state();
  if (!st.queue.includes(sessionId)) st.queue.push(sessionId);
  if (st.running) return;
  st.running = true;
  setImmediate(pump);
}

/** One slice: true = this session's purge is over. */
function purgeSlice(st: PurgeState, sessionId: string): boolean {
  // A session that exists (again: tests reuse ids) owns its rows.
  if (st.exists!.get(sessionId)) return true;
  const started = performance.now();
  return st.handle!.transaction(() => {
    for (;;) {
      if (st.del!.run(sessionId).changes < PURGE_BATCH_ROWS) return true;
      if (performance.now() - started >= PURGE_SLICE_MS) return false;
    }
  })();
}

function pump(): void {
  const st = state();
  const sessionId = st.queue[0];
  if (sessionId == null) { st.running = false; return; }
  let done: boolean;
  try {
    done = timeSection('purge:messages', () => purgeSlice(st, sessionId));
  } catch (e) {
    // Left for the next boot's sweep rather than retried in a loop.
    console.warn(`[purge] messages of ${sessionId}: ${(e as Error)?.message ?? e}`);
    done = true;
  }
  if (done) st.queue.shift();
  if (st.queue.length) setImmediate(pump);
  else st.running = false;
}

/** Session ids that own message rows but no session row: one index seek per
 *  distinct session id, not a scan. */
export function orphanMessageSessions(): string[] {
  return rawSqlite().prepare(`
    WITH RECURSIVE ids(id) AS (
      SELECT (SELECT min(session_id) FROM session_messages)
      UNION ALL
      SELECT (SELECT min(session_id) FROM session_messages WHERE session_id > ids.id) FROM ids WHERE ids.id IS NOT NULL
    )
    SELECT id FROM ids WHERE id IS NOT NULL AND id NOT IN (SELECT id FROM agent_sessions)`).pluck().all() as string[];
}

/** Boot: finish the purges a restart cut short. */
export function resumeMessagePurges(): number {
  const ids = orphanMessageSessions();
  for (const id of ids) queueMessagePurge(id);
  return ids.length;
}

/** Observability (tests). */
export function messagePurgeIdle(): boolean {
  return !state().running;
}
