import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getWorker } from '@/lib/server/claude/SessionWorkerPool';

// POST /api/claude/sessions/[id]/mode { mode: 'normal' | 'acceptEdits' | 'bypass' | 'plan' }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const w = getWorker(id);
  if (!w) return NextResponse.json({ error: 'session not active' }, { status: 409 });
  const body = await req.json();
  const ALLOWED = ['normal', 'acceptEdits', 'bypass', 'plan'] as const;
  type Mode = (typeof ALLOWED)[number];
  const mode: Mode = ALLOWED.includes(body.mode) ? body.mode : 'normal';
  try {
    await w.setPermissionMode(mode);
    return NextResponse.json({ ok: true, mode });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
