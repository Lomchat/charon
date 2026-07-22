import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db, vps, vpsFolders } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { validateVpsTarget } from '@/lib/server/vpsValidate';
import { eq, max, asc, ne } from 'drizzle-orm';

const newId = () => crypto.randomBytes(8).toString('hex');
const DEFAULT_FOLDER_ID = 'default';

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();

  // Strict validation — these values end up in ssh argvs (P1.3).
  const v = validateVpsTarget(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const { name, ip, sshUser, sshPort, defaultPath } = v;

  // Folder resolution: if folderId is provided and exists we use it,
  // otherwise we fall back on the first non-'default' folder (by position).
  // The 'default' folder is intentionally excluded as it is conventionally
  // "No folder" — fallback only if no other folder exists.
  let folderId: string;
  const requested = body.folderId != null ? String(body.folderId).trim() : null;
  if (requested) {
    const [f] = db.select().from(vpsFolders).where(eq(vpsFolders.id, requested)).all();
    folderId = f ? f.id : DEFAULT_FOLDER_ID;
  } else {
    const [first] = db.select().from(vpsFolders)
      .where(ne(vpsFolders.id, DEFAULT_FOLDER_ID))
      .orderBy(asc(vpsFolders.position)).all();
    folderId = first?.id ?? DEFAULT_FOLDER_ID;
  }

  // Position: append at the end of the chosen folder.
  const m = db.select({ p: max(vps.position) }).from(vps).where(eq(vps.folderId, folderId)).get();
  const position = (m?.p ?? -1) + 1;

  const row = { id: newId(), name, ip, sshUser, sshPort, defaultPath, folderId, position };
  db.insert(vps).values(row).run();
  return NextResponse.json({ ...row, createdAt: Math.floor(Date.now() / 1000) });
}
