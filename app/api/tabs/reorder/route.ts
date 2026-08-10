import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { emitGlobalTabsChanged } from '@/lib/server/agent/sessionOps';
import { listTabs, reorderGroups, reorderTabs, reorderVps } from '@/lib/server/claude/tabs';
import type { ReorderTabsBody } from '@/lib/types/api';

// POST /api/tabs/reorder — one row of the strip at a time.
//
// The client sends the FULL desired order for that row, not a moved-from/to
// pair: a from/to only makes sense against the list the client was looking at,
// and the layout is shared, so that list may already be stale. Ids the server
// knows about but the client didn't send keep their relative order at the end,
// so a drag can never silently drop a tab another device just opened.
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  let body: ReorderTabsBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }); }

  if (body?.scope === 'tabs' && body.vpsId && Array.isArray(body.ids)) {
    reorderTabs(body.vpsId, String(body.path ?? ''), body.ids.map(String));
  } else if (body?.scope === 'groups' && body.vpsId && Array.isArray(body.paths)) {
    reorderGroups(body.vpsId, body.paths.map(String));
  } else if (body?.scope === 'vps' && Array.isArray(body.vpsIds)) {
    reorderVps(body.vpsIds.map(String));
  } else {
    return NextResponse.json({ error: 'unknown scope' }, { status: 400 });
  }
  emitGlobalTabsChanged();
  return NextResponse.json({ ok: true, tabs: listTabs() });
}
