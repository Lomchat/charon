import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db, sessionPendingQuestions, type AgentSessionMessage } from '@/lib/db';
import { parseAsyncQuestion } from '@/lib/asyncQuestions';

/** Hydrate resolved forms even when their answer lies outside this history page. */
export function attachAsyncQuestionState(sessionId: string, messages: AgentSessionMessage[]): AgentSessionMessage[] {
  const ids = messages.filter((m) => m.role === 'async_question')
    .flatMap((m) => { const q = parseAsyncQuestion(m.content); return q ? [q.id] : []; });
  if (!ids.length) return messages;
  const rows = db.select().from(sessionPendingQuestions).where(and(
    eq(sessionPendingQuestions.sessionId, sessionId),
    eq(sessionPendingQuestions.kind, 'async_question'),
    inArray(sessionPendingQuestions.id, ids),
  )).all();
  const byId = new Map(rows.map((q) => [q.id, q]));
  return messages.map((m) => {
    if (m.role !== 'async_question') return m;
    const q = parseAsyncQuestion(m.content);
    const row = q && byId.get(q.id);
    if (!q) return m;
    if (!row) return { ...m, content: JSON.stringify({ ...q, status: 'unavailable', answers: null }) };
    return { ...m, content: JSON.stringify({ ...q, status: row.status,
      answers: row.status === 'answered' && row.answers ? JSON.parse(row.answers) : null }) };
  });
}
