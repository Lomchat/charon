import { requireApiSession } from '@/lib/server/session';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { defaultSessionMode, isSessionMode } from '@/lib/sessionCapabilities';

// POST /api/sessions/[id]/mode { mode }
// Kind-aware:
//   claude → 'normal' | 'acceptEdits' | 'auto' (native classifier) | 'bypass'
//   codex  → 'read-only' | 'workspace-write' | 'accept-all' — the CLI's Read
//            Only / Default / Full Access presets (§ CodexSandboxMode).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getOrCreateStream(id);
  if (!stream) return Response.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const mode = isSessionMode(stream.kind, body?.mode)
    ? body.mode
    : defaultSessionMode(stream.kind, 'runtime');
  try {
    await stream.setPermissionMode(mode as any);
    return Response.json({ ok: true, mode, sync: syncAfter([id]) });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
