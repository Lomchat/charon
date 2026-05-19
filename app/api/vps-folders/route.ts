import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db, vpsFolders } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { asc, max } from 'drizzle-orm';

const newId = () => crypto.randomBytes(8).toString('hex');

// GET /api/vps-folders — liste des dossiers, triés par position.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const rows = db.select().from(vpsFolders).orderBy(asc(vpsFolders.position), asc(vpsFolders.createdAt)).all();
  return NextResponse.json({ folders: rows });
}

// POST /api/vps-folders — crée un nouveau dossier. `position` optionnelle ;
// par défaut on append (max(position) + 1).
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json().catch(() => null) as { name?: string; position?: number } | null;
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  const name = String(body.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  let position: number;
  if (typeof body.position === 'number' && Number.isFinite(body.position)) {
    position = Math.floor(body.position);
  } else {
    const m = db.select({ p: max(vpsFolders.position) }).from(vpsFolders).get();
    position = (m?.p ?? -1) + 1;
  }

  const row = {
    id: newId(),
    name,
    position,
    collapsed: 0,
  };
  db.insert(vpsFolders).values(row).run();
  return NextResponse.json({ ...row, createdAt: Math.floor(Date.now() / 1000) });
}
