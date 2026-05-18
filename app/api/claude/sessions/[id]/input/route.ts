import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getStream } from '@/lib/server/agent/sessionOps';

// POST /api/claude/sessions/[id]/input
// Body : { content } -> user_message ; ou { type: 'interrupt' }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getStream(id);
  if (!stream) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json();
  try {
    if (body.type === 'interrupt') {
      await stream.sendInterrupt();
      return NextResponse.json({ ok: true });
    }
    const content = String(body.content ?? '').trim();
    if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 });
    await stream.sendUserMessage(content);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
