import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, projects } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

const ALLOWED = ['name', 'glyph', 'colorToken', 'url'] as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json();
  const update: Record<string, unknown> = {};
  for (const k of ALLOWED) {
    if (!(k in body)) continue;
    if (k === 'url') {
      const v = body[k];
      update[k] = v == null || String(v).trim() === '' ? null : String(v).trim();
    } else {
      update[k] = String(body[k] ?? '').trim();
    }
  }
  if (Object.keys(update).length === 0) {
    const [row] = db.select().from(projects).where(eq(projects.id, id)).all();
    return NextResponse.json(row ?? null);
  }
  db.update(projects).set(update).where(eq(projects.id, id)).run();
  const [row] = db.select().from(projects).where(eq(projects.id, id)).all();
  return NextResponse.json(row);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  db.delete(projects).where(eq(projects.id, id)).run();
  return NextResponse.json({ ok: true });
}
