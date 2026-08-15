import 'server-only';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db, claudeSessionMessages } from '@/lib/db';
import type { ClaudeSessionMessage } from '@/lib/db/schema';

// Side-channel roles ride with the chronological chat page that owns them,
// but never consume one of the requested chat slots.
export const NON_PAGINATED_ROLES: string[] = ['edit_snapshot', 'event'];

// One canonical, indexed chronology. ts_ms is populated by every current
// writer and migration 0026 backfilled old rows; created_at + id is the safe
// legacy fallback/tie-breaker.
const orderTs = sql<number>`coalesce(${claudeSessionMessages.tsMs}, ${claudeSessionMessages.createdAt} * 1000)`;

// Never select the lossless heavyweight payload for the looping chat route.
// wire_content contains edit metadata / bounded tool previews where needed.
export const publicMessageColumns = {
  id: claudeSessionMessages.id,
  sessionId: claudeSessionMessages.sessionId,
  role: claudeSessionMessages.role,
  content: sql<string>`coalesce(${claudeSessionMessages.wireContent}, ${claudeSessionMessages.content})`,
  model: claudeSessionMessages.model,
  seq: claudeSessionMessages.seq,
  tsMs: claudeSessionMessages.tsMs,
  // The CLI transcript entry this row came from — the anchor "fork from here"
  // branches at. Cheap (a uuid string) and only ever set on assistant rows.
  cliUuid: claudeSessionMessages.cliUuid,
  createdAt: claudeSessionMessages.createdAt,
};

type Key = { id: number; ts: number };

function latestSnapshotMetadata(sessionId: string): ClaudeSessionMessage[] {
  const ids = db.select({ id: sql<number>`max(${claudeSessionMessages.id})` })
    .from(claudeSessionMessages)
    .where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      eq(claudeSessionMessages.role, 'edit_snapshot'),
      isNotNull(claudeSessionMessages.snapshotFilePath),
    ))
    .groupBy(claudeSessionMessages.snapshotFilePath, claudeSessionMessages.snapshotPhase)
    .all().map((r) => r.id);
  const out: ClaudeSessionMessage[] = [];
  // Stay below SQLite's common 999-variable ceiling for pathological repos.
  for (let i = 0; i < ids.length; i += 900) {
    out.push(...db.select(publicMessageColumns).from(claudeSessionMessages)
      .where(inArray(claudeSessionMessages.id, ids.slice(i, i + 900)))
      .all());
  }
  return out;
}

function sortMessages(rows: ClaudeSessionMessage[]): ClaudeSessionMessage[] {
  return rows.sort((a, b) =>
    ((a.tsMs ?? a.createdAt * 1000) - (b.tsMs ?? b.createdAt * 1000)) || (a.id - b.id));
}

function beforeKey(key: Key): SQL {
  return or(lt(orderTs, key.ts), and(eq(orderTs, key.ts), lt(claudeSessionMessages.id, key.id)))!;
}

function atOrAfterKey(key: Key): SQL {
  return or(gt(orderTs, key.ts), and(eq(orderTs, key.ts), gte(claudeSessionMessages.id, key.id)))!;
}

/**
 * Load a keyset-paginated chronological window.
 *
 * The old implementation selected every row in a session, allocated maps and
 * sorted it in JS for every five-second catch-up GET. Large transcripts spent
 * hundreds of milliseconds blocking Node even though the UI only wanted 200
 * rows. `(session_id, ts_ms, id)` now lets SQLite seek the exact page.
 *
 * Page ownership is half-open: a chat row owns side-channel rows after it up
 * to the next chat row. Thus older + newer pages concatenate without gaps or
 * duplicates, including attachments exactly on a page boundary.
 */
export function loadMessageWindow(
  sessionId: string,
  limit: number,
  before: number | null,
): { messages: ClaudeSessionMessage[]; hasMore: boolean; oldestChatId: number | null } {
  let cursor: Key | null = null;
  if (before != null) {
    const row = db.select({ id: claudeSessionMessages.id, ts: orderTs })
      .from(claudeSessionMessages)
      .where(and(
        eq(claudeSessionMessages.sessionId, sessionId),
        eq(claudeSessionMessages.id, before),
      ))
      .get();
    if (row) cursor = row;
  }

  const chatWhere: SQL[] = [
    eq(claudeSessionMessages.sessionId, sessionId),
    notInArray(claudeSessionMessages.role, NON_PAGINATED_ROLES),
  ];
  if (cursor) chatWhere.push(beforeKey(cursor));
  else if (before != null) chatWhere.push(lt(claudeSessionMessages.id, before));

  const chatDesc = db.select({ id: claudeSessionMessages.id, ts: orderTs })
    .from(claudeSessionMessages)
    .where(and(...chatWhere))
    .orderBy(desc(orderTs), desc(claudeSessionMessages.id))
    .limit(limit + 1)
    .all();

  if (chatDesc.length === 0) {
    // Preserve the side-channel-only behavior: return a bounded newest tail.
    if (before != null) return { messages: [], hasMore: false, oldestChatId: null };
    const tail = db.select(publicMessageColumns).from(claudeSessionMessages)
      .where(and(
        eq(claudeSessionMessages.sessionId, sessionId),
        notInArray(claudeSessionMessages.role, ['edit_snapshot']),
      ))
      .orderBy(desc(orderTs), desc(claudeSessionMessages.id))
      .limit(limit + 1)
      .all();
    const hasMore = tail.length > limit;
    if (hasMore) tail.pop();
    tail.reverse();
    const snapshots = latestSnapshotMetadata(sessionId);
    return { messages: sortMessages([...tail, ...snapshots]), hasMore, oldestChatId: null };
  }

  const hasMore = chatDesc.length > limit;
  if (hasMore) chatDesc.pop();
  const first = chatDesc[chatDesc.length - 1];

  const windowWhere: SQL[] = [eq(claudeSessionMessages.sessionId, sessionId)];
  // If this is not the oldest page, the preceding page owns everything before
  // our first chat row. The oldest page extends to -infinity and gets leading
  // side-channel rows.
  if (hasMore) windowWhere.push(atOrAfterKey(first));
  // Cursor is the first chat row of the newer page. Excluding it includes the
  // boundary attachments owned by our final (older) chat row.
  if (cursor) windowWhere.push(beforeKey(cursor));
  else if (before != null) windowWhere.push(lt(claudeSessionMessages.id, before));

  const messages = db.select(publicMessageColumns).from(claudeSessionMessages)
    .where(and(
      ...windowWhere,
      notInArray(claudeSessionMessages.role, ['edit_snapshot']),
    ))
    .orderBy(asc(orderTs), asc(claudeSessionMessages.id))
    .all();

  // The chat only needs the latest before/after skeleton for each changed
  // file; sending every historical snapshot in a page was hundreds of
  // duplicate JSON objects. Older pages omit them because the newest page
  // already seeds the global per-session diff registry.
  if (before == null) messages.push(...latestSnapshotMetadata(sessionId));

  return { messages: sortMessages(messages), hasMore, oldestChatId: first.id };
}
