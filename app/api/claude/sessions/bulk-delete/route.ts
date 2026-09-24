import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import {
  deleteSession, emitGlobalSessionListChanged, emitGlobalTabsChanged, peekStream,
} from '@/lib/server/agent/sessionOps';
import type { BulkDeleteSessionsResponse } from '@/lib/types/api';

// POST /api/claude/sessions/bulk-delete  { ids, onlyPaused? }
//
// The paused-sessions cleanup (the trash beside "show paused"). The same
// permanent deletion as DELETE /api/claude/sessions/[id], N at a time:
//
// - ONE list broadcast at the end instead of one per session — each broadcast
//   makes every open tab refetch the whole list (§14.52).
// - `onlyPaused` re-reads the LIVE status right before each deletion, in the
//   same synchronous step as the delete itself: the modal's list can be a poll
//   old, and a session that woke up since then is kept and reported.
// - The event loop gets a turn between two sessions: each delete cascades
//   through the message table and its FTS index (§4), and a long synchronous
//   run would stall every SSE stream of the hub meanwhile.
const MAX_IDS = 2000;

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  let ids: string[] = [];
  let onlyPaused = false;
  try {
    const b = await req.json();
    ids = Array.isArray(b?.ids) ? b.ids.filter((id: unknown): id is string => typeof id === 'string' && id !== '') : [];
    onlyPaused = b?.onlyPaused === true;
  } catch { /* validated below */ }
  ids = [...new Set(ids)];
  if (ids.length === 0) return NextResponse.json({ error: 'ids are required' }, { status: 400 });
  if (ids.length > MAX_IDS) return NextResponse.json({ error: `at most ${MAX_IDS} ids per request` }, { status: 400 });

  const out: BulkDeleteSessionsResponse = { ok: true, deleted: [], missing: [], notPaused: [], failed: [] };
  let tabsDropped = false;
  for (const id of ids) {
    try {
      const [row] = db.select({ status: claudeSessions.status }).from(claudeSessions)
        .where(eq(claudeSessions.id, id)).all();
      if (!row) { out.missing.push(id); continue; }
      if (onlyPaused && (peekStream(id)?.status ?? row.status) !== 'sleeping') {
        out.notPaused.push(id);
        continue;
      }
      const r = await deleteSession(id, { announce: false });
      if (r.deleted) out.deleted.push(id); else out.missing.push(id);
      tabsDropped ||= r.tabsDropped;
    } catch (e: any) {
      out.failed.push({ id, error: e?.message ?? String(e) });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (tabsDropped) emitGlobalTabsChanged();
  if (out.deleted.length > 0) emitGlobalSessionListChanged(out.deleted[0]);
  return NextResponse.json(out);
}
