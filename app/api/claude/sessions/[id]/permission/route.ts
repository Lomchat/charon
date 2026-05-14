import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getWorker } from '@/lib/server/claude/SessionWorkerPool';

// POST /api/claude/sessions/[id]/permission
// Body : { id: permId, allow: bool, always?: bool }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const w = getWorker(id);
  if (!w) return NextResponse.json({ error: 'session not active' }, { status: 409 });
  const body = await req.json();
  const permId = String(body.id ?? '').trim();
  if (!permId) return NextResponse.json({ error: 'permId required' }, { status: 400 });
  try {
    await w.respondPermission(permId, Boolean(body.allow), Boolean(body.always));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
