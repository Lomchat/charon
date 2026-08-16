import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db, claudeSessions, claudeSessionMessages } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import {
  emitGlobalSessionListChanged,
  nextSessionPosition,
  resumeSession,
} from '@/lib/server/agent/sessionOps';
import { randomBytes } from 'crypto';

/**
 * Heavy diff payloads are NOT carried into the branch: `edit_snapshot` rows are
 * 61% of all transcript bytes here (327MB of 537MB), and a fork is meant to be
 * cheap enough to make on a whim. They are side-channel rows the session GET
 * already strips and serves lazily from `.../edits` (§14.41), so the branch
 * loses the DIFFS of inherited edits — not the tool cards, not the answers —
 * and the source session still has every one of them.
 */
const UNCOPIED_ROLES = ['edit_snapshot'];

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

  // ── Carry the conversation across ───────────────────────────────────────
  // The SDK copied the CLI transcript, so the MODEL remembers everything. Our
  // transcript lives in SQLite keyed on OUR session id, so without this the
  // branch renders as an empty chat against a model that has full context —
  // the worst of both. One INSERT..SELECT: a 15k-row session is ~15MB and must
  // not travel through JS.
  //
  // Two columns are deliberately NULLED on the copies:
  //   seq      — replay identity (§14.31). The branch's durable event log
  //              restarts at 1, and the idempotence gate is a SET of row seqs,
  //              so inherited rows carrying seq 1..N would convince it the
  //              branch's own first N events were already persisted and it
  //              would swallow them.
  //   cli_uuid — fork REMAPS every uuid, so an inherited uuid names an entry
  //              that does not exist in the new transcript. Nulling it removes
  //              "fork from here" on inherited messages (§14.94 only offers it
  //              where the anchor exists) instead of branching at a bogus one.
  // ts_ms is KEPT: wall-clock has no epochs (§14.71), so inherited rows sort
  // correctly against anything the branch produces from now on.
  let cutoffId: number | null = null;
  if (upToMessageId) {
    const [anchor] = db.select({ rid: claudeSessionMessages.id })
      .from(claudeSessionMessages)
      .where(and(
        eq(claudeSessionMessages.sessionId, id),
        eq(claudeSessionMessages.cliUuid, upToMessageId),
      )).all();
    if (anchor) cutoffId = anchor.rid;
  }
  let copied = 0;
  try {
    const res: any = db.run(sql`
      INSERT INTO claude_session_messages
        (session_id, role, content, wire_content, model, seq, cli_uuid, ts_ms, created_at)
      SELECT ${newId}, role, content, wire_content, model, NULL, NULL, ts_ms, created_at
        FROM claude_session_messages
       WHERE session_id = ${id}
         AND role NOT IN (${sql.join(UNCOPIED_ROLES.map((r) => sql`${r}`), sql`, `)})
         ${cutoffId != null ? sql`AND id <= ${cutoffId}` : sql``}
       ORDER BY id
    `);
    copied = Number(res?.changes ?? 0);
  } catch {
    // A branch with no history is still a usable branch — the model has the
    // context either way. Do not fail the fork over the convenience copy.
  }

  // The boundary marker. Everything above came from the source; everything
  // below is this branch's own. Same shape as the compaction marker: a durable
  // role='event' row, already in NON_PAGINATED_ROLES (§14.25).
  db.insert(claudeSessionMessages).values({
    sessionId: newId,
    role: 'event',
    content: JSON.stringify({
      type: 'fork_point',
      fromId: id,
      fromName: src.name || null,
      ...(cutoffId != null ? { partial: true } : {}),
    }),
    tsMs: Date.now(),
  }).run();

  // Start it. A branch you have to wake up before using reads as a failure,
  // and resume already knows how to bring a session up from a transcript id
  // (re-reading model/effort from the row we just wrote, §14.35). If it fails
  // the row stays 'sleeping' and resumable — the fork itself already worked.
  let started = false;
  try {
    await resumeSession(newId);
    started = true;
  } catch {}

  emitGlobalSessionListChanged(newId);
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, newId)).all();
  return NextResponse.json({ ok: true, session: row, forkedFrom: id, copied, started });
}
