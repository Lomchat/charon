import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { emitGlobalTabsChanged, getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { pinTabForRef } from '@/lib/server/claude/tabs';

// POST /api/claude/sessions/[id]/input
// Body: { content } -> user_message; or { type: 'interrupt' }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getOrCreateStream(id);
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
    // Talking to a session is the clearest possible signal that its tab has
    // stopped being a preview. Pin it so the next thing opened in this folder
    // can't evict the conversation you're having. §14.78
    pinTabForRef('session', id);
    emitGlobalTabsChanged();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
