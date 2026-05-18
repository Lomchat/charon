import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getShell } from '@/lib/server/shell/shellSession';

// POST /api/shells/[id]/input  Body: { content: string }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sh = getShell(id);
  if (!sh) return NextResponse.json({ error: 'shell not found' }, { status: 404 });
  const body = await req.json();
  const content = typeof body.content === 'string' ? body.content : '';
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 });
  try {
    sh.sendInput(content);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
