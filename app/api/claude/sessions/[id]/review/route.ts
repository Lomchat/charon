import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { db, claudeSessions } from '@/lib/db';
import { emitGlobalSessionListChanged, nextSessionPosition, resumeSession } from '@/lib/server/agent/sessionOps';

type Target =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string }
  | { type: 'custom'; instructions: string };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const target = body?.target as Target | undefined;
  if (!target || !['uncommittedChanges', 'baseBranch', 'commit', 'custom'].includes(target.type)) {
    return NextResponse.json({ error: 'invalid review target' }, { status: 400 });
  }
  if (target.type === 'baseBranch' && !target.branch?.trim()) {
    return NextResponse.json({ error: 'branch required' }, { status: 400 });
  }
  if (target.type === 'commit' && !target.sha?.trim()) {
    return NextResponse.json({ error: 'commit sha required' }, { status: 400 });
  }
  if (target.type === 'custom' && !target.instructions?.trim()) {
    return NextResponse.json({ error: 'review instructions required' }, { status: 400 });
  }
  const delivery = body?.delivery === 'detached' ? 'detached' : 'inline';
  const result = await callSessionRpc(id, 'review_session', { target, delivery });
  if (result?.ok && delivery === 'detached' && typeof result.review_thread_id === 'string') {
    const [source] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
    if (!source) return NextResponse.json({ error: 'session not found' }, { status: 404 });
    const newId = randomBytes(8).toString('hex');
    db.insert(claudeSessions).values({
      id: newId, claudeSessionId: result.review_thread_id, vpsId: source.vpsId,
      cwd: source.cwd, name: `${source.name || 'session'} (review)`, kind: 'codex',
      status: 'sleeping', permissionMode: source.permissionMode, model: source.model,
      effort: source.effort, codexConfig: source.codexConfig,
      position: nextSessionPosition(source.vpsId),
    }).run();
    try { await resumeSession(newId); } catch {}
    emitGlobalSessionListChanged(newId);
    const [session] = db.select().from(claudeSessions).where(eq(claudeSessions.id, newId)).all();
    return NextResponse.json({ ...result, session: { ...session, codexConfig: undefined } });
  }
  return NextResponse.json(result, { status: result?.ok ? 200 : result?.reason === 'unsupported' ? 501 : 400 });
}
