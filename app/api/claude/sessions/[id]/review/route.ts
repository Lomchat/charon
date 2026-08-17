import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { db, claudeSessions } from '@/lib/db';
import {
  deleteSession,
  emitGlobalSessionListChanged,
  nextSessionPosition,
  resumeSession,
} from '@/lib/server/agent/sessionOps';

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
  if (delivery === 'detached') {
    const [source] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
    if (!source) return NextResponse.json({ error: 'session not found' }, { status: 404 });
    if (source.kind !== 'codex') {
      return NextResponse.json({ error: 'native review is only supported for Codex sessions' }, { status: 400 });
    }

    // review/start(delivery=detached) creates its child on the SOURCE
    // app-server connection. That connection then owns the child's native
    // writer lock, while the new Charon session starts a different app-server
    // and cannot resume it. Instead, make a transferable native fork through
    // fork_session's short-lived SDK client, resume that fork as the new
    // Charon session, and run the review inline there. Product semantics stay
    // "review in a new session" without two app-servers fighting over a thread.
    const name = `${source.name || 'session'} (review)`;
    const forked = await callSessionRpc(id, 'fork_session', { title: name });
    if (!forked?.ok || typeof forked.claude_session_id !== 'string') {
      return NextResponse.json({
        error: forked?.error || 'Codex review fork returned no thread id',
      }, { status: forked?.reason === 'unsupported' ? 501 : 400 });
    }

    const newId = randomBytes(8).toString('hex');
    db.insert(claudeSessions).values({
      id: newId, claudeSessionId: forked.claude_session_id, vpsId: source.vpsId,
      cwd: source.cwd, name, kind: 'codex',
      status: 'sleeping', permissionMode: source.permissionMode, model: source.model,
      effort: source.effort, codexConfig: source.codexConfig,
      position: nextSessionPosition(source.vpsId),
    }).run();
    try {
      await resumeSession(newId);
      const result = await callSessionRpc(newId, 'review_session', {
        target,
        delivery: 'inline',
      });
      if (!result?.ok) throw new Error(result?.error || 'Codex review did not start');
      emitGlobalSessionListChanged(newId);
      const [session] = db.select().from(claudeSessions).where(eq(claudeSessions.id, newId)).all();
      return NextResponse.json({
        ...result,
        review_thread_id: forked.claude_session_id,
        session: { ...session, codexConfig: undefined },
      });
    } catch (e: any) {
      await deleteSession(newId);
      return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
    }
  }

  const result = await callSessionRpc(id, 'review_session', { target, delivery: 'inline' });
  return NextResponse.json(result, { status: result?.ok ? 200 : result?.reason === 'unsupported' ? 501 : 400 });
}
