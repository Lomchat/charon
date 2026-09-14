import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions, claudePendingPermissions, claudePendingQuestions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalSessionListChanged, emitGlobalTabsChanged } from '@/lib/server/agent/sessionOps';
import { dropTabsForRef } from '@/lib/server/claude/tabs';
import { PROVIDERS, asSessionProvider } from '@/lib/sessionCapabilities';

async function rowFor(id: string) {
  return db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get() ?? null;
}

/** Archive is the common reversible "remove from the workspace" operation.
 * Both providers keep their complete Charon transcript. Codex additionally
 * mirrors the state into its native thread archive; Claude has no native
 * archive and therefore needs no remote metadata call. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = await rowFor(id);
  if (!row) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  try {
    const client = getAgentClientForVpsId(row.vpsId);
    try {
      await client.call('sleep_session', { session_id: id });
    } catch (e: any) {
      if (!/-32000|-32001|not found|dead/i.test(String(e?.message || e))) throw e;
    }
    // The worker is now gone even if the archive RPC below fails. Persist
    // that truth first so the sidebar can never claim this row is active
    // while no process backs it.
    db.update(claudeSessions).set({ status: 'sleeping', sleepRequested: 1, resumePending: 0 })
      .where(eq(claudeSessions.id, id)).run();
    // Mirror the state natively when this provider owns an archive store
    // (§14.102); a provider Charon adapts hub-side has no RPC and skips this.
    const kind = asSessionProvider(row.kind);
    const archiveRpc = PROVIDERS[kind].nativeRpc.archive;
    if (archiveRpc && row.claudeSessionId) {
      const result = await client.call<{ ok?: boolean; error?: string }>(archiveRpc, {
        thread_id: row.claudeSessionId,
        cwd: row.cwd,
      });
      if (!result?.ok) throw new Error(result?.error || `${PROVIDERS[kind].label} archive failed`);
    }
    db.transaction((tx) => {
      tx.update(claudeSessions).set({ archived: 1 })
        .where(eq(claudeSessions.id, id)).run();
      // Sleeping the worker invalidates every outstanding interaction. Keep
      // no invisible approval/question capable of marking the VPS busy or of
      // being answered after the thread has left the workspace.
      tx.delete(claudePendingPermissions)
        .where(eq(claudePendingPermissions.sessionId, id)).run();
      tx.delete(claudePendingQuestions)
        .where(eq(claudePendingQuestions.sessionId, id)).run();
    });
    if (dropTabsForRef('session', id)) emitGlobalTabsChanged();
    emitGlobalSessionListChanged(id);
    return NextResponse.json({ ok: true, archived: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = await rowFor(id);
  if (!row) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  try {
    const kind = asSessionProvider(row.kind);
    const unarchiveRpc = PROVIDERS[kind].nativeRpc.unarchive;
    if (unarchiveRpc && row.claudeSessionId) {
      const result = await getAgentClientForVpsId(row.vpsId).call<{ ok?: boolean; error?: string }>(
        unarchiveRpc, { thread_id: row.claudeSessionId, cwd: row.cwd },
      );
      if (!result?.ok) throw new Error(result?.error || `${PROVIDERS[kind].label} unarchive failed`);
    }
    db.update(claudeSessions).set({ archived: 0, status: 'sleeping', sleepRequested: 1, resumePending: 0 })
      .where(eq(claudeSessions.id, id)).run();
    emitGlobalSessionListChanged(id);
    return NextResponse.json({ ok: true, archived: false });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
