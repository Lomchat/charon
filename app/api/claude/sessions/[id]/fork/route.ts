import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalSessionListChanged, nextSessionPosition } from '@/lib/server/agent/sessionOps';
import { randomBytes } from 'crypto';

/**
 * POST /api/claude/sessions/[id]/fork
 *   body: { upToMessageId?: string, name?: string }
 *
 * Branch a session's transcript into a NEW session.
 *
 * Why this exists: the Anthropic-side session is bound to the model it was
 * created with, so "change the model on a running session" was a dead end the
 * UI could only warn about (§14.35). More generally there was no way to try a
 * different direction without destroying the current one.
 *
 * The fork is PURE FILE WORK on the VPS — the SDK copies the transcript and
 * remaps every uuid — so the source session keeps running, untouched. That is
 * the property that makes this safe to offer mid-conversation.
 *
 * `upToMessageId` is a CLI transcript uuid (claude_session_messages.cli_uuid),
 * not one of our row ids: the SDK identifies the branch point by ITS id.
 * Omitted = fork the whole conversation.
 *
 * The new session is created SLEEPING with the forked transcript id. It has no
 * agent-side session until the user resumes it — forking should cost nothing
 * until you actually use the branch.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;

  const [src] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!src) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  if (src.kind === 'codex') {
    // Codex threads have no fork primitive (§14.59) — and silently forking
    // something else would be worse than saying so.
    return NextResponse.json({ error: 'forking is Claude-only' }, { status: 400 });
  }
  if (!src.claudeSessionId) {
    return NextResponse.json(
      { error: 'this session has no transcript yet — send a message first' },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const upToMessageId = typeof body?.upToMessageId === 'string' ? body.upToMessageId : undefined;
  const name = typeof body?.name === 'string' && body.name.trim()
    ? body.name.trim()
    : `${src.name || 'session'} (fork)`;

  let forked: { claude_session_id?: string } | null = null;
  try {
    const client = getAgentClientForVpsId(src.vpsId);
    forked = await client.call('fork_session', {
      session_id: id,
      ...(upToMessageId ? { up_to_message_id: upToMessageId } : {}),
      title: name,
    }) as { claude_session_id?: string };
  } catch (e: any) {
    // Agent too old (-32601), transcript missing, unknown message uuid — all
    // arrive here. Surface the reason rather than a generic failure: "that
    // message is not in this transcript" is actionable, "fork failed" is not.
    const msg = String(e?.message || e);
    const status = /-32601|no such method|cannot fork/i.test(msg) ? 501 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
  if (!forked?.claude_session_id) {
    return NextResponse.json({ error: 'fork returned no session id' }, { status: 500 });
  }

  const newId = randomBytes(8).toString('hex');
  db.insert(claudeSessions).values({
    id: newId,
    claudeSessionId: forked.claude_session_id,
    vpsId: src.vpsId,
    cwd: src.cwd,
    name,
    kind: 'claude',
    // Sleeping, not starting: the branch costs nothing until it is used, and
    // resume already knows how to bring up a session from a transcript id.
    status: 'sleeping',
    permissionMode: src.permissionMode,
    // Inherit the shape of the conversation it came from — a fork that
    // silently changed model or effort would not be the same experiment.
    model: src.model,
    fallbackModel: src.fallbackModel,
    effort: src.effort,
    position: nextSessionPosition(src.vpsId),
  }).run();

  emitGlobalSessionListChanged(newId);
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, newId)).all();
  return NextResponse.json({ ok: true, session: row, forkedFrom: id });
}
