import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { restartSession } from '@/lib/server/agent/sessionOps';

// POST /api/claude/sessions/[id]/restart
// In-place SDK restart = awaited sleep + resume. Used by the "apply now" ↻
// button next to the pending model/effort badge (§14.35: the SDK binds
// model/effort at client construction, so deferred changes only take effect
// at the next start). The agent's sleep_session returns only after the SDK
// teardown completes, so this can take a few seconds (in-flight turn drain).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  try {
    const stream = await restartSession(id);
    return NextResponse.json({ ok: true, status: stream.status });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
