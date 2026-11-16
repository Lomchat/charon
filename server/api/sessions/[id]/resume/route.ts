import { requireApiSession } from '@/lib/server/session';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { resumeSession } from '@/lib/server/agent/sessionOps';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  try {
    const stream = await resumeSession(id);
    return Response.json({ ok: true, status: stream.status, sync: syncAfter([id]) });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
