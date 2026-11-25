import { eq } from 'drizzle-orm';
import { db, agentSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { archiveSession, unarchiveSession } from '@/lib/server/hub/sessionArchive';

async function rowFor(id: string) {
  return db.select().from(agentSessions).where(eq(agentSessions.id, id)).get() ?? null;
}

/** Archive (`lib/server/hub/sessionArchive.ts`), or unarchive (DELETE);
 *  both carry the session's sub-sessions along (§14.93). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = await rowFor(id);
  if (!row) return Response.json({ error: 'session not found' }, { status: 404 });
  try {
    await archiveSession(id);
    return Response.json({ ok: true, archived: true, sync: syncAfter([id]) });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = await rowFor(id);
  if (!row) return Response.json({ error: 'session not found' }, { status: 404 });
  try {
    // Its sub-sessions archived along come back with it (§14.93).
    await unarchiveSession(id);
    return Response.json({ ok: true, archived: false, sync: syncAfter([id]) });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
