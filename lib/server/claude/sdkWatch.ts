import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db, vps as vpsTable, claudeSessions, claudePendingPermissions, claudePendingQuestions } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { isVersionOutdated } from '@/lib/version';
import { getSetting, setSetting, getSettingBool } from './settings';
import { getSdkLatestVersion, refreshSdkLatest } from './sdkSync';
import { runAgentUpdateFlow } from './agentUpdate';
import { sendPlainToTelegram } from './telegram';
import { sendPushToAll } from './webPush';

/**
 * Fleet-wide `claude-agent-sdk` auto-update tick.
 *
 * Every TICK_MS (+ a first run shortly after boot): refresh the PyPI latest,
 * find VPSes whose venv SDK is behind (vps.sdkVersion from hello ≥0.12.0 —
 * a pyz-outdated agent alone does NOT trigger the auto path), notify once per
 * new version (Telegram + push), then — if `sdk.auto_update` (default ON) —
 * run the unified update flow (pyz + pip -U + restart + session resume,
 * agentUpdate.ts) on each outdated VPS that is IDLE, in SERIES.
 *
 * Idle gate: no session in active/thinking/starting AND no pending
 * permission/question on any of the VPS's sessions. Busy VPSes are skipped
 * and re-checked next tick; actual attempts (ok or failed) are deduped in
 * memory per (vpsId, version) so a persistently failing VPS isn't hammered
 * every 6h — lost on Charon restart, which is an acceptable retry.
 *
 * Armed from seedInitialData() (same boot path as startTelegramBot), with a
 * globalThis singleton guard so HMR / repeated seeds never double-arm.
 */

const TICK_MS = 6 * 60 * 60 * 1000; // 6h
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000; // ~2min after boot (let agents hello first)

type SdkWatchState = {
  timer: ReturnType<typeof setInterval> | null;
  firstRun: ReturnType<typeof setTimeout> | null;
  ticking: boolean;
  // `${vpsId}@${version}` → ts of the auto-update ATTEMPT (busy skips are
  // NOT recorded — they must be retried on the next tick).
  attempted: Map<string, number>;
};

const g = globalThis as unknown as { _sdkWatch?: SdkWatchState };

export function armSdkAutoUpdate(): void {
  // Never arm timers inside `next build` workers (§14.12 family of bugs).
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (g._sdkWatch) return; // already armed (seed is called from several paths)
  const state: SdkWatchState = { timer: null, firstRun: null, ticking: false, attempted: new Map() };
  g._sdkWatch = state;
  state.firstRun = setTimeout(() => { void tick(); }, FIRST_RUN_DELAY_MS);
  state.firstRun.unref?.();
  state.timer = setInterval(() => { void tick(); }, TICK_MS);
  state.timer.unref?.();
  console.log('[sdkWatch] armed (first check in ~2min, then every 6h)');
}

/** True if the VPS has anything a restart would disturb: a running/starting
 *  session or an unanswered permission/question. Cheap indexed probes. */
function isVpsBusy(vpsId: string): boolean {
  const active = db.select({ id: claudeSessions.id })
    .from(claudeSessions)
    .where(and(
      eq(claudeSessions.vpsId, vpsId),
      inArray(claudeSessions.status, ['active', 'thinking', 'starting']),
    ))
    .limit(1).all();
  if (active.length > 0) return true;
  const perm = db.select({ sid: claudePendingPermissions.sessionId })
    .from(claudePendingPermissions)
    .innerJoin(claudeSessions, eq(claudePendingPermissions.sessionId, claudeSessions.id))
    .where(and(eq(claudeSessions.vpsId, vpsId), eq(claudePendingPermissions.status, 'pending')))
    .limit(1).all();
  if (perm.length > 0) return true;
  const q = db.select({ sid: claudePendingQuestions.sessionId })
    .from(claudePendingQuestions)
    .innerJoin(claudeSessions, eq(claudePendingQuestions.sessionId, claudeSessions.id))
    .where(and(eq(claudeSessions.vpsId, vpsId), eq(claudePendingQuestions.status, 'pending')))
    .limit(1).all();
  return q.length > 0;
}

async function tick(): Promise<void> {
  const state = g._sdkWatch;
  if (!state || state.ticking) return; // a slow batch (serial pip installs) must not overlap
  state.ticking = true;
  try {
    // Forced refresh (not IfStale): the tick period (6h) is our refresh
    // cadence and the first boot run needs an answer NOW, not after the 12h
    // TTL. refreshSdkLatest never throws; on failure fall back to the cached
    // value below.
    const r = await refreshSdkLatest();
    if (!r.ok) console.warn('[sdkWatch] pypi refresh failed:', r.error);
    const latest = getSdkLatestVersion();
    if (!latest) return; // never synced successfully → nothing to compare against

    // Outdated = agent ok AND it reported its venv SDK version AND that
    // version < latest. NULL sdkVersion (agent <0.12.0) is invisible here —
    // the pyz badge/manual button handles those.
    const fleet: Vps[] = db.select().from(vpsTable).where(eq(vpsTable.agentStatus, 'ok')).all();
    const outdated = fleet
      .filter((v) => v.sdkVersion && isVersionOutdated(v.sdkVersion, latest))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    console.log(`[sdkWatch] tick: latest=${latest}, fleet ok=${fleet.length}, sdk-outdated=${outdated.length}${outdated.length ? ` (${outdated.map((v) => v.name).join(', ')})` : ''}`);
    if (outdated.length === 0) return;

    // --- New-version notification (once per version, cross-restart durable) ---
    if (latest !== (getSetting('sdk.last_notified_version') || '')) {
      const auto = getSettingBool('sdk.auto_update');
      const lines = outdated.map((v) => `• ${v.name} (${v.sdkVersion})`).join('\n');
      const text =
        `claude-agent-sdk ${latest} is out — ${outdated.length} VPS behind:\n${lines}\n` +
        (auto ? 'Auto-update will run when each VPS is idle.' : 'Auto-update is OFF — use the update button in the sidebar.');
      // Telegram self-gates on telegram.enabled (§7 — never wrap it).
      sendPlainToTelegram(text, '/').catch(() => {});
      // webPush does NOT self-gate → gate at the call-site (shellNotify model).
      if (getSettingBool('notif.global_enabled')) {
        sendPushToAll({
          title: `claude-agent-sdk ${latest} available`,
          body: `${outdated.length} VPS behind: ${outdated.map((v) => v.name).join(', ')}`,
          url: '/',
          tag: 'sdk-latest',
        }).catch(() => {});
      }
      setSetting('sdk.last_notified_version', latest);
    }

    if (!getSettingBool('sdk.auto_update')) return;

    // --- Serial auto-update of the idle ones ---
    const updated: string[] = [];
    const skippedBusy: string[] = [];
    const failed: string[] = [];
    for (const v of outdated) {
      const key = `${v.id}@${latest}`;
      if (state.attempted.has(key)) continue; // already tried this version this process — badge + button remain
      if (isVpsBusy(v.id)) {
        console.log(`[sdkWatch] ${v.name}: busy, skipped (retry next tick)`);
        skippedBusy.push(v.name);
        continue;
      }
      state.attempted.set(key, Date.now());
      console.log(`[sdkWatch] ${v.name}: idle, auto-updating (sdk ${v.sdkVersion} → ${latest})`);
      const res = await runAgentUpdateFlow(v);
      if (res.ok && res.sdkVersion) {
        updated.push(`${v.name} → ${res.sdkVersion}`);
        console.log(`[sdkWatch] ${v.name}: updated (sdk ${res.sdkVersion}, resumed ${res.resumedSessionIds.length})`);
      } else {
        // ok:false (deploy/restart failed) or ok:true without sdkVersion
        // (pyz fine, pip step failed — non-fatal in updateVpsAgent).
        failed.push(`${v.name}: ${(res.detail || 'sdk step failed').slice(-160)}`);
        console.warn(`[sdkWatch] ${v.name}: auto-update failed — ${res.detail}`);
      }
    }

    // Batch summary — only when something was actually attempted (a busy-only
    // tick every 6h would just be noise; those VPSes stay badge-lit anyway).
    if (updated.length > 0 || failed.length > 0) {
      const parts: string[] = [`SDK auto-update (latest ${latest}):`];
      if (updated.length) parts.push(`✓ updated: ${updated.join(', ')}`);
      if (skippedBusy.length) parts.push(`⏸ busy, retry later: ${skippedBusy.join(', ')}`);
      if (failed.length) parts.push(`✗ failed:\n${failed.map((f) => `• ${f}`).join('\n')}`);
      sendPlainToTelegram(parts.join('\n'), '/').catch(() => {});
    }
  } catch (e) {
    console.error('[sdkWatch] tick failed', e);
  } finally {
    state.ticking = false;
  }
}
