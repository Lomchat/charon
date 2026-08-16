import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions, claudePendingPermissions, claudePendingQuestions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalSessionListChanged, emitGlobalTabsChanged } from '@/lib/server/agent/sessionOps';
import { dropTabsForRef } from '@/lib/server/claude/tabs';

async function rowFor(id: string) {
  return db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get() ?? null;
}

/** Archive keeps the complete Charon DB transcript, but first stops the live
 * worker and then archives its Codex rollout through AsyncCodex. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = await rowFor(id);
  if (!row) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  if (row.kind !== 'codex' || !row.claudeSessionId) {
    return NextResponse.json({ error: 'archive is only available for persisted Codex threads' }, { status: 400 });
  }
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
    const result = await client.call<{ ok?: boolean; error?: string }>('codex_archive_thread', {
      thread_id: row.claudeSessionId,
    });
    if (!result?.ok) throw new Error(result?.error || 'Codex archive failed');
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
  if (row.kind !== 'codex' || !row.claudeSessionId) {
    return NextResponse.json({ error: 'unarchive is only available for persisted Codex threads' }, { status: 400 });
  }
  try {
    const result = await getAgentClientForVpsId(row.vpsId).call<{ ok?: boolean; error?: string }>(
      'codex_unarchive_thread', { thread_id: row.claudeSessionId },
    );
    if (!result?.ok) throw new Error(result?.error || 'Codex unarchive failed');
    db.update(claudeSessions).set({ archived: 0, status: 'sleeping', sleepRequested: 1, resumePending: 0 })
      .where(eq(claudeSessions.id, id)).run();
    emitGlobalSessionListChanged(id);
    return NextResponse.json({ ok: true, archived: false });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
