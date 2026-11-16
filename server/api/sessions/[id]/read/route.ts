import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { markSessionRead } from '@/lib/server/agent/sessionOps';

// POST /api/sessions/[id]/read — the user marks the session's finish read (a
// click on the pulsing answer): the same acknowledgement as leaving it
// (CLAUDE.md §14.47). Idempotent; `sync` covers the summary frame clearing it.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  markSessionRead(id);
  return NextResponse.json({ ok: true, sync: syncAfter([id]) });
}
