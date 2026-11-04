import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { noteConnectionAttention, setConnectionFocus } from '@/lib/server/agent/eventConnections';
import { markSessionRead } from '@/lib/server/agent/sessionOps';
import { markShellRead } from '@/lib/server/agent/shellNotify';
import { currentRev } from '@/lib/server/sync/syncBus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/focus
// Body: { conn: string; sessionId: string | null; focusSeq: number;
//         visible?: boolean; attentive?: boolean; attentiveAgeMs?: number;
//         kind?: 'focus' | 'attention' }
// → { ok, applied, focus, focusSeq, sync } (kind 'focus'); { ok } (attention).
//
// Changes the focus of a multiplexed SSE connection (cf. /api/events).
// High-volume streaming (assistant_text, tool_*, edit_snapshot...) follows
// the new session without needing to close/reopen the SSE.
//
// The client must in parallel GET /api/sessions/[id] to fetch the
// persisted history of the new session — the SSE replays nothing.
//
// `kind:'attention'` = "a human is at this device" (input after an idle spell,
// then periodically): revives the conn's ATTENDED state and acknowledges the
// session it shows. Only an attended view reads a finish (CLAUDE.md §14.47).
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  // Same cold-start safety net as GET /api/events (CLAUDE.md §14.45):
  // covers the rare ordering where a focus POST lands before the SSE GET after
  // a restart. Idempotent.
  try { seedInitialData(); } catch {}

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const conn = body?.conn;
  if (typeof conn !== 'string' || conn.length < 8) {
    return NextResponse.json({ error: 'missing conn' }, { status: 400 });
  }
  const kind = body?.kind ?? 'focus';
  if (kind !== 'focus' && kind !== 'attention') {
    return NextResponse.json({ error: "kind must be 'focus' or 'attention'" }, { status: 400 });
  }
  if (kind === 'attention') {
    // Attention proves a human is looking at whatever this conn shows: a
    // visible focused session is read. Focus itself is untouched.
    const att = noteConnectionAttention(conn);
    if (att.ok && att.visible && att.focus) {
      try { markSessionRead(att.focus); } catch {}
      markShellRead(att.focus);
    }
    return NextResponse.json({ ok: att.ok });
  }
  const sessionId = body?.sessionId;
  if (sessionId != null && typeof sessionId !== 'string') {
    return NextResponse.json({ error: 'sessionId must be string or null' }, { status: 400 });
  }

  const focusSeq = Number(body?.focusSeq);
  if (!Number.isSafeInteger(focusSeq) || focusSeq < 1) {
    return NextResponse.json({ error: 'focusSeq must be a positive integer' }, { status: 400 });
  }
  const visible = body?.visible !== false;
  // Absent (a pre-attention client) ⇒ undefined: that conn keeps "attended =
  // visible" and its POSTs acknowledge as they always did.
  const attentive = typeof body?.attentive === 'boolean' ? body.attentive as boolean : undefined;
  // Age of the client's last input: the proof is dated by it, not by this
  // POST (a re-POST without input must not extend the attention window).
  const ageRaw = Number(body?.attentiveAgeMs);
  const attentiveAgeMs = body?.attentiveAgeMs != null && Number.isFinite(ageRaw) && ageRaw >= 0 ? ageRaw : undefined;
  const result = setConnectionFocus(conn, sessionId ?? null, focusSeq, visible, { attentive, attentiveAgeMs });

  // A visible, ATTENDED, current focus is a read acknowledgement. An older
  // visible POST arriving after a hide must not clear a finish that occurred
  // while hidden, and an idle device (`attentive:false`) reads nothing. A POST
  // racing SSE registration still acknowledges the user's view.
  if (visible && attentive !== false && typeof sessionId === 'string' && sessionId.length > 0
    && (!result.ok || (result.focusSeq === focusSeq && result.focus === sessionId))) {
    try { markSessionRead(sessionId); } catch {}
    // The focus may be a shell (16 hex, never a session id): same ack.
    markShellRead(sessionId);
  }

  // If `ok` is false: the connection does not exist (SSE not yet opened or
  // already closed). Not a fatal error — the client can retry (a proto-2
  // client reconnects its SSE). `sync`: the bus revision after the apply and
  // the read-ack (whose `session_unread` frame it covers).
  return NextResponse.json({ ...result, sync: currentRev() });
}
