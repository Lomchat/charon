import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { emitGlobalTabsChanged } from '@/lib/server/agent/sessionOps';
import { activateTab, closeTab, listTabs, pinTab } from '@/lib/server/claude/tabs';
import type { CloseTabResponse } from '@/lib/types/api';

// PATCH  /api/tabs/[id]  { pin?: true, activate?: true }
// DELETE /api/tabs/[id]  → close. The referent is untouched: a closed session
//                          keeps running and stays in the sidebar. §14.78

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  let body: { pin?: boolean; activate?: boolean } = {};
  try { body = await req.json(); } catch { /* both optional */ }

  let tab = body.pin ? pinTab(id) : null;
  if (body.activate !== false) tab = activateTab(id) ?? tab;
  if (!tab) return NextResponse.json({ error: 'tab not found' }, { status: 404 });
  emitGlobalTabsChanged();
  return NextResponse.json({ tab, tabs: listTabs() });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  // `?next=` is the client's focus history — see closeTab().
  const next = new URL(req.url).searchParams.get('next');
  const r = closeTab(id, next);
  if (!r.closed) return NextResponse.json({ error: 'tab not found' }, { status: 404 });
  emitGlobalTabsChanged();
  return NextResponse.json<CloseTabResponse & { tabs: ReturnType<typeof listTabs> }>({
    ok: true, nextActiveId: r.nextActiveId, tabs: listTabs(),
  });
}
