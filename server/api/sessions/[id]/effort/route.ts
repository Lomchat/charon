import { db, agentSessions } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { connectionConfig } from '@/lib/server/customEndpoints';
import { queueEndpoint } from '@/lib/server/agent/endpointOps';
import { requireApiSession } from '@/lib/server/session';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { isServiceTierId } from '@/lib/providerConfigFlags';
import { isKnownEffort } from '@/lib/server/hub/modelSync';
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

// POST /api/sessions/[id]/effort
// Body: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null } & EffortSwitches
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
  if (!stream) return Response.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const raw = body?.effort;
  const kind = asSessionProvider(stream.kind);
  const row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  const endpoint = connectionConfig(row?.providerConfig).customEndpoint;
  if (endpoint) {
    if (row?.archived) return Response.json({ error: 'Unarchive this session before changing parameters.' }, { status: 400 });
    if (raw != null && typeof raw !== 'string') return Response.json({ error: 'Invalid endpoint parameters.' }, { status: 400 });
    try {
      await queueEndpoint(id, endpoint, raw || null);
      return Response.json({ ok: true, sync: syncAfter([id]) });
    } catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Could not configure parameters.' }, { status: 400 }); }
  }
  // Codex efforts are a different set (none/minimal/low/medium/high/xhigh/max/
  // ultra), catalog-gated per model; Claude uses isKnownEffort. The agent is
  // the final gate for both (drops a level its SDK/model doesn't know).
  // Claude's ultracode switch rides with effort (§14.56): both are read at
  // client construction, so both apply at the next start. Absent = unchanged.
  let ultracode = typeof body?.ultracode === 'boolean' ? body.ultracode as boolean : undefined;
  const fastMode = typeof body?.fastMode === 'boolean' ? body.fastMode as boolean : undefined;
  // Codex's speed tier (§14.59): present = change it, null = inherit.
  let serviceTier: string | null | undefined;
  if (body && 'serviceTier' in body) {
    if (body.serviceTier !== null && !isServiceTierId(body.serviceTier)) {
      return Response.json({ error: `invalid serviceTier '${String(body.serviceTier)}'` }, { status: 400 });
    }
    serviceTier = body.serviceTier as string | null;
  }
  let effort: string | null;
  if (raw == null || raw === '') {
    effort = null;
  } else if (kind === 'claude' && raw === 'ultracode') {
    // The legacy pseudo-effort: xhigh + the switch.
    effort = 'xhigh';
    ultracode = true;
  } else if (typeof raw === 'string' && isEffortAcceptable(kind, raw)) {
    effort = raw;
  } else {
    return Response.json(
      { error: `invalid effort '${raw}'; expected a ${PROVIDERS[kind].label} effort level or null` },
      { status: 400 },
    );
  }
  try {
    // Each switch reaches only its own provider (sessionOps checks the kind).
    await stream.setEffort(effort as any, { ultracode, fastMode, serviceTier });
    return Response.json({ ok: true, sync: syncAfter([id]) });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
