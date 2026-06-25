import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { requireApiSession } from '@/lib/server/session';
import { dropAgentClient, getAgentClient } from '@/lib/server/agent/AgentClientPool';
import { armAgentClientHooks } from '@/lib/server/agent/autoConnect';
import { ensureAgentRunning } from '@/lib/server/claude/bootstrap';
import type { AgentClient } from '@/lib/server/agent/AgentClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Drop any stuck/reconnecting client and re-establish a fresh SSH + hello
// (bypassing the up-to-5min reconnect backoff). Returns once connected or
// after `waitMs`.
async function tryConnect(v: Vps, waitMs: number): Promise<AgentClient> {
  try { await dropAgentClient(v.id); } catch {}
  const client = getAgentClient(v);
  try {
    await Promise.race([
      client.ready(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), waitMs)),
    ]);
  } catch {}
  return client;
}

// POST /api/vps/[id]/agent/refresh
// Manual "reconnect" for a VPS shown as 'error' whose agent is actually fine.
// The SSH `--connect` proxy is a transport tunnel to the agent's Unix socket;
// the daemon runs independently and survives the SSH dropping. So 'error' is
// usually a transient transport drop (the daemon is alive) — but it can also
// mean the daemon itself died (proxy exits 2 = socket absent). We handle both:
//   Phase 1: a bare reconnect. Covers the transient drop and does NOT touch the
//            daemon, so a live agent's in-flight SDK turns are never disrupted.
//   Phase 2 (only if Phase 1 fails): start the daemon IF it isn't already
//            running, then reconnect. Revives a dead daemon without restarting
//            a healthy one. See §14 gotcha "false agent-in-error".
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const ok = (client: AgentClient) => {
    // This recreated client object lost autoConnect's onStatus hook. Re-arm the
    // FULL self-healing set (reconcile + re-attach the running sessions' streams
    // + shell-idle watch + login refresh) — not just the shell watcher — so a
    // manual refresh also un-freezes any session stranded on the dead client.
    // cf. CLAUDE.md §14.51.
    armAgentClientHooks(client, v.id);
    return NextResponse.json({
      ok: true,
      agentStatus: 'ok' as const,
      agentVersion: client.hello?.agent_version ?? null,
      agentPyzSha: client.hello?.agent_pyz_sha ?? null,
    });
  };

  // Phase 1: bare reconnect (daemon untouched).
  let client = await tryConnect(v, 12_000);
  if (client.status === 'connected' && client.hello) return ok(client);

  // Phase 2: the daemon is likely dead — start it if it isn't already running.
  try {
    const r = await ensureAgentRunning(v);
    if (r.ok && r.mode !== 'already') {
      // Give the freshly-started daemon a moment to open its socket.
      await new Promise((res) => setTimeout(res, 1500));
      client = await tryConnect(v, 12_000);
      if (client.status === 'connected' && client.hello) return ok(client);
    }
  } catch (e) {
    console.warn(`[agent/refresh ${v.id}] ensureAgentRunning threw:`, e);
  }

  // Still failing → persist + return a definitive verdict (the auto path gates
  // 'error' behind a reconnect threshold, so it may not be written yet).
  const status = client.lastClassified ?? 'error';
  try {
    db.update(vpsTable).set({ agentStatus: status }).where(eq(vpsTable.id, v.id)).run();
  } catch {}
  return NextResponse.json({
    ok: false,
    agentStatus: status,
    error: client.lastConnectError ?? 'agent unreachable',
  });
}
