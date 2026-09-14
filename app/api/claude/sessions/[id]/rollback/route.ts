import { NextResponse } from 'next/server';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  db, claudePendingPermissions, claudePendingQuestions,
  claudeSessionMessages, claudeSessions,
} from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { orderChronologically } from '@/lib/server/claude/messageOrder';
import {
  PROVIDERS, asSessionProvider, hasNativeCapability, supportsSessionCapability,
} from '@/lib/sessionCapabilities';

/** Rewind both providers before one visible user message.
 *
 * Native history is changed first: Codex swaps to a fork at its previous
 * completed turn; Claude swaps to a transcript fork at the last retained CLI
 * message (or starts fresh before the first prompt). Only after that succeeds
 * do we remove the same chronological suffix from SQLite. Files are untouched.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const match = /^m(\d+)$/.exec(String(body?.messageId ?? ''));
  const messageId = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(messageId) || messageId < 1) {
    return NextResponse.json({ error: 'choose a persisted user message to rewind to' }, { status: 400 });
  }

  const [session] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  // ⚠ Refused on the capability BEFORE anything else. A backend with
  // `rewind:'none'` used to fall through to Claude's transcript fork, and this
  // route then persisted `claudeSessionId: null` — for every backend but
  // Claude that column is the only resume handle, so the conversation was
  // gone and nothing said so (§14.103).
  const kind = asSessionProvider(session.kind);
  if (!supportsSessionCapability(kind, 'rewind')) {
    return NextResponse.json(
      { error: `${PROVIDERS[kind].label} sessions cannot be rewound` },
      { status: 400 },
    );
  }
  if (session.archived) {
    return NextResponse.json({ error: 'unarchive the session before rewinding it' }, { status: 409 });
  }
  if (session.status === 'sleeping' || session.status === 'error') {
    return NextResponse.json({ error: 'resume the session before rewinding it' }, { status: 409 });
  }

  const ordered = orderChronologically(db.select({
    id: claudeSessionMessages.id,
    role: claudeSessionMessages.role,
    cliUuid: claudeSessionMessages.cliUuid,
    tsMs: claudeSessionMessages.tsMs,
  }).from(claudeSessionMessages)
    .where(eq(claudeSessionMessages.sessionId, id))
    .orderBy(asc(claudeSessionMessages.id)).all());
  const cutoffIndex = ordered.findIndex((row) => row.id === messageId && row.role === 'user');
  if (cutoffIndex < 0) {
    return NextResponse.json({ error: 'that user message is no longer in this session' }, { status: 409 });
  }

  const removedRows = ordered.slice(cutoffIndex);
  const numTurns = removedRows.filter((row) => row.role === 'user').length;
  if (numTurns < 1 || numTurns > 100) {
    return NextResponse.json({ error: 'a rewind can remove at most 100 user turns' }, { status: 400 });
  }
  const previousCliMessage = ordered.slice(0, cutoffIndex).reverse()
    .find((row) => typeof row.cliUuid === 'string' && row.cliUuid.length > 0)?.cliUuid ?? null;

  let native: { claude_session_id?: string | null; strategy?: string };
  try {
    native = await getAgentClientForVpsId(session.vpsId).call('rollback_session', {
      session_id: id,
      // A NATIVE rewind counts turns; an adapted one branches the transcript
      // at a CLI anchor. Read from the registry so a fourth backend declaring
      // `rewind:'native'` does not need an edit here (§14.102).
      ...(hasNativeCapability(kind, 'rewind')
        ? { num_turns: numTurns }
        : { up_to_message_id: previousCliMessage }),
    }) as typeof native;
  } catch (e: any) {
    const message = String(e?.message || e);
    return NextResponse.json({ error: message }, {
      status: /-32601|no such method/i.test(message) ? 501 : 400,
    });
  }

  const ids = removedRows.map((row) => row.id);
  let removed = 0;
  db.transaction((tx) => {
    // Stay below SQLite's variable limit on unusually dense tool histories.
    for (let offset = 0; offset < ids.length; offset += 400) {
      const result = tx.delete(claudeSessionMessages).where(and(
        eq(claudeSessionMessages.sessionId, id),
        inArray(claudeSessionMessages.id, ids.slice(offset, offset + 400)),
      )).run();
      removed += result.changes;
    }
    tx.delete(claudePendingPermissions).where(eq(claudePendingPermissions.sessionId, id)).run();
    tx.delete(claudePendingQuestions).where(eq(claudePendingQuestions.sessionId, id)).run();
    if (Object.prototype.hasOwnProperty.call(native, 'claude_session_id')) {
      tx.update(claudeSessions).set({
        claudeSessionId: native.claude_session_id ?? null,
        // A native rewind never stopped the session; the transcript fork
        // restarts it, so it re-enters 'starting'.
        status: hasNativeCapability(kind, 'rewind') ? 'active' : 'starting',
        sleepRequested: 0, resumePending: 0,
      }).where(eq(claudeSessions.id, id)).run();
    }
  });

  return NextResponse.json({
    ok: true, messageId: `m${messageId}`, numTurns,
    removedMessages: removed, strategy: native.strategy ?? 'fork',
  });
}
