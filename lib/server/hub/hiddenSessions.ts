import 'server-only';
// Hidden sessions (CLAUDE.md §14.118). A hidden session runs like any other;
// what changes is who hears about it: only the "hidden" view lists it, no
// Telegram, browser push only to devices showing hidden sessions, and other
// agents' `list_sessions` skips it (the agent's `peer_hidden_set`).
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, agentSessions } from '@/lib/db';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalSessionListChanged } from '@/lib/server/agent/sessionOps';

/** Hand the VPS agent the full set its `peer_list` must skip: hidden AND
 *  archived sessions (the agent knows nothing of an archive and kept listing
 *  them). Best effort: an agent older than 0.130.0 (-32601) or a disconnected
 *  one just keeps listing them — the next connect pushes again
 *  (autoConnect § armAgentClientHooks), as does every hide and archive. */
export async function pushPeerHidden(vpsId: string): Promise<void> {
  const client = getAgentClientForVpsId(vpsId);
  if (client.status !== 'connected') return;
  const ids = db.select({ id: agentSessions.id }).from(agentSessions)
    .where(and(eq(agentSessions.vpsId, vpsId), or(eq(agentSessions.hidden, 1), eq(agentSessions.archived, 1))))
    .all().map((r) => r.id);
  try {
    await client.call('peer_hidden_set', { session_ids: ids });
  } catch { /* old agent or transient: see above */ }
}

/** The session and every sub-session below it: a family hides together, or
 *  the sidebar would show children whose parent it does not draw. */
function familyOf(rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length && out.length < 5000; i++) {
    const children = db.select({ id: agentSessions.id }).from(agentSessions)
      .where(eq(agentSessions.parentSessionId, out[i])).all();
    for (const c of children) if (!out.includes(c.id)) out.push(c.id);
  }
  return out;
}

/** Hide or show a session with its sub-sessions. Returns the ids changed. */
export async function setSessionHidden(sessionId: string, hidden: boolean): Promise<string[]> {
  const row = db.select({ vpsId: agentSessions.vpsId }).from(agentSessions)
    .where(eq(agentSessions.id, sessionId)).get();
  if (!row) throw new Error('session not found');
  const ids = familyOf(sessionId);
  db.update(agentSessions).set({ hidden: hidden ? 1 : 0 })
    .where(inArray(agentSessions.id, ids)).run();
  for (const id of ids) emitGlobalSessionListChanged(id);
  await pushPeerHidden(row.vpsId);
  return ids;
}
