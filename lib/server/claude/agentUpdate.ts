import 'server-only';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, vps as vpsTable, claudeSessions } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { updateVpsAgent, type UpdateAgentResult } from './bootstrap';
import { dropAgentClient, getAgentClient, holdAgentConnection } from '@/lib/server/agent/AgentClientPool';
import { resumeUpdatedSessions } from './resumeUpdatedSessions';
import { armAgentClientHooks } from '@/lib/server/agent/autoConnect';
import { emitGlobalVpsStatus } from '@/lib/server/agent/sessionOps';

/** One update per VPS, including confirmed session recovery. Pool users wait
 * until the replacement daemon is available; durable intent survives hub exit. */
export type AgentUpdateFlowResult = UpdateAgentResult & {
  // Sessions confirmed active/thinking on the replacement daemon.
  resumedSessionIds: string[];
};

const g = globalThis as unknown as {
  _agentUpdates?: Map<string, Promise<AgentUpdateFlowResult>>;
};
const updates = g._agentUpdates ??= new Map<string, Promise<AgentUpdateFlowResult>>();

export function runAgentUpdateFlow(vps: Vps): Promise<AgentUpdateFlowResult> {
  const existing = updates.get(vps.id);
  if (existing) return existing;
  const pending = Promise.resolve().then(() => updateAndResume(vps));
  updates.set(vps.id, pending);
  void pending.finally(() => updates.delete(vps.id)).catch(() => {});
  return pending;
}

async function updateAndResume(vps: Vps): Promise<AgentUpdateFlowResult> {
  const release = holdAgentConnection(vps.id);
  try {
    return await performUpdate(vps, release);
  } finally {
    // Also release callers if snapshotting or reconnect setup throws.
    release();
  }
}

async function performUpdate(vps: Vps, release: () => void): Promise<AgentUpdateFlowResult> {
  // 1. Snapshot BEFORE the drop/update: these DB statuses are still the
  // pre-update truth. sleepRequested=1 means the user WANTS it asleep —
  // never resurrect those (§14.46).
  const toResume = db.select({ id: claudeSessions.id })
    .from(claudeSessions)
    .where(and(
      eq(claudeSessions.vpsId, vps.id),
      eq(claudeSessions.archived, 0),
      or(inArray(claudeSessions.status, ['active', 'thinking', 'starting', 'failed', 'background']),
        eq(claudeSessions.resumePending, 1)),
      eq(claudeSessions.sleepRequested, 0),
    ))
    .all().map((r) => r.id);
  // Persist intent before touching the daemon. Startup acknowledgement does
  // not satisfy it; a confirmed active/thinking session does (§14.62).
  if (toResume.length) {
    db.update(claudeSessions).set({ resumePending: 1 })
      .where(inArray(claudeSessions.id, toResume)).run();
  }

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
    release();
    client.ready().catch(() => {});
  } finally { release(); }

  // 5. Persist immediately (don't wait for the next hello). EVERY field is
  // written only when the update actually confirmed it (post-restart hello,
  // falling back to the pip step) — no null-clobber (§14.53). agentVersion is
  // in that set since §14.6 made it the staleness baseline: nulling it would
  // make the VPS invisible to the update axis (no badge, no auto-update) until
  // the next hello, whereas keeping the previous value leaves the badge lit —
  // visible, and self-healing on the reconnect this flow triggers anyway.
  if (result.ok) try {
    db.update(vpsTable).set({
      ...(result.newVersion ? { agentVersion: result.newVersion } : {}),
      ...(result.newPyzSha ? { agentPyzSha: result.newPyzSha } : {}),
      agentLastSeenAt: Math.floor(Date.now() / 1000),
      ...(result.sdkVersion ? { sdkVersion: result.sdkVersion } : {}),
      ...(result.codexSdkVersion ? { codexSdkVersion: result.codexSdkVersion } : {}),
      ...(result.codexCliVersion ? { codexCliVersion: result.codexCliVersion } : {}),
      ...(result.cursorSdkVersion ? { cursorSdkVersion: result.cursorSdkVersion } : {}),
      ...(result.cursorAvailable !== undefined ? { cursorAvailable: result.cursorAvailable ? 1 : 0 } : {}),
      ...(result.codexAvailable !== undefined ? { codexAvailable: result.codexAvailable ? 1 : 0 } : {}),
    }).where(eq(vpsTable.id, vps.id)).run();
    // Mirror the persist onto the live bus — WITHOUT this, an update driven by
    // the auto-tick or by ANOTHER device never reaches open tabs (the initiator
    // patches its own state from the HTTP response; everyone else stayed stale
    // until F5). Same payload contract as the hello emit (no-clobber keys).
    emitGlobalVpsStatus(vps.id, 'ok', {
      ...(result.newVersion ? { agentVersion: result.newVersion } : {}),
      ...(result.newPyzSha ? { agentPyzSha: result.newPyzSha } : {}),
      agentLastError: null,
      ...(result.sdkVersion ? { sdkVersion: result.sdkVersion } : {}),
      ...(result.codexSdkVersion ? { codexSdkVersion: result.codexSdkVersion } : {}),
      ...(result.codexCliVersion ? { codexCliVersion: result.codexCliVersion } : {}),
      ...(result.cursorSdkVersion ? { cursorSdkVersion: result.cursorSdkVersion } : {}),
      ...(result.cursorAvailable !== undefined ? { cursorAvailable: result.cursorAvailable ? 1 : 0 } : {}),
      ...(result.codexAvailable !== undefined ? { codexAvailable: result.codexAvailable ? 1 : 0 } : {}),
    });
  } catch {}

  // A failed deployment can still have stopped sessions. Recover them too.
  const recovery = await resumeUpdatedSessions(vps.id, toResume);
  return { ...result, resumedSessionIds: recovery.resumedSessionIds,
    warnings: [...(result.warnings ?? []), ...recovery.warnings] };
}
