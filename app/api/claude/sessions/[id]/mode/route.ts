import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { defaultSessionMode, isSessionMode } from '@/lib/sessionCapabilities';

// POST /api/claude/sessions/[id]/mode { mode }
// Kind-aware:
//   claude → 'normal' | 'acceptEdits' | 'auto' | 'plan'
//   codex  → 'read-only' | 'workspace-write' | 'full-access' (sandbox level;
//            its independent reviewer is configured through /security).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getOrCreateStream(id);
  if (!stream) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const mode = isSessionMode(stream.kind, body?.mode)
    ? body.mode
    : defaultSessionMode(stream.kind, 'runtime');
  try {
    await stream.setPermissionMode(mode as any);
    return NextResponse.json({ ok: true, mode });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
