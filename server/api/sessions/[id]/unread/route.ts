import { requireApiSession } from '@/lib/server/session';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { markSessionUnread } from '@/lib/server/agent/sessionOps';
import { keepUnreadOnLeave } from '@/lib/server/agent/eventConnections';

// POST /api/sessions/[id]/unread  { conn?: string }
// The header's "unread" button: the session is left for later, lit like an
// unread finish (CLAUDE.md §14.47). `conn` = the SSE connection that is about
// to move off it: that move reads nothing (whichever POST lands first).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const conn = typeof body?.conn === 'string' && body.conn.length >= 8 ? body.conn as string : null;
  if (conn) keepUnreadOnLeave(conn, id);
  if (!markSessionUnread(id)) return Response.json({ error: 'session not found' }, { status: 404 });
  return Response.json({ ok: true, sync: syncAfter([id]) });
}
