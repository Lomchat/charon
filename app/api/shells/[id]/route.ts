import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getShell, stopShell, updateShellMeta } from '@/lib/server/shell/shellSession';

// GET /api/shells/[id]
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sh = getShell(id);
  if (!sh) return NextResponse.json({ error: 'shell not found' }, { status: 404 });
  return NextResponse.json(sh);
}

// PATCH /api/shells/[id]  Body: { name?, color? }
// Persisted to DB; survives Charon restart.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json();
  const updated = updateShellMeta(id, {
    name: 'name' in body ? body.name : undefined,
    color: 'color' in body ? body.color : undefined,
  });
  if (!updated) return NextResponse.json({ error: 'shell not found' }, { status: 404 });
  return NextResponse.json(updated);
}

// DELETE /api/shells/[id] — agent's `shell_kill` + drop the DB row.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const ok = await stopShell(id);
  return NextResponse.json({ ok });
}
