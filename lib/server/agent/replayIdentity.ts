import 'server-only';
import type Database from 'better-sqlite3';
import { rawSqlite } from '@/lib/db';

// Replay identity (CLAUDE.md §14.31). A replayed agent event is skipped only
// when ITS OWN row exists: the row stamped with the event's seq (flush rows
// carry their FIRST delta's seq). Never MAX(seq): a failed persist at N under
// a successful N+1 must be repaired, and a max proves nothing below it.
//
// Each question is ONE indexed point lookup (idx_session_messages_
// session_seq), asked when the event is dispatched. The old design loaded
// every seq of the session into a Set at each replay_begin: a covering scan of
// millions of entries on the event loop at every reconnect. The lookup also
// sees rows written by an earlier, overlapping replay (double subscribe),
// which a snapshot taken at replay_begin missed.
//
// ts guard: the agent restarts seq at 1 when it recreates a session's log
// (§14.71), so an old row may carry the same seq as a new event. Rows store
// the ts of the event whose seq they carry (a flush row: its first delta's),
// so a candidate must also match the event's ts (±1 ms of rounding). Rows
// with a NULL `ts_ms` and events without `ts` (old agents) match on seq alone.
// (Migration 0026 backfilled `ts_ms = created_at*1000` on older rows: the few
// days of seq-stamped rows before it no longer match their own events, whose
// logs rotated away long ago. A false miss costs a duplicate; a looser guard
// would let an old row swallow a new-epoch event, a loss.)
//
// Statements are prepared LAZILY: during `next build` the DB is `:memory:`
// without tables (§14.69), and nothing may need the schema at import time.
// The cache is per module copy (Next loads several); every copy prepares on
// the same shared handle, and a new handle simply re-prepares.

export type LegacyReplaySets = {
  toolUseIds: Set<string>;
  toolResultIds: Set<string>;
  assistantContents: Set<string>;
  thinkingContents: Set<string>;
};

/** Test observability: how many identity lookups / legacy loads ran. */
export const replayIdentityStats = { pointLookups: 0, legacyLoads: 0 };

type Statements = {
  handle: Database.Database;
  rowAtSeq: Database.Statement;
  eventRowAtSeq: Database.Statement;
  assistantRowAtSeq: Database.Statement;
  hasStamped: Database.Statement;
  hasLegacyToolRows: Database.Statement;
  legacy: Database.Statement;
};

const AT_SEQ = 'session_id = @sid AND seq = @seq'
  + ' AND (@ts IS NULL OR ts_ms IS NULL OR abs(ts_ms - @ts) <= 1)';
// `+role` keeps the role terms out of index selection: (session_id, role)
// (idx_…_snapshot_lookup) would otherwise compete with (session_id, seq) and,
// for role='event' on a reasoning-heavy session, walk millions of rows.
const ROLE = '+role';

let prepared: Statements | null = null;

function statements(): Statements {
  const handle = rawSqlite();
  if (prepared?.handle === handle) return prepared;
  prepared = {
    handle,
    rowAtSeq: handle.prepare(
      `SELECT id, role FROM session_messages WHERE ${AT_SEQ} ORDER BY id LIMIT 1`),
    eventRowAtSeq: handle.prepare(
      `SELECT id, content FROM session_messages WHERE ${AT_SEQ} AND ${ROLE} = 'event' ORDER BY id LIMIT 1`),
    assistantRowAtSeq: handle.prepare(
      `SELECT id, content FROM session_messages WHERE ${AT_SEQ} AND ${ROLE} = 'assistant' ORDER BY id LIMIT 1`),
    hasStamped: handle.prepare(
      'SELECT 1 AS one FROM session_messages WHERE session_id = ? AND seq IS NOT NULL LIMIT 1'),
    hasLegacyToolRows: handle.prepare(
      `SELECT 1 AS one FROM session_messages WHERE session_id = ? AND seq IS NULL
         AND ${ROLE} IN ('tool_use', 'tool_result') LIMIT 1`),
    legacy: handle.prepare(
      `SELECT role, content FROM session_messages WHERE session_id = ? AND seq IS NULL
         AND ${ROLE} IN ('tool_use', 'tool_result', 'assistant', 'thinking', 'event')`),
  };
  return prepared;
}

function params(sessionId: string, seq: number, tsMs: number | null | undefined) {
  return { sid: sessionId, seq, ts: typeof tsMs === 'number' && Number.isFinite(tsMs) ? Math.round(tsMs) : null };
}

// A failed lookup answers "not persisted": the event is processed again (its
// insert then fails too and holds the cursor back, or it lands as a visible
// duplicate), never silently dropped.
function lookup<T>(pick: (s: Statements) => Database.Statement, sessionId: string,
  seq: number, tsMs: number | null | undefined): T | undefined {
  replayIdentityStats.pointLookups++;
  try {
    return pick(statements()).get(params(sessionId, seq, tsMs)) as T | undefined;
  } catch (e) {
    console.warn(`[replay] identity lookup failed for ${sessionId} seq ${seq}: ${(e as Error)?.message ?? e}`);
    return undefined;
  }
}

/** The row stamped with this seq (and a matching ts), any role. */
export function rowAtSeq(sessionId: string, seq: number, tsMs?: number | null): { id: number; role: string } | undefined {
  return lookup((s) => s.rowAtSeq, sessionId, seq, tsMs);
}

/** Same, restricted to `role='event'` rows (coalesced thinking, C02). */
export function eventRowAtSeq(sessionId: string, seq: number, tsMs?: number | null): { id: number; content: string } | undefined {
  return lookup((s) => s.eventRowAtSeq, sessionId, seq, tsMs);
}

/** Same, restricted to `role='assistant'` rows (flush rows). */
export function assistantRowAtSeq(sessionId: string, seq: number, tsMs?: number | null): { id: number; content: string } | undefined {
  return lookup((s) => s.assistantRowAtSeq, sessionId, seq, tsMs);
}

/** True when at least one row of the session carries a seq: identity is
 *  then trustworthy for flush rows; otherwise the legacy content path runs. */
export function sessionHasStampedRows(sessionId: string): boolean {
  replayIdentityStats.pointLookups++;
  try {
    return statements().hasStamped.get(sessionId) != null;
  } catch {
    return false;
  }
}

/** True when a tool row of the session has no seq (pre-seq history, fork
 *  copies, imports): only then can a STAMPED tool event that missed identity
 *  still be a duplicate, recognisable by its tool id alone. Walks the
 *  `seq IS NULL` index range without parsing anything; asked once per replay
 *  window, and only when a replayed tool row misses identity. Answers true on
 *  error, so the full legacy check runs as before. */
export function sessionHasLegacyToolRows(sessionId: string): boolean {
  replayIdentityStats.pointLookups++;
  try {
    return statements().hasLegacyToolRows.get(sessionId) != null;
  } catch (e) {
    console.warn(`[replay] legacy tool-row probe failed for ${sessionId}: ${(e as Error)?.message ?? e}`);
    return true;
  }
}

/** Content fallback for events without seq and rows without seq (pre-seq
 *  history, fork copies): ids/texts of the session's `seq IS NULL` rows only.
 *  Callers load it LAZILY, on the first event that needs it. */
export function loadLegacyReplaySets(sessionId: string): LegacyReplaySets {
  replayIdentityStats.legacyLoads++;
  const sets: LegacyReplaySets = {
    toolUseIds: new Set(), toolResultIds: new Set(),
    assistantContents: new Set(), thinkingContents: new Set(),
  };
  try {
    for (const r of statements().legacy.iterate(sessionId) as Iterable<{ role: string; content: string }>) {
      try {
        if (r.role === 'tool_use') {
          const p = JSON.parse(r.content);
          if (p?.id) sets.toolUseIds.add(String(p.id));
        } else if (r.role === 'tool_result') {
          const p = JSON.parse(r.content);
          if (p?.tool_use_id) sets.toolResultIds.add(String(p.tool_use_id));
        } else if (r.role === 'assistant') {
          sets.assistantContents.add(r.content);
        } else if (r.role === 'thinking') {
          sets.thinkingContents.add(r.content);
        } else if (r.role === 'event') {
          // Old 'thinking' events (before the dedicated role) are stored here.
          const p = JSON.parse(r.content);
          if (p?.type === 'thinking' && typeof p.text === 'string') sets.thinkingContents.add(p.text);
        }
      } catch {}
    }
  } catch (e) {
    console.warn(`[replay] legacy identity load failed for ${sessionId}: ${(e as Error)?.message ?? e}`);
  }
  return sets;
}
