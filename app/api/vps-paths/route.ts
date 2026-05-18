import { NextResponse } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db, vpsPaths, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

// GET /api/vps-paths
// Liste tous les paths de tous les VPS, triés par vps_id puis path.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const rows = db.select().from(vpsPaths)
    .orderBy(asc(vpsPaths.vpsId), asc(vpsPaths.path))
    .all();
  return NextResponse.json(rows);
}

// POST /api/vps-paths
// Body : { vpsId, path, label? }
// Idempotent : si (vpsId, path) existe déjà on retourne la row existante.
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  const vpsId = String(body.vpsId ?? '').trim();
  const path = String(body.path ?? '').trim();
  const label = body.label != null && String(body.label).trim() !== ''
    ? String(body.label).trim() : null;
  if (!vpsId || !path) {
    return NextResponse.json({ error: 'vpsId et path requis' }, { status: 400 });
  }
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) return NextResponse.json({ error: 'vps inconnu' }, { status: 404 });

  const [existing] = db.select().from(vpsPaths)
    .where(and(eq(vpsPaths.vpsId, vpsId), eq(vpsPaths.path, path)))
    .all();
  if (existing) {
    // Update du label si fourni et différent
    if (label != null && existing.label !== label) {
      db.update(vpsPaths).set({ label }).where(eq(vpsPaths.id, existing.id)).run();
      const [row] = db.select().from(vpsPaths).where(eq(vpsPaths.id, existing.id)).all();
      return NextResponse.json(row);
    }
    return NextResponse.json(existing);
  }
  const [created] = db.insert(vpsPaths)
    .values({ vpsId, path, label })
    .returning()
    .all();
  return NextResponse.json(created);
}
