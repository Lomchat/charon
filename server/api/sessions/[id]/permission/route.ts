import { requireApiSession } from '@/lib/server/session';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { emitGlobalTabsChanged, getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { pinTabForRef } from '@/lib/server/hub/tabs';

// POST /api/sessions/[id]/permission
// Body: { id: permId, allow: bool, always?: bool, suggestion?: int }
//   always     Codex's native session grant
//   suggestion Claude: index of the CLI's "don't ask again" option picked
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getOrCreateStream(id);
  if (!stream) return Response.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json();
  const permId = String(body.id ?? '').trim();
  if (!permId) return Response.json({ error: 'permId required' }, { status: 400 });
  const suggestion = body.suggestion;
  if (suggestion != null && !(Number.isInteger(suggestion) && suggestion >= 0)) {
    return Response.json({ error: 'suggestion must be a non-negative integer' }, { status: 400 });
  }
  try {
    await stream.respondPermission(
      permId, Boolean(body.allow), Boolean(body.always), suggestion ?? undefined,
    );
    // Answering is working in the session: its tab stops being a preview (§14.78).
    if (pinTabForRef('session', id)) emitGlobalTabsChanged();
    return Response.json({ ok: true, sync: syncAfter([id]) });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
