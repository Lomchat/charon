import { requireApiSession } from '@/lib/server/session';
import { listRoutines, runRoutine } from '@/lib/server/hub/routines';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';

/** POST: run a routine now (§14.120) — a new session, then its prompt. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  try {
    const { sessionId } = await runRoutine(id);
    return Response.json({ ok: true, sessionId, routines: listRoutines(), sync: syncAfter([sessionId]) });
  } catch (e) {
    return Response.json({ error: (e as Error)?.message ?? String(e) }, { status: 409 });
  }
}
