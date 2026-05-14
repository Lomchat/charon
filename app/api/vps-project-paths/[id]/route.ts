import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vpsProjectPaths } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const num = Number(id);
  if (!Number.isFinite(num)) return NextResponse.json({ error: 'id invalide' }, { status: 400 });
  db.delete(vpsProjectPaths).where(eq(vpsProjectPaths.id, num)).run();
  return NextResponse.json({ ok: true });
}
