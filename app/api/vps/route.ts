import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db, vps, vpsFolders } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { eq, max, asc } from 'drizzle-orm';

const newId = () => crypto.randomBytes(8).toString('hex');
const DEFAULT_FOLDER_ID = 'default';

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();

  const name = String(body.name ?? '').trim();
  const ip = String(body.ip ?? '').trim();
  const sshUser = String(body.sshUser ?? '').trim();
  if (!name || !ip || !sshUser) {
    return NextResponse.json({ error: 'name, ip, sshUser required' }, { status: 400 });
  }
  const sshPortRaw = Number(body.sshPort ?? 22);
  const sshPort = Number.isFinite(sshPortRaw) && sshPortRaw > 0 ? Math.floor(sshPortRaw) : 22;
  const defaultPath = body.defaultPath != null && String(body.defaultPath).trim() !== ''
    ? String(body.defaultPath).trim()
    : null;

  // Résolution du dossier : si folderId fourni et existant on l'utilise,
  // sinon on tombe sur le premier dossier (par position) — typiquement 'default'.
  let folderId: string;
  const requested = body.folderId != null ? String(body.folderId).trim() : null;
  if (requested) {
    const [f] = db.select().from(vpsFolders).where(eq(vpsFolders.id, requested)).all();
    folderId = f ? f.id : DEFAULT_FOLDER_ID;
  } else {
    const [first] = db.select().from(vpsFolders).orderBy(asc(vpsFolders.position)).all();
    folderId = first?.id ?? DEFAULT_FOLDER_ID;
  }

  // Position : append à la fin du dossier choisi.
  const m = db.select({ p: max(vps.position) }).from(vps).where(eq(vps.folderId, folderId)).get();
  const position = (m?.p ?? -1) + 1;

  const row = { id: newId(), name, ip, sshUser, sshPort, defaultPath, folderId, position };
  db.insert(vps).values(row).run();
  return NextResponse.json({ ...row, createdAt: Math.floor(Date.now() / 1000) });
}
