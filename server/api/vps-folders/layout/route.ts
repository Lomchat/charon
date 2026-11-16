import { NextResponse } from 'next/server';
import { db, vps, vpsFolders } from '@/lib/db';
import { eq, asc, max, ne } from 'drizzle-orm';
import { requireApiSession } from '@/lib/server/session';

const DEFAULT_FOLDER_ID = 'default';

// POST /api/vps-folders/layout — apply atomic re-layout.
//
// Body: {
//   folders: [{ id, position }, ...],
//   vps: [{ id, folderId, position }, ...]
// }
//
// Semantics: we replace the positions of folders AND the
// (folderId, position) of the listed VPS. Rows not mentioned in the body
// are not touched (so we can send a partial re-layout, but the UI
// typically sends the full state after a drag-end).
//
// Validation: all folderId referenced in `vps` must exist.
//
// Returns the full updated folders+vps state (so the client resyncs
// without refetch).
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

  // Pre-validation: all folder IDs referenced by vps must exist
  // (including those we are reordering).
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
      // The 'default' folder is never reorderable on the UI side — we
      // ignore any attempt to change its position via this endpoint. Its
      // final position is forced below after all other updates.
      if (f.id === DEFAULT_FOLDER_ID) continue;
      tx.update(vpsFolders).set({ position: Math.floor(f.position) }).where(eq(vpsFolders.id, f.id)).run();
    }
    for (const v of inVps) {
      if (!v?.id || !v?.folderId || typeof v.position !== 'number') continue;
      tx.update(vps).set({
        folderId: v.folderId,
        position: Math.floor(v.position),
      }).where(eq(vps.id, v.id)).run();
    }
    // Force 'default' to position = (max of others) + 1 so it always
    // stays last in `ORDER BY position`.
    const m = tx.select({ p: max(vpsFolders.position) }).from(vpsFolders)
      .where(ne(vpsFolders.id, DEFAULT_FOLDER_ID)).get();
    const targetDefaultPos = (m?.p ?? -1) + 1;
    tx.update(vpsFolders).set({ position: targetDefaultPos })
      .where(eq(vpsFolders.id, DEFAULT_FOLDER_ID)).run();
  });

  const folders = db.select().from(vpsFolders).orderBy(asc(vpsFolders.position), asc(vpsFolders.createdAt)).all();
  const vpsRows = db.select().from(vps).orderBy(asc(vps.position)).all();
  return NextResponse.json({ ok: true, folders, vps: vpsRows });
}
