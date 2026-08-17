import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import { recordedSessionUsage } from '@/lib/server/agent/sessionUsage';

/** GET /api/claude/sessions/[id]/context — how full the context window is.
 *
 *  Charon had a live token counter (§14.50) but no notion of the WINDOW, so
 *  "why did my session suddenly forget things" had no answer until the
 *  compaction marker, which arrives after the fact. This answers it before. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  // Identity rides along: the panel shows both names side by side, and one
  // round trip is enough for two facts that are always read together.
  const [usage, identity] = await Promise.all([
    callSessionRpc(id, 'get_context_usage'),
    callSessionRpc(id, 'session_identity'),
  ]);
  return NextResponse.json({ ...usage, identity, recorded_usage: recordedSessionUsage(id) });
}
