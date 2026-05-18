import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getShell, stopShell } from '@/lib/server/shell/shellSession';

// GET /api/shells/[id]
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sh = getShell(id);
  if (!sh) return NextResponse.json({ error: 'shell not found' }, { status: 404 });
  return NextResponse.json(sh.info());
}

// DELETE /api/shells/[id]
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const ok = stopShell(id);
  return NextResponse.json({ ok });
}
