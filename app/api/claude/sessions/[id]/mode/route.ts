import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';

// POST /api/claude/sessions/[id]/mode { mode: 'normal' | 'acceptEdits' | 'auto' | 'plan' }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getOrCreateStream(id);
  if (!stream) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json();
  const ALLOWED = ['normal', 'acceptEdits', 'auto', 'plan'] as const;
  type Mode = (typeof ALLOWED)[number];
  const mode: Mode = ALLOWED.includes(body.mode) ? body.mode : 'normal';
  try {
    await stream.setPermissionMode(mode);
    return NextResponse.json({ ok: true, mode });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
