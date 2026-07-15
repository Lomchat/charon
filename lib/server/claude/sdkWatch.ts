import 'server-only';
import { and, asc, eq, gt, inArray, like } from 'drizzle-orm';
import { db, vps as vpsTable, claudeSessions, claudeSessionMessages, claudePendingPermissions, claudePendingQuestions } from '@/lib/db';
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

// A VPS whose sessions merely EXIST must still auto-update: the update flow
// sleeps + resumes running sessions transparently (runAgentUpdateFlow, §14.51/
// §14.53). The original gate treated any status='active' session (= alive but
// idle at the prompt) as busy — on a fleet of always-on sessions that meant
// "never idle, never auto-updated". Busy now means something is ACTUALLY
// happening that a restart would break:
//   1. a turn in flight (thinking) or a session booting (starting);
//   2. an unanswered permission/question (the restart would orphan it);
//   3. a RUNNING background task (its process dies with the CLI, §14.54);
//   4. recent activity — any message row in the last QUIET_WINDOW_S: the
//      user is actively working this VPS, don't restart under their feet
//      even between turns.
const QUIET_WINDOW_S = 30 * 60;
// Ignore "running" bg tasks whose start is older than this — a lost
// 'finished' event would otherwise wedge the VPS as forever-busy.
const BG_TASK_MAX_AGE_S = 24 * 60 * 60;

/** True if any bg task of this session looks currently RUNNING (per the
 *  persisted bg_task event rows, same semantics as app/bgTasks.ts). */
function hasRunningBgTask(sessionId: string, nowS: number): boolean {
  const rows = db.select({ content: claudeSessionMessages.content, createdAt: claudeSessionMessages.createdAt })
    .from(claudeSessionMessages)
    .where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      eq(claudeSessionMessages.role, 'event'),
      like(claudeSessionMessages.content, '%"bg_task"%'),
    ))
    .orderBy(asc(claudeSessionMessages.id))
    .all();
  const running = new Map<string, number>(); // taskId → startedAt
  for (const r of rows) {
    try {
      const ev = JSON.parse(r.content);
      if (ev?.type !== 'bg_task' || !ev.taskId) continue;
      if (ev.kind === 'finished'
          || (ev.kind === 'updated' && /kill|fail|complet|cancel|abort|done|success/i.test(ev.status ?? ''))) {
        running.delete(ev.taskId);
      } else {
        if (!running.has(ev.taskId)) running.set(ev.taskId, r.createdAt);
      }
    } catch {}
  }
  for (const startedAt of running.values()) {
    if (nowS - startedAt < BG_TASK_MAX_AGE_S) return true;
  }
  return false;
}

function isVpsBusy(vpsId: string): boolean {
  // 1. Turn in flight / session booting.
  const working = db.select({ id: claudeSessions.id })
    .from(claudeSessions)
    .where(and(
      eq(claudeSessions.vpsId, vpsId),
      inArray(claudeSessions.status, ['thinking', 'starting']),
    ))
    .limit(1).all();
  if (working.length > 0) return true;
  // 2. Unanswered permission / question.
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
  if (q.length > 0) return true;
  // 3./4. probes only concern LIVE sessions (a sleeping session's bg tasks
  // are already dead and its history is inert).
  const live = db.select({ id: claudeSessions.id })
    .from(claudeSessions)
    .where(and(
      eq(claudeSessions.vpsId, vpsId),
      eq(claudeSessions.status, 'active'),
    ))
    .all();
  if (live.length === 0) return false;
  const ids = live.map((r) => r.id);
  const nowS = Math.floor(Date.now() / 1000);
  // 4. Recent activity across the VPS's live sessions.
  const recent = db.select({ id: claudeSessionMessages.id })
    .from(claudeSessionMessages)
    .where(and(
      inArray(claudeSessionMessages.sessionId, ids),
      gt(claudeSessionMessages.createdAt, nowS - QUIET_WINDOW_S),
    ))
    .limit(1).all();
  if (recent.length > 0) return true;
  // 3. Running background task on any live session.
  for (const sid of ids) {
    if (hasRunningBgTask(sid, nowS)) return true;
  }
  return false;
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
      if (state.attempted.has(key)) {
        // Already attempted this exact version in this process (success or
        // failure) — no hammering; a NEW version or a Charon restart
        // re-enables. Logged so the tick output accounts for every
        // outdated VPS (a silent skip reads as a bug in the journal).
        console.log(`[sdkWatch] ${v.name}: ${latest} already attempted this process — skipped (badge/button remain)`);
        continue;
      }
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
        // TRANSIENT network failures (this hub's outbound SSH flaps
        // regularly) get another shot next tick — otherwise a single
        // timeout would freeze the VPS on the old SDK until the NEXT
        // version or a Charon restart. Genuine failures (pip broken,
        // disk full…) stay deduped: badge + manual button remain.
        if (/timed out|timeout|connection (refused|reset|lost|closed)|ssh:|no route|unreachable/i
            .test(res.detail ?? '')) {
          state.attempted.delete(key);
          console.log(`[sdkWatch] ${v.name}: failure looks transient (network) — will retry next tick`);
        }
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
