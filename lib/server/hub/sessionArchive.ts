import 'server-only';
import { and, eq } from 'drizzle-orm';
import { accountProfileId } from '@/lib/accountProfiles';
import { db, agentSessions } from '@/lib/db';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import {
  emitGlobalSessionListChanged, emitGlobalTabsChanged, publishInteractionResolved,
  setSessionStatusLocal,
} from '@/lib/server/agent/sessionOps';
import { deleteSessionGates, type GateRef } from '@/lib/server/agent/pendingInteractions';
import { invalidateSessionRowCaches } from '@/lib/server/agent/sessionRowCache';
import { dropTabsForRef } from '@/lib/server/hub/tabs';
import { PROVIDERS, asSessionProvider } from '@/lib/sessionCapabilities';
import { pushPeerHidden } from '@/lib/server/hub/hiddenSessions';
import { subtreeDeepestFirst } from '@/lib/server/hub/subSessions';

/** A session's sub-sessions, any depth, deepest first, itself last (§14.93). */
function subtreeOf(id: string, archived: 0 | 1): string[] {
  return subtreeDeepestFirst(id, (pid) => db.select({ id: agentSessions.id }).from(agentSessions)
    .where(and(eq(agentSessions.parentSessionId, pid), eq(agentSessions.archived, archived))).all()
    .map((r) => r.id));
}

/** Archive is the common reversible "remove from the workspace" operation.
 * Both providers keep their complete Charon transcript. Codex additionally
 * mirrors the state into its native thread archive; Claude has no native
 * archive and therefore needs no remote metadata call. Its sub-sessions go
 * with it, deepest first (§14.93): an archived parent is never woken, their
 * answers would be lost. Throws on the session's own failure. */
export async function archiveSession(id: string): Promise<void> {
  for (const sub of subtreeOf(id, 0)) {
    if (sub === id) continue;
    try { await archiveOne(sub); } catch (e) {
      console.warn(`[archive] sub-session ${sub} of ${id}: ${(e as Error)?.message ?? e}`);
    }
  }
  await archiveOne(id);
}

/** Back in the workspace, with the sub-sessions archived along (§14.93). */
export async function unarchiveSession(id: string): Promise<void> {
  const ids = subtreeOf(id, 1);
  await unarchiveOne(id);
  for (const sub of ids) {
    if (sub === id) continue;
    try { await unarchiveOne(sub); } catch (e) {
      console.warn(`[unarchive] sub-session ${sub} of ${id}: ${(e as Error)?.message ?? e}`);
    }
  }
}

async function unarchiveOne(id: string): Promise<void> {
  const row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  if (!row) throw new Error('session not found');
  const kind = asSessionProvider(row.kind);
  const unarchiveRpc = PROVIDERS[kind].nativeRpc.unarchive;
  if (unarchiveRpc && row.nativeSessionId) {
    const result = await getAgentClientForVpsId(row.vpsId).call<{ ok?: boolean; error?: string }>(
      unarchiveRpc, { thread_id: row.nativeSessionId, account_profile: accountProfileId(row.providerConfig), cwd: row.cwd },
    );
    if (!result?.ok) throw new Error(result?.error || `${PROVIDERS[kind].label} unarchive failed`);
  }
  db.update(agentSessions).set({ archived: 0, status: 'sleeping', sleepRequested: 1, resumePending: 0 })
    .where(eq(agentSessions.id, id)).run();
  setSessionStatusLocal(id, 'sleeping', { persist: false });
  // Back in the list: the provider republishes its summary.
  emitGlobalSessionListChanged(id);
  void pushPeerHidden(row.vpsId);
}

async function archiveOne(id: string): Promise<void> {
  const row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  if (!row) throw new Error('session not found');
  const client = getAgentClientForVpsId(row.vpsId);
  try {
    await client.call('sleep_session', { session_id: id });
  } catch (e: any) {
    if (!/-32000|-32001|not found|dead/i.test(String(e?.message || e))) throw e;
  }
  // The worker is now gone even if the archive RPC below fails. Persist
  // that truth first so the sidebar can never claim this row is active
  // while no process backs it.
  db.update(agentSessions).set({ status: 'sleeping', sleepRequested: 1, resumePending: 0 })
    .where(eq(agentSessions.id, id)).run();
  // …and memory + every tab (S5): a hydrated stream kept its live status.
  setSessionStatusLocal(id, 'sleeping', { persist: false });
  // Mirror the state natively when this provider owns an archive store
  // (§14.102); a provider Charon adapts hub-side has no RPC and skips this.
  const kind = asSessionProvider(row.kind);
  const archiveRpc = PROVIDERS[kind].nativeRpc.archive;
  if (archiveRpc && row.nativeSessionId) {
    const result = await client.call<{ ok?: boolean; error?: string }>(archiveRpc, {
      thread_id: row.nativeSessionId, account_profile: accountProfileId(row.providerConfig),
      cwd: row.cwd,
    });
    if (!result?.ok) throw new Error(result?.error || `${PROVIDERS[kind].label} archive failed`);
  }
  let gates: GateRef[] = [];
  db.transaction((tx) => {
    tx.update(agentSessions).set({ archived: 1 })
      .where(eq(agentSessions.id, id)).run();
    // Sleeping the worker invalidates every outstanding interaction. Keep
    // no invisible approval/question capable of marking the VPS busy or of
    // being answered after the thread has left the workspace.
    gates = deleteSessionGates(id);
  });
  // Every removed gate is published, never silent (G7): the cross-session
  // feed is add-only and would keep a ghost "needs you".
  for (const gate of gates) publishInteractionResolved(id, gate.kind, gate.id, 'cancelled');
  // Out of the workspace: free its incremental row folds (re-fold on use).
  invalidateSessionRowCaches(id);
  if (dropTabsForRef('session', id)) emitGlobalTabsChanged();
  // Archived rows are never summaries: the provider publishes `null`.
  emitGlobalSessionListChanged(id);
  // Out of the other agents' `list_sessions` too (§14.118).
  void pushPeerHidden(row.vpsId);
}
