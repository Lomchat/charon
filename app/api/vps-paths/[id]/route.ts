import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vpsPaths } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

// PATCH /api/vps-paths/[id]
// Body: { path?, label? }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const pathId = Number(id);
  if (!Number.isFinite(pathId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const body = await req.json();
  const update: Record<string, unknown> = {};
  if ('path' in body) update.path = String(body.path ?? '').trim();
  if ('label' in body) {
    update.label = body.label != null && String(body.label).trim() !== ''
      ? String(body.label).trim() : null;
  }
  if (Object.keys(update).length === 0) {
    const [row] = db.select().from(vpsPaths).where(eq(vpsPaths.id, pathId)).all();
    return NextResponse.json(row ?? null);
  }
  db.update(vpsPaths).set(update).where(eq(vpsPaths.id, pathId)).run();
  const [row] = db.select().from(vpsPaths).where(eq(vpsPaths.id, pathId)).all();
  return NextResponse.json(row);
}

// DELETE /api/vps-paths/[id]
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const pathId = Number(id);
  if (!Number.isFinite(pathId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  db.delete(vpsPaths).where(eq(vpsPaths.id, pathId)).run();
  return NextResponse.json({ ok: true });
}
