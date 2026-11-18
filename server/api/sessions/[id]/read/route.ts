import { requireApiSession } from '@/lib/server/session';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { markSessionRead } from '@/lib/server/agent/sessionOps';

// POST /api/sessions/[id]/read — the user acted on the open session (a click,
// a key, a wheel scroll in SessionView): the same acknowledgement as leaving it
// (CLAUDE.md §14.47). Idempotent; `sync` covers the summary frame clearing it.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  markSessionRead(id);
  return Response.json({ ok: true, sync: syncAfter([id]) });
}
