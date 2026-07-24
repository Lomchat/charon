import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db, vps as vpsTable, claudeSessions, claudeSessionLogs } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { updateVpsAgent, type UpdateAgentResult } from './bootstrap';
import { dropAgentClient, getAgentClient, getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { armAgentClientHooks } from '@/lib/server/agent/autoConnect';
import { resumeSession, emitGlobalVpsStatus } from '@/lib/server/agent/sessionOps';

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
    // DURABLE resume intent (§14.62) — persisted BEFORE the update touches
    // anything. The fire-and-forget resumes in step 6 die with a hub restart
    // (deploys happen mid-update on this repo — real incident: WS_MASTER's
    // sessions stayed asleep forever); with the flag in DB, the recovery
    // sweeps (autoConnect boot + reconcile-on-connect) finish the job no
    // matter what happens to THIS process. Cleared on successful resume /
    // agent-confirmed running / explicit user sleep.
    if (toResume.length > 0) {
      db.update(claudeSessions).set({ resumePending: 1 })
        .where(inArray(claudeSessions.id, toResume)).run();
    }
  } catch {}

  // 2. Cut the live connection BEFORE killing the process, otherwise
  // AgentClient triggers its retry-loop on a binary currently being
  // replaced → either we read the old one (race), or we stay
  // "reconnecting" for a long time.
  try { await dropAgentClient(vps.id); } catch {}

  // 3. Deploy pyz + SDK upgrade + restart + ping. A TRANSIENT ssh failure
  // (the exact "Connection timed out" flaps that also flip the health badge)
  // gets ONE automatic retry after a short pause — most flaps last seconds,
  // and without this the user sees "updating…" collapse back to "update" for
  // a blip that would have passed on its own. A second failure is returned
  // as-is (surfaced in the UI toast).
  const runOnce = async (): Promise<UpdateAgentResult> => {
    try {
      return await updateVpsAgent(vps);
    } catch (e: any) {
      return { ok: false, detail: `unhandled: ${String(e?.stack ?? e?.message ?? e).slice(0, 500)}` };
    }
  };
  let result = await runOnce();
  if (!result.ok && /timed out|connection refused|connection reset|broken pipe|connection closed|kex_exchange|banner exchange/i.test(result.detail)) {
    console.warn(`[agent-update ${vps.id}] transient ssh failure — retrying once in 8s: ${result.detail.slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, 8_000));
    result = await runOnce();
    if (result.ok) result = { ...result, detail: `${result.detail} (succeeded on retry)` };
  }

  // 4. Recreate the AgentClient and re-arm the self-healing hooks
  // (reconcile + shell watch + login check) UNCONDITIONALLY — cf. §14.51:
  // the fresh pool instance has empty subscribers and autoConnect won't
  // re-run (_agentBooted). Without this every running session on this VPS
  // goes silent until a full Charon restart. Also NUDGE the connection
  // (ready() is lazy): with zero sessions to resume, nothing else would
  // connect the fresh client → no hello → no live vps_status push → other
  // tabs/devices keep a stale version until their next SSR.
  try {
    const client = getAgentClient(vps);
    armAgentClientHooks(client, vps.id);
    client.ready().catch(() => {});
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
    // Mirror the persist onto the live bus — WITHOUT this, an update driven by
    // the auto-tick or by ANOTHER device never reaches open tabs (the initiator
    // patches its own state from the HTTP response; everyone else stayed stale
    // until F5). Same payload contract as the hello emit (no-clobber keys).
    emitGlobalVpsStatus(vps.id, 'ok', {
      agentVersion: result.newVersion ?? null,
      agentPyzSha: result.newPyzSha ?? null,
      agentLastError: null,
      ...(result.sdkVersion ? { sdkVersion: result.sdkVersion } : {}),
      ...(result.codexSdkVersion ? { codexSdkVersion: result.codexSdkVersion } : {}),
      ...(result.codexAvailable !== undefined ? { codexAvailable: result.codexAvailable ? 1 : 0 } : {}),
    });
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
