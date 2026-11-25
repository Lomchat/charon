import { requireApiSession } from '@/lib/server/session';
import { readSessionOutput } from '@/lib/server/hub/sessionOutput';

// GET /api/sessions/[id]/activity?before=<rowId>|after=<rowId>
// The session's own transcript as background-work output (a sub-session in
// its parent's bar, §14.91): the WorkflowOutputResponse shape, paged by row id.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const num = (key: string) => {
    const raw = url.searchParams.get(key);
    if (raw == null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  const page = readSessionOutput(id, { before: num('before'), after: num('after') });
  if (!page) return Response.json({ ok: false, error: 'session not found' }, { status: 404 });
  return Response.json(page);
}
