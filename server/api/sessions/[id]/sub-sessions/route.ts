import { eq } from 'drizzle-orm';
import { requireApiSession } from '@/lib/server/session';
import { db, agentSessions } from '@/lib/db';
import { markSummaryDirty } from '@/lib/server/sync/syncBus';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';

// POST /api/sessions/[id]/sub-sessions  { open: boolean }
// Its sub-sessions shown or folded in the sidebar: a hub fact (a summary
// field), so every tab and device follows. Folded by default (§14.93).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (typeof body?.open !== 'boolean') return Response.json({ error: 'open must be true or false' }, { status: 400 });
  const res = db.update(agentSessions).set({ subSessionsOpen: body.open ? 1 : 0 })
    .where(eq(agentSessions.id, id)).run();
  if (!((res as { changes?: number }).changes ?? 0)) return Response.json({ error: 'session not found' }, { status: 404 });
  markSummaryDirty(id);
  return Response.json({ ok: true, open: body.open, sync: syncAfter([id]) });
}
