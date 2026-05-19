import { NextResponse } from 'next/server';
import { db, vps, vpsFolders } from '@/lib/db';
import { eq, asc } from 'drizzle-orm';
import { requireApiSession } from '@/lib/server/session';

// POST /api/vps-folders/layout — apply atomic re-layout.
//
// Body: {
//   folders: [{ id, position }, ...],
//   vps: [{ id, folderId, position }, ...]
// }
//
// Sémantique : on remplace les positions des folders ET les
// (folderId, position) des VPS listés. Les rows non-mentionnées dans le body
// ne sont pas touchées (donc on peut envoyer un re-layout partiel, mais
// l'UI envoie typiquement l'état complet après un drag-end).
//
// Validation : tous les folderId référencés dans `vps` doivent exister.
//
// Retourne l'état complet folders+vps mis à jour (pour que le client
// resynchronise sans refetch).
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;

  let body: { folders?: Array<{ id: string; position: number }>; vps?: Array<{ id: string; folderId: string; position: number }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const inFolders = Array.isArray(body.folders) ? body.folders : [];
  const inVps = Array.isArray(body.vps) ? body.vps : [];

  // Pre-validation : tous les folder IDs référencés par les vps doivent exister
  // (incluant ceux qu'on est en train de réordonner).
  const knownFolderIds = new Set(
    db.select({ id: vpsFolders.id }).from(vpsFolders).all().map((r) => r.id)
  );
  for (const v of inVps) {
    if (!knownFolderIds.has(v.folderId)) {
      return NextResponse.json({ error: `unknown folder id: ${v.folderId}` }, { status: 400 });
    }
  }

  db.transaction((tx) => {
    for (const f of inFolders) {
      if (!f?.id || typeof f.position !== 'number') continue;
      tx.update(vpsFolders).set({ position: Math.floor(f.position) }).where(eq(vpsFolders.id, f.id)).run();
    }
    for (const v of inVps) {
      if (!v?.id || !v?.folderId || typeof v.position !== 'number') continue;
      tx.update(vps).set({
        folderId: v.folderId,
        position: Math.floor(v.position),
      }).where(eq(vps.id, v.id)).run();
    }
  });

  const folders = db.select().from(vpsFolders).orderBy(asc(vpsFolders.position), asc(vpsFolders.createdAt)).all();
  const vpsRows = db.select().from(vps).orderBy(asc(vps.position)).all();
  return NextResponse.json({ ok: true, folders, vps: vpsRows });
}
