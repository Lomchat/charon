import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getWorker } from '@/lib/server/claude/SessionWorkerPool';

// POST /api/claude/sessions/[id]/input
// Body : { content } -> user_message ; ou { type: 'interrupt' }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const w = getWorker(id);
  if (!w) return NextResponse.json({ error: 'session not active (resume first)' }, { status: 409 });
  const body = await req.json();
  if (body.type === 'interrupt') {
    await w.sendInterrupt();
    return NextResponse.json({ ok: true });
  }
  const content = String(body.content ?? '').trim();
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 });
  try {
    await w.sendUserMessage(content);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
