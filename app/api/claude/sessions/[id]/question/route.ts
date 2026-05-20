import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getStream } from '@/lib/server/agent/sessionOps';

// POST /api/claude/sessions/[id]/question
// Body: { id: qid, answers: Record<string,string> | null }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getStream(id);
  if (!stream) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json();
  const qid = String(body.id ?? '').trim();
  if (!qid) return NextResponse.json({ error: 'qid required' }, { status: 400 });
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : null;
  try {
    await stream.respondQuestion(qid, answers);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
