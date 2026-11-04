// The conversation view's ("tools hidden", §14.25) index: a PARTIAL chrono
// index over the rows a conversation page carries (slots + conversation
// events). Without it the slot and page-range queries walk the general chrono
// index through EVERY technical row of the span (a table lookup each to test
// the role): ~50× the full view's cost on a tool-heavy session, synchronously.
//
// SQLite uses a partial index only when the query's WHERE contains the index's
// WHERE terms LITERALLY (a bound parameter never matches), so the queries
// (messageWindow.ts) and the index are built from the SAME predicate text,
// generated from lib/transcriptRows.ts (classify a new role THERE).
//
// No migration builds it (SPEC I12: the build migrates the LIVE DB and must
// never scan session_messages): boot creates it only while the table
// is small (`ensureConversationIndex`), a large DB gets it OFFLINE from
// `scripts/compact-thinking.mjs --offline --vacuum` (same SQL, test-pinned).
// Missing, the queries are still correct — only the plan is the slow one.
import type Database from 'better-sqlite3';
import { CONVERSATION_EVENT_TYPES, RENDER_NULL_ROLES, TECHNICAL_ROLES } from '@/lib/transcriptRows';

export const CONVERSATION_INDEX_NAME = 'idx_session_messages_conversation_chrono';

/** Roles that never take a conversation slot (side channels, technical,
 *  render-null). */
export const CONVERSATION_NON_SLOT_ROLES: string[] = [
  'edit_snapshot', 'event', ...TECHNICAL_ROLES, ...RENDER_NULL_ROLES,
];

function literals(xs: readonly string[]): string {
  return xs.map((x) => {
    if (!/^[a-z_]+$/.test(x)) throw new Error(`conversationIndex: unsafe literal ${JSON.stringify(x)}`);
    return `'${x}'`;
  }).join(', ');
}

/** The two predicates, over the given column spellings (qualified in the
 *  queries, bare in the index: SQLite matches them after name resolution). */
export function conversationPredicates(role: string, content: string): { slot: string; page: string } {
  const slot = `${role} NOT IN (${literals(CONVERSATION_NON_SLOT_ROLES)})`;
  const eventType = `(CASE WHEN json_valid(${content}) THEN json_extract(${content}, '$.type') END)`;
  const page = `(${slot} OR (${role} = 'event' AND ${eventType} IN (${literals(CONVERSATION_EVENT_TYPES)})))`;
  return { slot, page };
}

export const CONVERSATION_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${CONVERSATION_INDEX_NAME} ON session_messages `
  + `(session_id, coalesce(ts_ms, created_at * 1000), id) WHERE ${conversationPredicates('role', 'content').page}`;

/** Boot creates the index only below this many rows (max rowid: O(log n),
 *  never a count scan) — a fresh or small DB, well under a second. */
export const CONVERSATION_INDEX_ONLINE_MAX_ROWS = 250_000;

export type EnsureIndexResult = 'exists' | 'created' | 'deferred' | 'no-table';

/** How sqlite_master spells the index (it drops `IF NOT EXISTS`). */
export const CONVERSATION_INDEX_STORED_SQL = CONVERSATION_INDEX_SQL.replace('CREATE INDEX IF NOT EXISTS ', 'CREATE INDEX ');

export function ensureConversationIndex(
  db: Database.Database, maxRows = CONVERSATION_INDEX_ONLINE_MAX_ROWS,
): EnsureIndexResult {
  const has = (name: string) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name);
  if (!has('session_messages')) return 'no-table';
  const stored = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(CONVERSATION_INDEX_NAME) as
    { sql: string | null } | undefined;
  if (stored?.sql === CONVERSATION_INDEX_STORED_SQL) return 'exists';
  // A conversation event type was added since it was built: the queries no
  // longer carry its predicate, so SQLite would never use it again. Dropping
  // reads no table row; the new one follows the same online/offline rule.
  if (stored) db.exec(`DROP INDEX ${CONVERSATION_INDEX_NAME}`);
  const top = db.prepare('SELECT max(rowid) AS n FROM session_messages').get() as { n: number | null };
  if ((top?.n ?? 0) > maxRows) return 'deferred';
  db.exec(CONVERSATION_INDEX_SQL);
  return 'created';
}
