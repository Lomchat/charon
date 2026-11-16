import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, agentSessions, sessionPendingPermissions, sessionPendingQuestions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { markSummaryDirty } from '@/lib/server/sync/syncBus';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';

/** Unattended on (`{unattended:true}`) or off (CLAUDE.md §14.119). On: the
 *  hub refuses every card this session raises from now on — and the ones
 *  already waiting — with a reason the model reads. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (typeof body?.unattended !== 'boolean') {
    return NextResponse.json({ error: 'unattended must be true or false' }, { status: 400 });
  }
  const on = body.unattended as boolean;
  const changed = db.update(agentSessions).set({ unattended: on ? 1 : 0 })
    .where(eq(agentSessions.id, id)).run().changes;
  if (!changed) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  markSummaryDirty(id);
  let declined = 0;
  if (on) {
    const stream = getOrCreateStream(id);
    if (stream) {
      const perms = db.select({ id: sessionPendingPermissions.id }).from(sessionPendingPermissions)
        .where(and(eq(sessionPendingPermissions.sessionId, id), eq(sessionPendingPermissions.status, 'pending'))).all();
      const questions = db.select({ id: sessionPendingQuestions.id }).from(sessionPendingQuestions)
        .where(and(eq(sessionPendingQuestions.sessionId, id), eq(sessionPendingQuestions.status, 'pending'),
          eq(sessionPendingQuestions.kind, 'question'))).all();
      const results = await Promise.all([
        ...perms.map((p) => stream._declineUnattended('permission', p.id)),
        ...questions.map((q) => stream._declineUnattended('question', q.id)),
      ]);
      declined = results.filter(Boolean).length;
      if (declined) markSummaryDirty(id);
    }
  }
  return NextResponse.json({ ok: true, unattended: on, declined, sync: syncAfter([id]) });
}
