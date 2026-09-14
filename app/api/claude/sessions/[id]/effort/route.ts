import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { isKnownEffort } from '@/lib/server/claude/modelSync';
import {
  PROVIDERS, asSessionProvider, isEffortValue, type SessionProvider,
} from '@/lib/sessionCapabilities';

/** A provider's accepted effort value. `isEffortValue` answers the part every
 *  provider owes — a level from its static set, or a well-formed parameter set
 *  when the ladder is declared per model. Claude additionally accepts anything
 *  the LIVE catalog reports (§14.43), which no static set can know. The agent
 *  is the final gate in every case (it drops a level its model rejects). */
function isEffortAcceptable(kind: SessionProvider, raw: string): boolean {
  if (isEffortValue(kind, raw)) return true;
  return kind === 'claude' && isKnownEffort(raw);
}

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
  const kind = asSessionProvider(stream.kind);
  // Codex efforts are a different set (none/minimal/low/medium/high/xhigh/max/
  // ultra), catalog-gated per model; Claude uses isKnownEffort. The agent is
  // the final gate for both (drops a level its SDK/model doesn't know).
  let effort: string | null;
  if (raw == null || raw === '') {
    effort = null;
  } else if (typeof raw === 'string' && isEffortAcceptable(kind, raw)) {
    effort = raw;
  } else {
    return NextResponse.json(
      { error: `invalid effort '${raw}'; expected a ${PROVIDERS[kind].label} effort level or null` },
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
