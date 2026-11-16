import { NextResponse } from 'next/server';
import { and, asc, eq, inArray, not, or, like } from 'drizzle-orm';
import { db, sessionMessages, agentSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { invalidateSessionRowCaches } from '@/lib/server/agent/sessionRowCache';
import { deleteSessionGates, type GateRef } from '@/lib/server/agent/pendingInteractions';
import { emitGlobalTranscriptReset, publishInteractionResolved, setSessionStatusLocal } from '@/lib/server/agent/sessionOps';
import { forgetFirstUserMessage, syncAfter } from '@/lib/server/sync/sessionSummaries';
import { markSummaryDirty } from '@/lib/server/sync/syncBus';
import type { WorkerStatus } from '@/lib/types/api';
import { orderChronologically } from '@/lib/server/hub/messageOrder';
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

  const [session] = db.select().from(agentSessions).where(eq(agentSessions.id, id)).all();
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  // ⚠ Refused on the capability BEFORE anything else. A backend with
  // `rewind:'none'` used to fall through to Claude's transcript fork, and this
  // route then persisted `nativeSessionId: null` — for every backend but
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
    id: sessionMessages.id,
    role: sessionMessages.role,
    cliUuid: sessionMessages.cliUuid,
    tsMs: sessionMessages.tsMs,
  }).from(sessionMessages)
    .where(eq(sessionMessages.sessionId, id))
    .orderBy(asc(sessionMessages.id)).all());
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
  let gates: GateRef[] = [];
  let newStatus: WorkerStatus | null = null;
  db.transaction((tx) => {
    // Stay below SQLite's variable limit on unusually dense tool histories.
    for (let offset = 0; offset < ids.length; offset += 400) {
      const result = tx.delete(sessionMessages).where(and(
        eq(sessionMessages.sessionId, id),
        inArray(sessionMessages.id, ids.slice(offset, offset + 400)),
        // Rewinding context does not refund requests already sent.
        not(and(eq(sessionMessages.role, 'event'), or(
          like(sessionMessages.content, '%"type":"endpoint_usage"%'),
          like(sessionMessages.content, '%"type":"turn_usage"%'),
        ))!),
      )).run();
      removed += result.changes;
    }
    gates = deleteSessionGates(id);
    if (Object.prototype.hasOwnProperty.call(native, 'claude_session_id')) {
      // A native rewind never stopped the session; the transcript fork
      // restarts it, so it re-enters 'starting'.
      newStatus = hasNativeCapability(kind, 'rewind') ? 'active' : 'starting';
      tx.update(agentSessions).set({
        nativeSessionId: native.claude_session_id ?? null,
        status: newStatus,
        sleepRequested: 0, resumePending: 0,
      }).where(eq(agentSessions.id, id)).run();
    }
  });
  // Every view of this transcript re-windows (the rows are gone, not new).
  emitGlobalTranscriptReset(id, 'rollback');
  // The first prompt may have gone with the suffix.
  forgetFirstUserMessage(id);
  // Memory and every tab follow the DB status written above (S6).
  if (newStatus) setSessionStatusLocal(id, newStatus, { persist: false });
  markSummaryDirty(id);
  // The rewound history took its gates: publish each removal (G7).
  for (const gate of gates) publishInteractionResolved(id, gate.kind, gate.id, 'cancelled');
  // bg_task rows may have gone with the suffix (usage rows never do): the
  // incremental row folds must not keep them (I11, sessionRowCache.ts).
  invalidateSessionRowCaches(id);

  return NextResponse.json({
    ok: true, messageId: `m${messageId}`, numTurns,
    removedMessages: removed, strategy: native.strategy ?? 'fork',
    sync: syncAfter([id]),
  });
}
