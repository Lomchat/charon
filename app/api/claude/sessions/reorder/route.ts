import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { emitGlobalSessionListChanged } from '@/lib/server/agent/sessionOps';

// POST /api/claude/sessions/reorder  { vpsId, ids }
//
// Sidebar order INSIDE one VPS. Deliberately scoped to a VPS: the sidebar
// groups by machine, so a global order would be meaningless and a cross-VPS
// drag would have to mean "move the session", which it doesn't.
//
// Like the tab reorder, the client sends the full desired order and anything
// it didn't mention keeps its relative place at the end — the list is polled
// and shared, so the client's view can be one session out of date.
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  let vpsId = '';
  let ids: string[] = [];
  try {
    const b = await req.json();
    vpsId = String(b?.vpsId ?? '');
    ids = Array.isArray(b?.ids) ? b.ids.map(String) : [];
  } catch { /* validated below */ }
  if (!vpsId || ids.length === 0) {
    return NextResponse.json({ error: 'vpsId and ids are required' }, { status: 400 });
  }

  const rows = db.select().from(claudeSessions).where(eq(claudeSessions.vpsId, vpsId)).all();
  const rank = new Map(ids.map((id, i) => [id, i]));
  const sorted = [...rows].sort((a, b) =>
    (rank.get(a.id) ?? ids.length + rows.indexOf(a)) - (rank.get(b.id) ?? ids.length + rows.indexOf(b)));
  db.transaction((tx) => {
    sorted.forEach((r, i) => {
      if (r.position !== i) {
        tx.update(claudeSessions).set({ position: i })
          .where(and(eq(claudeSessions.id, r.id), eq(claudeSessions.vpsId, vpsId))).run();
      }
    });
  });
  emitGlobalSessionListChanged(vpsId);
  return NextResponse.json({ ok: true });
}
