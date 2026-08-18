import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import { recordedSessionUsage } from '@/lib/server/agent/sessionUsage';
import { normalizeCodexContextUsage } from '@/lib/server/claude/sessionInsightCompat';
import { readSessionInsightSnapshot } from '@/lib/server/claude/sessionInsightSnapshot';

/** GET /api/claude/sessions/[id]/context — how full the context window is.
 *
 *  Charon had a live token counter (§14.50) but no notion of the WINDOW, so
 *  "why did my session suddenly forget things" had no answer until the
 *  compaction marker, which arrives after the fact. This answers it before. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const force = new URL(req.url).searchParams.get('force') === '1';
  // Never hold a browser connection on provider telemetry. A cold request
  // starts one shared background job and returns `reason:loading`; all tabs
  // then consume the same snapshot. Identity rides in the same snapshot so
  // it cannot add another focus-time request.
  const usage = readSessionInsightSnapshot(id, 'context', async () => {
    const raw = await callSessionRpc(id, 'get_context_usage');
    const identity = await callSessionRpc(id, 'session_identity');
    return { ...normalizeCodexContextUsage(raw), identity };
  }, { force, maxAgeMs: 15_000 });
  return NextResponse.json({
    ...usage,
    recorded_usage: recordedSessionUsage(id),
  });
}
