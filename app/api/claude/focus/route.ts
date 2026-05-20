import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { setConnectionFocus } from '@/lib/server/agent/eventConnections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/claude/focus
// Body: { conn: string; sessionId: string | null }
//
// Changes the focus of a multiplexed SSE connection (cf. /api/claude/events).
// High-volume streaming (assistant_text, tool_*, edit_snapshot...) follows
// the new session without needing to close/reopen the SSE.
//
// The client must in parallel GET /api/claude/sessions/[id] to fetch the
// persisted history of the new session — the SSE replays nothing.
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const conn = body?.conn;
  if (typeof conn !== 'string' || conn.length < 8) {
    return NextResponse.json({ error: 'missing conn' }, { status: 400 });
  }
  const sessionId = body?.sessionId;
  if (sessionId != null && typeof sessionId !== 'string') {
    return NextResponse.json({ error: 'sessionId must be string or null' }, { status: 400 });
  }

  const ok = setConnectionFocus(conn, sessionId ?? null);
  // If false: the connection does not exist (SSE not yet opened or already
  // closed). Not a fatal error — the client can retry.
  return NextResponse.json({ ok });
}
