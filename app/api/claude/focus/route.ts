import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { setConnectionFocus } from '@/lib/server/agent/eventConnections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/claude/focus
// Body: { conn: string; sessionId: string | null }
//
// Change le focus d'une connexion SSE multiplexée (cf. /api/claude/events).
// Le streaming high-volume (assistant_text, tool_*, edit_snapshot…) suit la
// nouvelle session sans qu'on ait besoin de close/reopen la SSE.
//
// Le client doit en parallèle GET /api/claude/sessions/[id] pour récupérer
// l'historique persisté de la nouvelle session — la SSE ne replay rien.
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
  // Si false : la connexion n'existe pas (SSE pas encore ouverte ou déjà
  // fermée). Pas une erreur fatale — le client peut retry.
  return NextResponse.json({ ok });
}
