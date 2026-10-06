import 'server-only';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { db, claudeSessionMessages, type ClaudeSessionMessage } from '@/lib/db';
import { orderChronologically } from './messageOrder';

type InputRow = Pick<ClaudeSessionMessage, 'id' | 'role' | 'content'>;

function incomingPeerId(row: InputRow): string | null {
  if (row.role !== 'event') return null;
  try {
    const event = JSON.parse(row.content);
    return event.type === 'external_message'
      ? typeof event.messageId === 'string' ? event.messageId : `m${row.id}`
      : null;
  } catch { return null; }
}

/** Derive reply anchors from durable input boundaries, including the input
 * preceding this page. This also repairs legacy transcripts without a DB
 * migration, and lets a reply jump to a request not loaded in the browser. */
export function attachPeerAssistantReplies(
  sessionId: string, messages: ClaudeSessionMessage[],
): Array<ClaudeSessionMessage & { peerReplyTo?: string }> {
  const ordered = orderChronologically(messages.filter((row) => row.role !== 'edit_snapshot'));
  const first = ordered[0];
  if (!first) return messages;
  const time = sql<number>`coalesce(${claudeSessionMessages.tsMs}, ${claudeSessionMessages.createdAt} * 1000)`;
  const inputType = sql<string>`CASE WHEN json_valid(${claudeSessionMessages.content}) THEN json_extract(${claudeSessionMessages.content}, '$.type') END`;
  const firstTime = first.tsMs ?? first.createdAt * 1000;
  const prior = db.select({ id: claudeSessionMessages.id, role: claudeSessionMessages.role, content: claudeSessionMessages.content })
    .from(claudeSessionMessages).where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      or(eq(claudeSessionMessages.role, 'user'), and(
        eq(claudeSessionMessages.role, 'event'),
        or(eq(inputType, 'external_message'), eq(inputType, 'fork_point')),
      )),
      or(sql`${time} < ${firstTime}`, and(eq(time, firstTime), sql`${claudeSessionMessages.id} < ${first.id}`)),
    )).orderBy(desc(time), desc(claudeSessionMessages.id)).limit(1).get();
  let inputId = prior ? incomingPeerId(prior) : null;
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
