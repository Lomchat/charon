import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, vpsProjectPaths } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const rows = db.select().from(vpsProjectPaths).all();
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  const vpsId = String(body.vpsId ?? '').trim();
  const projectId = String(body.projectId ?? '').trim();
  const path = String(body.path ?? '').trim();
  if (!vpsId || !projectId || !path) {
    return NextResponse.json({ error: 'vpsId, projectId, path requis' }, { status: 400 });
  }
  // Dédoublonne sur le triplet pour éviter des doublons identiques.
  const dup = db.select().from(vpsProjectPaths)
    .where(and(
      eq(vpsProjectPaths.vpsId, vpsId),
      eq(vpsProjectPaths.projectId, projectId),
      eq(vpsProjectPaths.path, path)
    )).limit(1).all();
  if (dup.length > 0) {
    return NextResponse.json(dup[0]);
  }
  const [row] = db.insert(vpsProjectPaths).values({ vpsId, projectId, path }).returning().all();
  return NextResponse.json(row);
}
