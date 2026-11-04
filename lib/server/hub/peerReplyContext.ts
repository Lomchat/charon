import 'server-only';
import type Database from 'better-sqlite3';
import { rawSqlite, type AgentSessionMessage } from '@/lib/db';
import { orderChronologically } from './messageOrder';

type InputRow = Pick<AgentSessionMessage, 'id' | 'role' | 'content'>;

/** Rows walked back from a page's first row looking for the input it answers.
 *  Past it the page's leading assistant rows get no `peerReplyTo` (a
 *  documented degradation, CLAUDE.md §14.93) rather than an O(session) read. */
export const PRIOR_INPUT_WALK_CAP = 5_000;

function incomingPeerId(row: InputRow): string | null {
  if (row.role !== 'event') return null;
  try {
    const event = JSON.parse(row.content);
    return event.type === 'external_message'
      && !event.replyTo && event.origin !== 'charon_peer_reply' && event.expectsReply !== false
      ? typeof event.messageId === 'string' ? event.messageId : `m${row.id}`
      : null;
  } catch { return null; }
}

// The walk back from a page's first row, newest first, on the chronological
// expression index (idx_…_session_chrono_id). The redundant `<= @ts` bound is
// load-bearing: without it the planner either seeks `session_id` alone (the
// walk starts at the session's NEWEST row) or, under production statistics,
// splits the OR into MULTI-INDEX OR + TEMP B-TREE, sorting every prior row
// before yielding one. Content is fetched only for event rows that can be
// input boundaries (the `instr` precheck; JSON.parse decides).
const PRIOR_SQL = `SELECT id, role,
    CASE WHEN role = 'event' AND (instr(content, '"external_message"') > 0 OR instr(content, '"fork_point"') > 0)
      THEN content END AS content
  FROM session_messages
  WHERE session_id = @sid
    AND coalesce(ts_ms, created_at * 1000) <= @ts
    AND (coalesce(ts_ms, created_at * 1000) < @ts OR id < @id)
  ORDER BY coalesce(ts_ms, created_at * 1000) DESC, id DESC`;

// Prepared lazily (the build-phase DB has no tables, §14.69), once per process
// on the shared handle (re-prepared if the handle changes). The memo lives on
// globalThis so every Next module copy shares it (I3).
type PeerWalk = { prepared: { handle: Database.Database; prior: Database.Statement } | null };
const g = globalThis as typeof globalThis & { __charonPeerWalk?: PeerWalk };

/** Exported for the plan assertion in tests. */
export function priorInputStatement(): Database.Statement {
  const walk = g.__charonPeerWalk ??= { prepared: null };
  const handle = rawSqlite();
  if (walk.prepared?.handle !== handle) walk.prepared = { handle, prior: handle.prepare(PRIOR_SQL) };
  return walk.prepared.prior;
}

/** The peer request id opened by the input preceding chronological key
 *  (ts, id), or null: a human prompt, a fork point, a received reply, no input
 *  at all, or none within PRIOR_INPUT_WALK_CAP rows. */
function priorPeerInput(sessionId: string, firstTime: number, firstId: number): string | null {
  let walked = 0;
  const rows = priorInputStatement().iterate({ sid: sessionId, ts: firstTime, id: firstId }) as IterableIterator<{
    id: number; role: string; content: string | null;
  }>;
  // Every `return` inside for-of closes the iterator (resets the statement).
  for (const row of rows) {
    if (++walked > PRIOR_INPUT_WALK_CAP) return null;
    if (row.role === 'user') return null;
    if (row.role !== 'event' || row.content == null) continue;
    let type: unknown;
    try { type = JSON.parse(row.content)?.type; } catch { continue; }
    if (type === 'external_message') return incomingPeerId(row as InputRow);
    if (type === 'fork_point') return null;
  }
  return null;
}

/** Derive request anchors from durable input boundaries; received replies
 * clear the context rather than creating another request. Include the input
 * preceding this page (a bounded backward walk). This also repairs legacy
 * transcripts without a DB migration, and lets a reply jump to a request not
 * loaded in the browser. */
export function attachPeerAssistantReplies(
  sessionId: string, messages: AgentSessionMessage[],
): Array<AgentSessionMessage & { peerReplyTo?: string }> {
  const ordered = orderChronologically(messages.filter((row) => row.role !== 'edit_snapshot'));
  const first = ordered[0];
  if (!first) return messages;
  let inputId = priorPeerInput(sessionId, first.tsMs ?? first.createdAt * 1000, first.id);
  const replies = new Map<number, string>();
  for (const row of ordered) {
    if (row.role === 'user') inputId = null;
    else if (row.role === 'event') {
      try {
        const event = JSON.parse(row.content);
        if (event.type === 'external_message') inputId = incomingPeerId(row);
        else if (event.type === 'fork_point') inputId = null;
      } catch { /* Other event rows do not change the input. */ }
    } else if (row.role === 'assistant' && inputId) replies.set(row.id, inputId);
  }
  return messages.map((row) => {
    const peerReplyTo = replies.get(row.id);
    return peerReplyTo ? { ...row, peerReplyTo } : row;
  });
}
