import 'server-only';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import type { AgentMethodName } from '@/lib/server/agent/types';

/**
 * Call a per-session agent RPC and normalise every failure into a `reason`.
 *
 * These surfaces (context gauge, MCP panel, sub-agent reader) are polled or
 * rendered next to a chat, so an exception must never reach a component: an
 * agent too old (-32601), a sleeping session, an unreachable VPS all degrade
 * to a shape the UI can show. Same contract as the git layer (§14.76), for
 * the same reason — a chip must not be able to hang a render.
 */
export async function callSessionRpc(
  sessionId: string,
  method: AgentMethodName,
  params: Record<string, unknown> = {},
): Promise<any> {
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) return { ok: false, error: 'session not found', reason: 'missing' };
  try {
    const client = getAgentClientForVpsId(row.vpsId);
    if (client.status !== 'connected') return { ok: false, error: 'agent offline', reason: 'offline' };
    return await client.call(method, { session_id: sessionId, ...params });
  } catch (e: any) {
    const msg = String(e?.message || e);
    // -32601 means the agent predates the feature — a rollout lag, not a
    // failure. Detected on the code, never on vps.agentVersion (which lags).
    const reason = /-32601|no such method/i.test(msg) ? 'unsupported' : 'error';
    return { ok: false, error: msg, reason };
  }
}
