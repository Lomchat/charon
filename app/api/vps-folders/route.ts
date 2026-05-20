import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db, vpsFolders } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { asc, max, ne, eq } from 'drizzle-orm';

const newId = () => crypto.randomBytes(8).toString('hex');
const DEFAULT_FOLDER_ID = 'default';

// GET /api/vps-folders — lists folders, sorted by position. The 'default'
// folder is always returned last (cf. "No folder always last" rule) — its
// stored `position` is not meant to be consulted by clients, which should
// apply the same sorting rule.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const rows = db.select().from(vpsFolders).orderBy(asc(vpsFolders.position), asc(vpsFolders.createdAt)).all();
  return NextResponse.json({ folders: rows });
}

// POST /api/vps-folders — creates a new folder. By default we insert it
// just above 'default': its `position` = max(position of other folders) + 1.
// If `body.position` is provided explicitly, we use it (but we ensure that
// 'default' stays above by bumping its position if necessary).
// Cf. §4 CLAUDE.md "default folder always last".
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
    // Max of non-default folders
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
    // Push 'default' to position = (max non-default) + 1 so it always stays
    // last. This is defensive: even though the UI already applies the
    // "default last" sort, we keep storage coherent for simple clients
    // that just rely on `ORDER BY position`.
    const m = tx.select({ p: max(vpsFolders.position) }).from(vpsFolders)
      .where(ne(vpsFolders.id, DEFAULT_FOLDER_ID)).get();
    const targetDefaultPos = (m?.p ?? -1) + 1;
    tx.update(vpsFolders).set({ position: targetDefaultPos })
      .where(eq(vpsFolders.id, DEFAULT_FOLDER_ID)).run();
  });

  const [created] = db.select().from(vpsFolders).where(eq(vpsFolders.id, id)).all();
  return NextResponse.json(created);
}
