import { NextResponse } from 'next/server';
import { eq, asc } from 'drizzle-orm';
import { db, vps, vpsFolders } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

const DEFAULT_FOLDER_ID = 'default';

// PATCH /api/vps-folders/[id] — rename or toggle collapsed.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json().catch(() => null) as { name?: string; collapsed?: boolean } | null;
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
    update.name = name;
  }
  if (typeof body.collapsed === 'boolean') {
    update.collapsed = body.collapsed ? 1 : 0;
  }
  if (Object.keys(update).length === 0) {
    const [row] = db.select().from(vpsFolders).where(eq(vpsFolders.id, id)).all();
    return NextResponse.json(row ?? null);
  }
  db.update(vpsFolders).set(update).where(eq(vpsFolders.id, id)).run();
  const [row] = db.select().from(vpsFolders).where(eq(vpsFolders.id, id)).all();
  return NextResponse.json(row);
}

// DELETE /api/vps-folders/[id] — deletes a folder. Refuses to delete the
// "default" folder (safety: always at least one fallback folder).
// Contained VPS are moved to the "default" folder.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  if (id === DEFAULT_FOLDER_ID) {
    return NextResponse.json({ error: 'cannot delete the default folder' }, { status: 400 });
  }
  const [folder] = db.select().from(vpsFolders).where(eq(vpsFolders.id, id)).all();
  if (!folder) return NextResponse.json({ error: 'folder not found' }, { status: 404 });

  db.transaction((tx) => {
    // Move the folder's VPS to 'default', appending (positions at the end).
    const movedVps = tx.select().from(vps).where(eq(vps.folderId, id)).all();
    if (movedVps.length > 0) {
      const existing = tx.select().from(vps).where(eq(vps.folderId, DEFAULT_FOLDER_ID))
        .orderBy(asc(vps.position)).all();
      let nextPos = existing.length;
      for (const v of movedVps) {
        tx.update(vps).set({ folderId: DEFAULT_FOLDER_ID, position: nextPos++ })
          .where(eq(vps.id, v.id)).run();
      }
    }
    tx.delete(vpsFolders).where(eq(vpsFolders.id, id)).run();
  });
  return NextResponse.json({ ok: true });
}
