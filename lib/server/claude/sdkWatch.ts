import 'server-only';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { db, vps as vpsTable, claudeSessions, claudeSessionMessages, claudePendingPermissions, claudePendingQuestions } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { isVersionOutdated, isAgentOutdated, agentBuildRelation, displayVersion } from '@/lib/version';
import { getSetting, setSetting, getSettingBool, type SettingKey } from './settings';
import { getSdkLatestVersion, refreshSdkLatest, getCodexLatestVersion, refreshCodexLatest, getCodexCliLatestVersion, refreshCodexCliLatest } from './sdkSync';
import { getBuiltPyzSha, getBuiltAgentVersion } from '@/lib/server/agent/builtPyzSha';
import { runAgentUpdateFlow, type AgentUpdateFlowResult } from './agentUpdate';
import {
  formatUpdateAnnouncement, formatUpdateSummary, recordFailure, clearFailure,
  type FailureLedger, type UpdatedEntry, type FailedEntry,
} from './updateNotice';
import { sendPlainToTelegram } from './telegram';
import { sendPushToAll } from './webPush';
import { runningBgTasksFromDb, pruneStaleBgTasks } from './bgTaskState';

/**
 * Fleet-wide `claude-agent-sdk` + `openai-codex` auto-update tick.
 *
 * Every TICK_MS (+ a first run shortly after boot): refresh the PyPI latest
 * for BOTH packages, then enroll VPSes outdated on ANY axis — venv SDK behind
 * PyPI latest (vps.sdkVersion, hello ≥0.12.0), venv openai-codex behind PyPI
 * latest (vps.codexSdkVersion, hello ≥0.15.0), OR the deployed agent
 * `__version__` STRICTLY OLDER than the pyz this hub ships (vps.agentVersion,
 * same check as the sidebar "update agent" button, §14.6 — so a version bump
 * auto-propagates fleet-wide while a hub running an older build never rolls a
 * VPS back). Notify once per new SDK / codex / agent version (Telegram +
 * push), then run the unified update flow (pyz +
 * pip -U claude-agent-sdk + pip -U openai-codex + restart + resume,
 * agentUpdate.ts) on each outdated VPS that is IDLE, in SERIES. One flow fixes
 * all axes. Gates are independent: `sdk.auto_update` (default ON) covers the
 * SDK + pyz axes; `codex.auto_update` (default ON) covers the codex axis.
 *
 * Idle gate: no session in active/thinking/starting AND no pending
 * permission/question on any of the VPS's sessions. Busy VPSes are skipped
 * and re-checked next tick; actual attempts (ok or failed) are deduped in
 * memory per (vpsId, version) so a persistently failing VPS isn't hammered
 * every tick — lost on Charon restart, which is an acceptable retry.
 *
 * NOTIFICATION VOLUME is a feature of this tick, not an afterthought: four
 * axes × a near-daily release cadence × a fleet used to mean two Telegram
 * messages per wave, several waves a day. Two rules keep it to what a reader
 * can act on — the heads-up is sent ONLY for an axis whose auto-update gate is
 * OFF (with the gate on, the summary that follows minutes later is the same
 * news, but true), and a failure is reported on a CHANGE of state, never once
 * per retry. Wording lives in updateNotice.ts.
 *
 * Armed from seedInitialData() (same boot path as startTelegramBot), with a
 * globalThis singleton guard so HMR / repeated seeds never double-arm.
 */

// Dedup keys for the notification axes, parallel to
// `sdk.last_notified_version`. Both are registered in settings.ts DEFAULTS
// (internal keys — written here, never POSTable).
const CODEX_LAST_NOTIFIED_KEY: SettingKey = 'codex.last_notified_version';
const CODEX_CLI_LAST_NOTIFIED_KEY: SettingKey = 'codex.last_notified_cli_version';
// Dedup key for the agent axis. Replaces `agent.last_notified_pyz_sha`: the
// key must be the thing we now act on (§14.6), i.e. the VERSION we ship —
// keyed on the sha, a rebuild with no bump would re-notify about an update
// that no longer happens.
const AGENT_LAST_NOTIFIED_KEY: SettingKey = 'agent.last_notified_agent_version';

const TICK_MS = 30 * 60 * 1000; // 30min — cheap probes (SQLite + one PyPI CDN hit)
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000; // ~2min after boot (let agents hello first)

type SdkWatchState = {
  timer: ReturnType<typeof setInterval> | null;
  firstRun: ReturnType<typeof setTimeout> | null;
  ticking: boolean;
  // `${vpsId}@${version}` → ts of the auto-update ATTEMPT (busy skips are
  // NOT recorded — they must be retried on the next tick).
  attempted: Map<string, number>;
  // vpsId → the target it is known to be failing on. A transient failure is
  // retried every tick (see the regex at the bottom of tick()); without this
  // ledger each retry re-sent the same "✗ ElevenDuel: restart failed" line.
  failing: FailureLedger;
};

/**
 * One staleness axis, described ONCE: how it compares, how it is NAMED to a
 * human, which gate covers it, which key remembers we announced it, and how
 * to read its post-update version back. The four axes used to live as four
 * parallel ternaries in six places — which is how the notification ended up
 * repeating every version once per VPS.
 */
type Axis = {
  key: string;
  label: string;   // package name as a human knows it
  short: string;   // compact form inside a per-VPS transition
  prefix: string;  // 'v' for the agent version, '' for the packages
  latest: string | null;
  auto: boolean;
  notifiedKey: SettingKey;
  installed: (v: Vps) => string | null;
  outdated: (v: Vps) => boolean;
  after: (r: AgentUpdateFlowResult) => string | null | undefined;
};

const g = globalThis as unknown as { _sdkWatch?: SdkWatchState };

export function armSdkAutoUpdate(): void {
  // Never arm timers inside `next build` workers (§14.12 family of bugs).
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (g._sdkWatch) return; // already armed (seed is called from several paths)
  const state: SdkWatchState = {
    timer: null, firstRun: null, ticking: false, attempted: new Map(), failing: new Map(),
  };
  g._sdkWatch = state;
  state.firstRun = setTimeout(() => { void tick(); }, FIRST_RUN_DELAY_MS);
  state.firstRun.unref?.();
  state.timer = setInterval(() => { void tick(); }, TICK_MS);
  state.timer.unref?.();
  console.log(`[sdkWatch] armed (first check in ~2min, then every ${Math.round(TICK_MS / 60000)}min)`);
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
/** True if any bg task of this session looks currently RUNNING. The reducer
 *  (and the max-age rule that keeps a lost `finished` from wedging the VPS as
 *  forever-busy) is shared with the session's own `background` status — the two
 *  must not drift, cf. bgTaskState.ts. */
function hasRunningBgTask(sessionId: string, nowS: number): boolean {
  return pruneStaleBgTasks(runningBgTasksFromDb(sessionId), nowS);
}

function isVpsBusy(vpsId: string): boolean {
  // 1. Turn in flight / session booting.
  const working = db.select({ id: claudeSessions.id })
    .from(claudeSessions)
    .where(and(
      eq(claudeSessions.vpsId, vpsId),
      eq(claudeSessions.archived, 0),
      inArray(claudeSessions.status, ['thinking', 'starting']),
    ))
    .limit(1).all();
  if (working.length > 0) return true;
  // 2. Unanswered permission / question.
  const perm = db.select({ sid: claudePendingPermissions.sessionId })
    .from(claudePendingPermissions)
    .innerJoin(claudeSessions, eq(claudePendingPermissions.sessionId, claudeSessions.id))
    .where(and(
      eq(claudeSessions.vpsId, vpsId),
      eq(claudeSessions.archived, 0),
      eq(claudePendingPermissions.status, 'pending'),
    ))
    .limit(1).all();
  if (perm.length > 0) return true;
  const q = db.select({ sid: claudePendingQuestions.sessionId })
    .from(claudePendingQuestions)
    .innerJoin(claudeSessions, eq(claudePendingQuestions.sessionId, claudeSessions.id))
    .where(and(
      eq(claudeSessions.vpsId, vpsId),
      eq(claudeSessions.archived, 0),
      eq(claudePendingQuestions.status, 'pending'),
    ))
    .limit(1).all();
  if (q.length > 0) return true;
  // 3./4. probes only concern LIVE sessions (a sleeping session's bg tasks
  // are already dead and its history is inert).
  const live = db.select({ id: claudeSessions.id })
    .from(claudeSessions)
    .where(and(
      eq(claudeSessions.vpsId, vpsId),
      eq(claudeSessions.archived, 0),
      inArray(claudeSessions.status, ['active', 'failed', 'background']),
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
    // Codex (openai-codex) is a THIRD staleness axis, mirroring the SDK one
    // (§14.53): the venv `openai-codex` (vps.codexSdkVersion, hello ≥0.15.0)
    // behind the PyPI latest. It shares the SAME unified update flow (one
    // runAgentUpdateFlow does pyz + pip -U claude-agent-sdk + pip -U
    // openai-codex + restart), so a VPS behind on any axis is fixed by one run.
    const rc = await refreshCodexLatest();
    if (!rc.ok) console.warn('[sdkWatch] pypi codex refresh failed:', rc.error);
    const rcli = await refreshCodexCliLatest();
    if (!rcli.ok) console.warn('[sdkWatch] npm codex CLI refresh failed:', rcli.error);
    const latest = getSdkLatestVersion();
    const codexLatest = getCodexLatestVersion();
    const codexCliLatest = getCodexCliLatestVersion();
    const builtSha = getBuiltPyzSha();
    const builtVersion = getBuiltAgentVersion();
    // FOUR independent staleness axes, ONE update flow (runAgentUpdateFlow
    // deploys the pyz AND pip-upgrades claude-agent-sdk and openai-codex AND
    // refreshes the standalone codex CLI in a single pass, so a VPS behind on
    // any — or all — is fixed by one run):
    //   · SDK:   venv claude-agent-sdk < PyPI latest (needs vps.sdkVersion,
    //            hello ≥0.12.0 — NULL sdkVersion is invisible to this axis).
    //   · codex: venv openai-codex < PyPI latest (needs vps.codexSdkVersion,
    //            hello ≥0.15.0 — NULL codexSdkVersion is invisible; a VPS
    //            without codex is never enrolled just for this axis). Gated by
    //            `codex.auto_update` (default ON), independent of sdk.auto_update.
    //   · codex CLI: the independent npm release line, same gate.
    //   · agent: deployed `__version__` STRICTLY OLDER than the pyz this hub
    //            ships (§14.6, same check as the sidebar button). ORDERED, so
    //            a hub on an older build leaves a newer VPS alone instead of
    //            rolling it back every tick (§14.70). Equal version + different
    //            sha is NOT an axis: bump `__version__` to propagate.
    if (!latest && !builtVersion && !codexLatest && !codexCliLatest) return; // no way to compare on any axis
    const fleet: Vps[] = db.select().from(vpsTable).where(eq(vpsTable.agentStatus, 'ok')).all();
    // Independent auto-update gates: `sdk.auto_update` covers the SDK + pyz
    // axes; `codex.auto_update` (default ON) covers both codex axes. Either
    // being on is enough to run the (unified) flow for its axis.
    const autoSdk = getSettingBool('sdk.auto_update');
    const autoCodex = getSettingBool('codex.auto_update');
    const axes: Axis[] = [
      {
        key: 'sdk', label: 'claude-agent-sdk', short: 'claude', prefix: '',
        latest, auto: autoSdk, notifiedKey: 'sdk.last_notified_version',
        installed: (v) => v.sdkVersion,
        outdated: (v) => !!latest && !!v.sdkVersion && isVersionOutdated(v.sdkVersion, latest),
        after: (r) => r.sdkVersion,
      },
      {
        // Only VPSes that actually report a codex version (codex installed,
        // hello ≥0.15.0). NULL codexSdkVersion is invisible here — a VPS
        // without codex is never enrolled just for the codex axis.
        key: 'codex', label: 'openai-codex', short: 'codex', prefix: '',
        latest: codexLatest, auto: autoCodex, notifiedKey: CODEX_LAST_NOTIFIED_KEY,
        installed: (v) => v.codexSdkVersion,
        outdated: (v) => !!codexLatest && !!v.codexSdkVersion && isVersionOutdated(v.codexSdkVersion, codexLatest),
        after: (r) => r.codexSdkVersion,
      },
      {
        key: 'codexCli', label: 'codex-cli', short: 'cli', prefix: '',
        latest: codexCliLatest, auto: autoCodex, notifiedKey: CODEX_CLI_LAST_NOTIFIED_KEY,
        installed: (v) => v.codexCliVersion,
        outdated: (v) => !!codexCliLatest && !!v.codexCliVersion && isVersionOutdated(v.codexCliVersion, codexCliLatest),
        after: (r) => r.codexCliVersion,
      },
      {
        key: 'agent', label: 'charon-agent', short: 'agent', prefix: 'v',
        latest: builtVersion, auto: autoSdk, notifiedKey: AGENT_LAST_NOTIFIED_KEY,
        installed: (v) => v.agentVersion,
        outdated: (v) => isAgentOutdated(v.agentVersion, builtVersion),
        // ok:true means the pyz was deployed, restarted and pinged — the
        // version it now runs is the one we shipped.
        after: (r) => r.newVersion ?? builtVersion,
      },
    ];
    // Every version in a MESSAGE goes through displayVersion (a trailing `.0`
    // is noise); comparisons and dedup keys keep the raw string.
    const shown = (v: string | null | undefined, prefix = '') => (v ? `${prefix}${displayVersion(v)}` : '?');
    /** How an axis names its target: `codex-cli 0.150.1`, `charon-agent v0.77`. */
    const targetOf = (a: Axis) => `${a.label} ${shown(a.latest, a.prefix)}`;
    /** A VPS's transition, restricted to the axes the message is about. */
    const reason = (v: Vps, list: Axis[] = axes) => list
      .filter((a) => a.outdated(v))
      .map((a) => `${a.short} ${shown(a.installed(v), a.prefix)}→${shown(a.latest, a.prefix)}`)
      .join(', ');
    const outdated = fleet
      .filter((v) => axes.some((a) => a.outdated(v)))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    // VPSes running an agent NEWER than this hub's build — logged, never
    // touched. On a co-tenant host that line is the expected steady state, not
    // an anomaly: the other hub is simply ahead (§14.70).
    const ahead = fleet.filter((v) => agentBuildRelation(v.agentVersion, builtVersion) === 'ahead');
    if (ahead.length) {
      console.log(`[sdkWatch] ${ahead.length} VPS ahead of this hub's build (v${builtVersion}) — left alone: ${ahead.map((v) => `${v.name} v${v.agentVersion}`).join(', ')}`);
    }
    console.log(`[sdkWatch] tick: sdk-latest=${latest ?? '-'}, codex-sdk=${codexLatest ?? '-'}, codex-cli=${codexCliLatest ?? '-'}, agent=v${builtVersion ?? '-'} (pyz ${builtSha ? builtSha.slice(0, 7) : '-'}), fleet ok=${fleet.length}, outdated=${outdated.length}${outdated.length ? ` (${outdated.map((v) => v.name).join(', ')})` : ''}`);
    if (outdated.length === 0) return;

    // --- Heads-up: once per NEW version of an axis, durable across restarts
    // via the four dedup keys — and ONLY for an axis whose auto-update gate is
    // OFF. With the gate ON the batch summary lands minutes later and reports
    // what actually happened, so announcing first is the same news twice (and
    // the one the reader can do nothing about). The keys advance for EVERY new
    // axis either way, so flipping a gate off later can't resurrect an old
    // announcement.
    const newAxes = axes.filter((a) => a.latest
      && a.latest !== (getSetting(a.notifiedKey) || '')
      && outdated.some(a.outdated));
    const manualAxes = newAxes.filter((a) => !a.auto);
    if (manualAxes.length) {
      const behind = outdated
        .filter((v) => manualAxes.some((a) => a.outdated(v)))
        .map((v) => ({ name: v.name, reason: reason(v, manualAxes) }));
      const targets = manualAxes.map(targetOf);
      // Each channel applies its own event preferences.
      sendPlainToTelegram(formatUpdateAnnouncement({ targets, behind }), '/', 'updates').catch(() => {});
      sendPushToAll({
        event: 'updates',
        title: `${targets.join(' + ')} available`,
        body: `${behind.length} VPS behind: ${behind.map((b) => b.name).join(', ')}`,
        url: '/',
        tag: 'sdk-latest',
      }).catch(() => {});
    }
    for (const a of newAxes) setSetting(a.notifiedKey, a.latest!);

    // Nothing enabled on either axis → notify-only, no auto-update.
    if (!autoSdk && !autoCodex) return;
    // Per-VPS eligibility: update iff it's stale on an axis whose gate is ON.
    const shouldAutoUpdate = (v: Vps) => axes.some((a) => a.auto && a.outdated(v));
    // What this tick is actually rolling out — the summary's head.
    const rolling = axes.filter((a) => a.auto && a.latest && outdated.some(a.outdated));

    // --- Serial auto-update of the idle ones ---
    const updated: UpdatedEntry[] = [];
    const skippedBusy: string[] = [];
    const failed: FailedEntry[] = [];
    for (const v of outdated) {
      // A VPS can be in `outdated` for an axis whose auto-update gate is OFF
      // (e.g. only codex-outdated while codex.auto_update is off). Notify but
      // don't touch it — the badge/manual button remain.
      if (!shouldAutoUpdate(v)) {
        console.log(`[sdkWatch] ${v.name}: outdated axis has auto-update OFF — skipped (badge/button remain)`);
        continue;
      }
      // Key spans ALL axes so a new SDK version, a new codex version OR a
      // newer agent version re-enables a previously-attempted VPS
      // (in-memory; a restart also does).
      const key = `${v.id}@${latest ?? '-'}/${builtVersion ?? '-'}/${codexLatest ?? '-'}/${codexCliLatest ?? '-'}`;
      if (state.attempted.has(key)) {
        // Already attempted this exact target in this process (success or
        // failure) — no hammering; a NEW sdk/codex version or pyz build or a
        // Charon restart re-enables. Logged so the tick output accounts for
        // every outdated VPS (a silent skip reads as a bug in the journal).
        console.log(`[sdkWatch] ${v.name}: this target already attempted this process — skipped (badge/button remain)`);
        continue;
      }
      if (isVpsBusy(v.id)) {
        console.log(`[sdkWatch] ${v.name}: busy, skipped (retry next tick)`);
        skippedBusy.push(v.name);
        continue;
      }
      state.attempted.set(key, Date.now());
      console.log(`[sdkWatch] ${v.name}: idle, auto-updating (${reason(v)})`);
      const res = await runAgentUpdateFlow(v);
      if (res.ok) {
        // ok = pyz deployed + restart + ping OK. sdkVersion/newPyzSha reflect
        // the post-update venv/binary (pip -U is non-fatal, so sdkVersion may
        // be absent if only that sub-step failed while the pyz still updated).
        const done = [
          res.sdkVersion ? `claude ${res.sdkVersion}` : null,
          res.codexSdkVersion ? `codex ${res.codexSdkVersion}` : null,
          res.codexCliVersion ? `cli ${res.codexCliVersion}` : null,
          res.newPyzSha ? `pyz ${res.newPyzSha.slice(0, 7)}` : null,
        ].filter(Boolean).join(', ');
        // Axes this VPS was behind on that did NOT reach the target — the one
        // per-VPS detail a summary needs to print (saying "0.150.1" after nine
        // names that all reached 0.150.1 is what made the old message a wall).
        const stillBehind = rolling.filter((a) => a.outdated(v)).filter((a) => {
          const post = a.after(res);
          return !post || (!!a.latest && isVersionOutdated(post, a.latest));
        });
        // A pyz restart can succeed while the independently downloaded CLI
        // falls back to the SDK bundle. That is a PARTIAL failure, not an
        // update success: keep retrying the same target on later ticks.
        if (stillBehind.some((a) => a.key === 'codexCli')) {
          const detail = `CLI stuck at ${res.codexCliVersion ? displayVersion(res.codexCliVersion) : 'unknown'} (target ${shown(codexCliLatest)})`;
          failed.push({ name: v.name, detail, repeated: !recordFailure(state.failing, v.id, key) });
          state.attempted.delete(key);
          console.warn(`[sdkWatch] ${v.name}: partial auto-update — ${detail}; will retry next tick`);
          continue;
        }
        clearFailure(state.failing, v.id);
        updated.push({
          name: v.name,
          detail: stillBehind.length
            ? `still ${stillBehind.map((a) => `${a.short} ${shown(a.after(res), a.prefix)}`).join(', ')}`
            : undefined,
        });
        console.log(`[sdkWatch] ${v.name}: updated (${done || 'ok'}, resumed ${res.resumedSessionIds.length})`);
      } else {
        // ok:false = deploy/restart/ping failed (the pyz did NOT swap).
        // Reported on a CHANGE of state only: the transient retry below fires
        // this same failure every 30min, and nine identical Telegram lines for
        // one broken VPS is exactly the noise this ledger exists to stop.
        failed.push({
          name: v.name,
          detail: (res.detail || 'update failed').slice(-160),
          repeated: !recordFailure(state.failing, v.id, key),
        });
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

    // Batch summary — only when there is NEWS: something updated, or a failure
    // not already reported for this exact target. A busy-only tick, or one
    // that merely re-fails the same way as 30min ago, stays silent; those
    // VPSes remain badge-lit in the sidebar either way.
    if (updated.length > 0 || failed.some((f) => !f.repeated)) {
      const text = formatUpdateSummary({
        targets: rolling.map(targetOf), updated, failed, busy: skippedBusy,
      });
      if (text) {
        sendPlainToTelegram(text, '/', 'updates').catch(() => {});
        sendPushToAll({ event: 'updates', title: 'Agent / SDK update results', body: text, url: '/', tag: 'sdk-update-result' }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[sdkWatch] tick failed', e);
  } finally {
    state.ticking = false;
  }
}
