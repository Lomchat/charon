import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import {
  deleteSession, emitGlobalSessionListChanged, getOrCreateStream,
  nextSessionPosition, resumeSession,
} from '@/lib/server/agent/sessionOps';
import { allocateSessionHandle } from '@/lib/server/agent/sessionHandles';
import { buildClaudeReviewPrompt, type ReviewTarget } from '@/lib/server/claude/reviewPrompt';

function normalizeTarget(value: unknown): ReviewTarget | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === 'uncommittedChanges') return { type: raw.type };
  if (raw.type === 'baseBranch') {
    const branch = typeof raw.branch === 'string' ? raw.branch.trim().slice(0, 256) : '';
    return branch ? { type: raw.type, branch } : null;
  }
  if (raw.type === 'commit') {
    const sha = typeof raw.sha === 'string' ? raw.sha.trim().slice(0, 256) : '';
    return sha ? { type: raw.type, sha } : null;
  }
  if (raw.type === 'custom') {
    const instructions = typeof raw.instructions === 'string'
      ? raw.instructions.trim().slice(0, 16_384) : '';
    return instructions ? { type: raw.type, instructions } : null;
  }
  return null;
}

async function startInlineReview(sessionId: string, kind: string, target: ReviewTarget) {
  if (kind === 'claude') {
    const stream = getOrCreateStream(sessionId);
    if (!stream) throw new Error('session not found');
    await stream.sendUserMessage(buildClaudeReviewPrompt(target));
    return { ok: true, delivery: 'inline', strategy: 'review_prompt' };
  }
  const result = await callSessionRpc(sessionId, 'review_session', { target, delivery: 'inline' });
  if (!result?.ok) throw new Error(result?.error || 'Codex review did not start');
  return result;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const target = normalizeTarget(body?.target);
  if (!target) return NextResponse.json({ error: 'invalid or incomplete review target' }, { status: 400 });
  const delivery = body?.delivery === 'detached' ? 'detached' : 'inline';

  const [source] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!source) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  if (source.archived) return NextResponse.json({ error: 'unarchive the session before reviewing' }, { status: 409 });

  if (delivery === 'inline') {
    try {
      const result = await startInlineReview(id, source.kind, target);
      return NextResponse.json(result);
    } catch (e: any) {
      const message = String(e?.message || e);
      return NextResponse.json({ error: message }, {
        status: /-32601|no such method/i.test(message) ? 501 : 400,
      });
    }
  }

  if (!source.claudeSessionId) {
    return NextResponse.json({ error: 'send a message before creating a separate review session' }, { status: 400 });
  }
  const name = `${source.name || 'session'} (review)`;
  let forked: { ok?: boolean; claude_session_id?: string; error?: string; reason?: string };
  try {
    forked = await callSessionRpc(id, 'fork_session', { title: name });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
  if (!forked?.ok || typeof forked.claude_session_id !== 'string') {
    return NextResponse.json({ error: forked?.error || 'review fork returned no native session id' }, {
      status: forked?.reason === 'unsupported' ? 501 : 400,
    });
  }

  const newId = randomBytes(8).toString('hex');
  const handle = allocateSessionHandle(source.vpsId, { id: newId, name, cwd: source.cwd });
  db.insert(claudeSessions).values({
    id: newId, claudeSessionId: forked.claude_session_id, vpsId: source.vpsId,
    cwd: source.cwd, name, handle, kind: source.kind,
    status: 'sleeping', permissionMode: source.permissionMode,
    model: source.model, fallbackModel: source.fallbackModel,
    effort: source.effort, codexConfig: source.codexConfig,
    position: nextSessionPosition(source.vpsId),
  }).run();
  try {
    await resumeSession(newId);
    const result = await startInlineReview(newId, source.kind, target);
    emitGlobalSessionListChanged(newId);
    const [session] = db.select().from(claudeSessions).where(eq(claudeSessions.id, newId)).all();
    return NextResponse.json({
      ...result, ok: true, delivery: 'detached',
      review_thread_id: forked.claude_session_id,
      session: { ...session, codexConfig: undefined },
    });
  } catch (e: any) {
    await deleteSession(newId);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
