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

// PATCH /api/shells/[id]  Body: { name?, color? }
// Update mémoire seulement (les shells sont éphémères, pas de DB).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sh = getShell(id);
  if (!sh) return NextResponse.json({ error: 'shell not found' }, { status: 404 });
  const body = await req.json();
  if ('name' in body) {
    const v = body.name;
    sh.name = (typeof v === 'string' && v.trim()) ? v.trim() : null;
  }
  if ('color' in body) {
    const v = body.color;
    sh.color = (typeof v === 'string' && v.trim()) ? v.trim() : null;
  }
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
