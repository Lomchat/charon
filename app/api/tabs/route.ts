import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { emitGlobalTabsChanged } from '@/lib/server/agent/sessionOps';
import { closeTabsWhere, isTabKind, listTabs, openTab } from '@/lib/server/claude/tabs';
import type { OpenTabBody, TabsResponse } from '@/lib/types/api';

// GET  /api/tabs            → the whole workspace layout
// POST /api/tabs            → open (or promote) a tab, and focus it
// DELETE /api/tabs?vpsId=&path=&exceptId=  → bulk close (group / VPS / others)
//
// The layout is shared, but current clients project their own browser-local
// focus and ignore the legacy server `active` bit. Layout mutations broadcast
// `tabs_changed`; a mere client-side focus change never reaches this route.
// §14.78.

export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return NextResponse.json<TabsResponse>({ tabs: listTabs() });
}

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;

  let body: OpenTabBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }); }
  const vpsId = String(body?.vpsId ?? '');
  const kind = String(body?.kind ?? '');
  const ref = String(body?.ref ?? '');
  // `path` is a GROUP KEY and '' is legitimate (installs have no folder), so
  // it is the only field not required to be non-empty.
  const path = String(body?.path ?? '');
  if (!vpsId || !ref || !isTabKind(kind)) {
    return NextResponse.json({ error: 'vpsId, kind and ref are required' }, { status: 400 });
  }

  const tab = openTab({ vpsId, path, kind, ref, pin: !!body?.pin });
  emitGlobalTabsChanged();
  return NextResponse.json({ tab, tabs: listTabs() });
}

export async function DELETE(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const url = new URL(req.url);
  const vpsId = url.searchParams.get('vpsId') ?? undefined;
  const path = url.searchParams.get('path') ?? undefined;
  const exceptId = url.searchParams.get('exceptId') ?? undefined;
  // A bare DELETE would close everything — make the caller be explicit.
  if (vpsId === undefined && path === undefined && exceptId === undefined) {
    return NextResponse.json({ error: 'a filter is required' }, { status: 400 });
  }
  const n = closeTabsWhere({ vpsId, path, exceptId });
  if (n) emitGlobalTabsChanged();
  return NextResponse.json({ ok: true, closed: n, tabs: listTabs() });
}
