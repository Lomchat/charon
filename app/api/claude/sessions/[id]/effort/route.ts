import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { isKnownEffort } from '@/lib/server/claude/modelSync';

// POST /api/claude/sessions/[id]/effort
// Body: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null }
//
// Mirrors claude_agent_sdk.EffortLevel. Invalid values are rejected here
// (400) so the UI can surface the error immediately; the agent also drops
// invalid values defensively as a second guard. null/empty clears back to
// the global default.
//
// Takes effect on the NEXT SDK start (sleep + resume) — same constraint as
// the model switch (cf. /model/route.ts).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getOrCreateStream(id);
  if (!stream) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const raw = body?.effort;
  let effort: string | null;
  if (raw == null || raw === '') {
    effort = null;
  } else if (typeof raw === 'string' && isKnownEffort(raw)) {
    // Accept the canonical set OR any level the live catalog reports (so a
    // brand-new level isn't 400'd before the agent/SDK is updated). The agent
    // is the final gate — it drops a level its SDK doesn't know (gotcha 35).
    effort = raw;
  } else {
    return NextResponse.json(
      { error: `invalid effort '${raw}'; expected a catalog effort level or null` },
      { status: 400 },
    );
  }
  try {
    await stream.setEffort(effort as any);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
