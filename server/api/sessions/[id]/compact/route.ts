import { eq } from 'drizzle-orm';
import { db, agentSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { getOrCreateStream, resumeSession } from '@/lib/server/agent/sessionOps';
import {
  PROVIDERS, asSessionProvider, supportsSessionCapability,
} from '@/lib/sessionCapabilities';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, id)).all();
  if (!row) return Response.json({ error: 'session not found' }, { status: 404 });
  // The capability, not the status: a backend with no compaction primitive had
  // `/compact` delivered to its model as a literal prompt (§14.103).
  const kind = asSessionProvider(row.kind);
  if (!supportsSessionCapability(kind, 'compact')) {
    return Response.json(
      { error: `${PROVIDERS[kind].label} sessions cannot be compacted` },
      { status: 400 },
    );
  }
  const stream = getOrCreateStream(id);
  const compact = async () => {
    // Sends wait from now, not from the provider's `compacting` frame
    // (§14.125): a message typed right after the click lands after it.
    stream?.noteCompactRequested();
    await getAgentClientForVpsId(row.vpsId).call('compact_session', { session_id: id });
  };
  try {
    try {
      await compact();
    } catch (e: any) {
      // A sleeping session wakes for it, as a send does (§14.49).
      if (!/not running|not found|dead|-3200[01]/i.test(String(e?.message ?? e))) throw e;
      await resumeSession(id);
      await compact();
    }
    stream?.compactRequestSettled(true);
    return Response.json({ ok: true });
  } catch (e: any) {
    stream?.compactRequestSettled(false);
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
