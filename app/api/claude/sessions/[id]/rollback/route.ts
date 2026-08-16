import { NextResponse } from 'next/server';
import { and, desc, eq, gte } from 'drizzle-orm';
import {
  db, claudePendingPermissions, claudePendingQuestions,
  claudeSessionMessages, claudeSessions,
} from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';

/** Drop the last N Codex turns from BOTH model history and Charon's replay.
 * Files are deliberately untouched: app-server's deprecated rollback primitive
 * only rewinds conversation context, so the confirmation UI says that plainly. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const numTurns = Number(body?.numTurns);
  if (!Number.isInteger(numTurns) || numTurns < 1 || numTurns > 100) {
    return NextResponse.json({ error: 'numTurns must be an integer from 1 to 100' }, { status: 400 });
  }
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!row) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  if (row.kind !== 'codex') {
    return NextResponse.json({ error: 'rewind is only available for Codex sessions' }, { status: 400 });
  }
  try {
    await getAgentClientForVpsId(row.vpsId).call('rollback_session', {
      session_id: id, num_turns: numTurns,
    });
  } catch (e: any) {
    const message = String(e?.message || e);
    return NextResponse.json({ error: message }, {
      status: /-32601|no such method/i.test(message) ? 501 : 400,
    });
  }

  // App-server has already committed the rollback. Mirror exactly from the
  // earliest removed user prompt onward so a browser refresh cannot resurrect
  // model-forgotten turns from SQLite.
  const userRows = db.select({ id: claudeSessionMessages.id })
    .from(claudeSessionMessages)
    .where(and(
      eq(claudeSessionMessages.sessionId, id),
      eq(claudeSessionMessages.role, 'user'),
    ))
    .orderBy(desc(claudeSessionMessages.id)).limit(numTurns).all();
  let removed = 0;
  if (userRows.length) {
    const cutoff = Math.min(...userRows.map((x) => x.id));
    db.transaction((tx) => {
      const result = tx.delete(claudeSessionMessages).where(and(
        eq(claudeSessionMessages.sessionId, id),
        gte(claudeSessionMessages.id, cutoff),
      )).run();
      removed = result.changes;
      tx.delete(claudePendingPermissions).where(eq(claudePendingPermissions.sessionId, id)).run();
      tx.delete(claudePendingQuestions).where(eq(claudePendingQuestions.sessionId, id)).run();
    });
  }
  return NextResponse.json({ ok: true, numTurns, removedMessages: removed });
}
