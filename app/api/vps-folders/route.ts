import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db, vpsFolders } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { asc, max, ne, eq } from 'drizzle-orm';

const newId = () => crypto.randomBytes(8).toString('hex');
const DEFAULT_FOLDER_ID = 'default';

// GET /api/vps-folders — liste des dossiers, triés par position. Le dossier
// 'default' est toujours retourné en dernier (cf. règle "Sans dossier always
// last") — sa `position` stockée n'est pas censée être consultée par les
// clients, qui doivent appliquer la même règle de tri.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const rows = db.select().from(vpsFolders).orderBy(asc(vpsFolders.position), asc(vpsFolders.createdAt)).all();
  return NextResponse.json({ folders: rows });
}

// POST /api/vps-folders — crée un nouveau dossier. Par défaut on l'insère
// juste au-dessus de 'default' : sa `position` = max(position des autres
// dossiers) + 1. Si `body.position` est fourni explicitement, on l'utilise
// (mais on s'assure que 'default' reste au-dessus en bumpant sa position
// si nécessaire). Cf. §4 CLAUDE.md "default folder always last".
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
    // Max des dossiers non-default
    const m = db.select({ p: max(vpsFolders.position) }).from(vpsFolders)
      .where(ne(vpsFolders.id, DEFAULT_FOLDER_ID)).get();
    position = (m?.p ?? -1) + 1;
  }

  const id = newId();
  db.transaction((tx) => {
    tx.insert(vpsFolders).values({
      id,
      name,
      position,
      collapsed: 0,
    }).run();
    // Push 'default' à position = (max non-default) + 1 pour qu'il reste
    // toujours en dernier. C'est défensif : même si l'UI applique déjà le
    // tri "default last", on garde le stockage cohérent pour les clients
    // simples qui se contentent du `ORDER BY position`.
    const m = tx.select({ p: max(vpsFolders.position) }).from(vpsFolders)
      .where(ne(vpsFolders.id, DEFAULT_FOLDER_ID)).get();
    const targetDefaultPos = (m?.p ?? -1) + 1;
    tx.update(vpsFolders).set({ position: targetDefaultPos })
      .where(eq(vpsFolders.id, DEFAULT_FOLDER_ID)).run();
  });

  const [created] = db.select().from(vpsFolders).where(eq(vpsFolders.id, id)).all();
  return NextResponse.json(created);
}
