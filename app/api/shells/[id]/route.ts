import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, shells as shellsTable } from '@/lib/db';
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
// Persisted in DB (shells survive Charon restarts now — cf. shellSession.ts).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sh = getShell(id);
  if (!sh) return NextResponse.json({ error: 'shell not found' }, { status: 404 });
  const body = await req.json();
  const patch: { name?: string | null; color?: string | null } = {};
  if ('name' in body) {
    const v = body.name;
    sh.name = patch.name = (typeof v === 'string' && v.trim()) ? v.trim() : null;
  }
  if ('color' in body) {
    const v = body.color;
    sh.color = patch.color = (typeof v === 'string' && v.trim()) ? v.trim() : null;
  }
  if (Object.keys(patch).length) {
    try { db.update(shellsTable).set(patch).where(eq(shellsTable.id, id)).run(); } catch {}
  }
  return NextResponse.json(sh.info());
}

// DELETE /api/shells/[id] — kills the tmux session on the VPS + drops the row.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const ok = await stopShell(id);
  return NextResponse.json({ ok });
}
