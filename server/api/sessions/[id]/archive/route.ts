import { accountProfileId } from '@/lib/accountProfiles';
import { eq } from 'drizzle-orm';
import { db, agentSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalSessionListChanged, setSessionStatusLocal } from '@/lib/server/agent/sessionOps';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { archiveSession } from '@/lib/server/hub/sessionArchive';
import { PROVIDERS, asSessionProvider } from '@/lib/sessionCapabilities';
import { pushPeerHidden } from '@/lib/server/hub/hiddenSessions';

async function rowFor(id: string) {
  return db.select().from(agentSessions).where(eq(agentSessions.id, id)).get() ?? null;
}

/** Archive (`lib/server/hub/sessionArchive.ts`), or unarchive (DELETE). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = await rowFor(id);
  if (!row) return Response.json({ error: 'session not found' }, { status: 404 });
  try {
    await archiveSession(id);
    return Response.json({ ok: true, archived: true, sync: syncAfter([id]) });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = await rowFor(id);
  if (!row) return Response.json({ error: 'session not found' }, { status: 404 });
  try {
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
    return Response.json({ ok: true, archived: false, sync: syncAfter([id]) });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
