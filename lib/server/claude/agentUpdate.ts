import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db, vps as vpsTable, claudeSessions, claudeSessionLogs } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { updateVpsAgent, type UpdateAgentResult } from './bootstrap';
import { dropAgentClient, getAgentClient, getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { armAgentClientHooks } from '@/lib/server/agent/autoConnect';
import { resumeSession } from '@/lib/server/agent/sessionOps';

/**
 * The COMPLETE agent-update orchestration, shared by the manual route
 * (POST /api/vps/[id]/agent/update) and the SDK auto-update tick
 * (sdkWatch.ts) so the §14.51 subtleties live in exactly one place:
 *
 *   1. snapshot the sessions that should come back up afterwards
 *      (running AND not user-requested-asleep — sleepRequested=0);
 *   2. dropAgentClient BEFORE touching the binary (else the client's retry
 *      loop races the .pyz swap);
 *   3. updateVpsAgent: deploy pyz + ensureSdkLatest (venv pip -U) + unit
 *      rewrite (KillMode=process, §14.44) + restart + ping;
 *   4. recreate the AgentClient + armAgentClientHooks — ALWAYS, even on a
 *      failed update: the drop in (2) left the pool without a hooked client,
 *      and a daemon that survived a failed deploy still has live sessions
 *      that would otherwise go silent (§14.51);
 *   5. persist the new version/sha/sdkVersion (hello would repersist later,
 *      but this closes the stale-badge window);
 *   6. fire-and-forget resumeSession() for the snapshot — the agent's
 *      SIGTERM marked them 'sleeping' in state.json, so without this an
 *      update silently pauses every running chat. NOT awaited: each resume
 *      waits on the fresh client's ready() (up to 30s) and the route/tick
 *      must not block on it. resumeSession is noop-tolerant (dedup
 *      _resumeInflight, adopts the RPC's resolvedStatus, §14.36) and
 *      re-reads model/effort from DB (§14.35).
 */
export type AgentUpdateFlowResult = UpdateAgentResult & {
  // Sessions we asked to resume after the restart (fire-and-forget).
  resumedSessionIds: string[];
};

export async function runAgentUpdateFlow(vps: Vps): Promise<AgentUpdateFlowResult> {
  // 1. Snapshot BEFORE the drop/update: these DB statuses are still the
  // pre-update truth. sleepRequested=1 means the user WANTS it asleep —
  // never resurrect those (§14.46).
  let toResume: string[] = [];
  try {
    toResume = db.select({ id: claudeSessions.id })
      .from(claudeSessions)
      .where(and(
        eq(claudeSessions.vpsId, vps.id),
        inArray(claudeSessions.status, ['active', 'thinking', 'starting']),
        eq(claudeSessions.sleepRequested, 0),
      ))
      .all()
      .map((r) => r.id);
  } catch {}

  // 2. Cut the live connection BEFORE killing the process, otherwise
  // AgentClient triggers its retry-loop on a binary currently being
  // replaced → either we read the old one (race), or we stay
  // "reconnecting" for a long time.
  try { await dropAgentClient(vps.id); } catch {}

  // 3. Deploy pyz + SDK upgrade + restart + ping.
  let result: UpdateAgentResult;
  try {
    result = await updateVpsAgent(vps);
  } catch (e: any) {
    result = { ok: false, detail: `unhandled: ${String(e?.stack ?? e?.message ?? e).slice(0, 500)}` };
  }

  // 4. Recreate the AgentClient and re-arm the self-healing hooks
  // (reconcile + shell watch + login check) UNCONDITIONALLY — cf. §14.51:
  // the fresh pool instance has empty subscribers and autoConnect won't
  // re-run (_agentBooted). Without this every running session on this VPS
  // goes silent until a full Charon restart.
  try {
    const client = getAgentClient(vps);
    armAgentClientHooks(client, vps.id);
  } catch {}

  if (!result.ok) return { ...result, resumedSessionIds: [] };

  // 5. Persist immediately (don't wait for the next hello). sdkVersion /
  // codexSdkVersion / codexAvailable only when the update actually confirmed
  // them (from the post-restart hello, falling back to the pip step) — no
  // null-clobber of a value an older agent can't report (§14.53).
  try {
    db.update(vpsTable).set({
      agentVersion: result.newVersion ?? null,
      agentPyzSha: result.newPyzSha ?? null,
      agentLastSeenAt: Math.floor(Date.now() / 1000),
      ...(result.sdkVersion ? { sdkVersion: result.sdkVersion } : {}),
      ...(result.codexSdkVersion ? { codexSdkVersion: result.codexSdkVersion } : {}),
      ...(result.codexAvailable !== undefined ? { codexAvailable: result.codexAvailable ? 1 : 0 } : {}),
    }).where(eq(vpsTable.id, vps.id)).run();
  } catch {}

  // 6. Bring the snapshot back up. Mirrors autoConnect's opportunistic boot
  // resume (incl. the §14.45 RC3 false-sleep guard: only degrade to
  // 'sleeping' when the agent is genuinely unreachable — a slow reconnect
  // must not pause a live session).
  for (const sid of toResume) {
    resumeSession(sid)
      .then(() => {
        try {
          db.insert(claudeSessionLogs).values({
            sessionId: sid, level: 'info', event: 'post_update_resume', detail: null,
          }).run();
        } catch {}
      })
      .catch((e) => {
        try {
          db.insert(claudeSessionLogs).values({
            sessionId: sid, level: 'warn', event: 'post_update_resume',
            detail: JSON.stringify({ err: e?.message ?? String(e) }),
          }).run();
          let connected = false;
          try { connected = getAgentClientForVpsId(vps.id).status === 'connected'; } catch {}
          if (!connected) {
            db.update(claudeSessions).set({ status: 'sleeping' })
              .where(eq(claudeSessions.id, sid)).run();
          }
        } catch {}
      });
  }

  return { ...result, resumedSessionIds: toResume };
}
