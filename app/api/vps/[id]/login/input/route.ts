import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getLoginSession } from '@/lib/server/agent/loginSession';

// POST /api/vps/[id]/login/input  Body: { content: string }
// Le content est écrit tel quel dans le stdin du process distant.
// Pour envoyer une ligne complète, le caller doit inclure "\n" dans content.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sess = getLoginSession(id);
  if (!sess) return NextResponse.json({ error: 'no active login session' }, { status: 404 });
  const body = await req.json();
  const content = typeof body.content === 'string' ? body.content : '';
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 });
  try {
    sess.sendInput(content);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
