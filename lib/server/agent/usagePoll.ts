import 'server-only';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { getAgentClientForVpsId } from './AgentClientPool';
import {
  emitGlobalAccountUsage, setUsagePollTrigger, setCodexUsagePollTrigger,
  setCodexUsagePushHandler,
  setUsageResetResolver,
} from './sessionOps';
import type { AgentUsageResult, AgentCodexUsageResult, CodexRateWindow } from './types';
import { getSetting, setSetting } from '@/lib/server/claude/settings';
import type { AccountUsage, AccountUsageWindow, AccountUsageLimit } from '@/lib/server/claude/types';

// ── Account usage poller (the `/usage` gauges) — CLAUDE.md §14.58 / §14.72 ───
//
// Usage is ACCOUNT-scoped, not session-scoped: it's the Claude Pro/Max quota of
// the OAuth account a VPS is logged into (`claude login`), read from
// api.anthropic.com/api/oauth/usage via the agent's `get_usage` RPC. The stream
// `RateLimitEvent` gives status/reset but NOT the utilization %, so the endpoint
// poll is the source of the gauges.
//
// CADENCE — the endpoint is throttled AT THE EDGE (a 429 there carries no
// request-id and no org header: it never reaches the API), keyed on the SOURCE
// IP, at roughly one call per minute sustained, with escalating lockouts —
// measured live at 6, 17 and 51 minutes on three fleet VPSes simultaneously.
// Three rules keep the fleet far under that ceiling:
//
//  1. ONE poll per ACCOUNT, never per VPS. N VPSes signed into the same account
//     return byte-identical gauges, so polling each of them was pure N-fold
//     waste — 6 VPSes x 90s was 240 calls/h against one account, permanently
//     over budget. The account identity is the `anthropic-organization-id`
//     header, learned from the first successful poll (agent >= 0.22.0); a VPS
//     whose org is not known yet sits in its own private bucket until it is.
//  2. The VPS carrying the RPC ROTATES over the account's eligible VPSes, so
//     the per-IP budget is spread instead of concentrated on the busiest box.
//  3. Backoff follows the server's own `Retry-After` EXACTLY. The old flat
//     5-minute guess retried ~10x into a 51-minute lockout, and every one of
//     those failures re-cached the error as the widget's state.
//
// Snapshots survive a Charon restart (settings key `usage.snapshots`): an
// in-memory-only cache meant every restart started blank, so the first 429 of
// the reconnect burst BECAME the UI — the single most common way users saw
// "Rate-limited by the usage API". With a restored snapshot the widget degrades
// to "updated 12m ago" instead of blanking working numbers.

const POLL_INTERVAL_MS = 90_000;      // Codex only (local app-server, unthrottled)
const MIN_GAP_MS = 8_000;             // Codex only — floor between app-server calls

// Claude account pacing.
const ACCOUNT_MIN_GAP_MS = 120_000;   // hard floor between ANY two polls of one account
const ACCOUNT_STEADY_MS = 300_000;    // steady refresh cadence per account
const TICK_MS = 60_000;               // per-VPS timer; almost always a no-op
// Escalating cool-down used ONLY when the agent gives us no Retry-After
// (< 0.22.0, or a non-429 failure). Indexed by consecutive-failure count.
const SOFT_BACKOFF_MS = [5, 10, 20, 40, 60].map((m) => m * 60_000);
const MAX_HARD_BACKOFF_MS = 60 * 60_000;
export const USAGE_STALE_MS = ACCOUNT_STEADY_MS; // GET route refreshes past this age

// Hub-GLOBAL floor between ANY two /api/oauth/usage calls. With per-account
// polling this only ever serializes DISTINCT accounts, so it can be small; it
// remains as a burst guard for the on-connect storm after a restart.
const GLOBAL_SLOT_GAP_MS = 10_000;
const gSlot = globalThis as unknown as { _usageGlobalSlotAt?: number };
function reserveGlobalSlot(): number {
  const now = Date.now();
  const next = Math.max(now, (gSlot._usageGlobalSlotAt ?? 0) + GLOBAL_SLOT_GAP_MS);
  gSlot._usageGlobalSlotAt = next;
  return next - now; // ms to wait before this caller may hit the endpoint
}

type VpsUsageState = {
  timer: ReturnType<typeof setInterval> | null;
  last: AccountUsage | null;
  lastPollAt: number;
  inflight: Promise<AccountUsage | null> | null;
  // When the pending inflight run will actually reach the endpoint (it may be
  // queued on the global slot) — lets late callers skip awaiting a long queue.
  slotReadyAt: number;
  backoffUntil: number;
  stopDebounce: ReturnType<typeof setTimeout> | null;
};

/** One Anthropic account's poll state. Keyed by org id, or `vps:<id>` for a
 *  VPS whose account we haven't identified yet. */
type AccountState = {
  last: AccountUsage | null;
  lastPollAt: number;
  inflight: Promise<AccountUsage | null> | null;
  slotReadyAt: number;
  hardRetryAt: number;  // from Retry-After — a WALL, never bypassed
  softRetryAt: number;  // our own guess — `force` may bypass it
  failStreak: number;
  rotate: number;       // round-robin cursor over the account's VPSes
};

const g = globalThis as unknown as {
  _usageAccounts?: Map<string, AccountState>;
  _usageVpsOrg?: Map<string, string>;
  _usageTimers?: Map<string, ReturnType<typeof setInterval>>;
  _usageStopDebounce?: Map<string, ReturnType<typeof setTimeout>>;
  _usageLoaded?: boolean;
};
if (!g._usageAccounts) g._usageAccounts = new Map();
if (!g._usageVpsOrg) g._usageVpsOrg = new Map();
if (!g._usageTimers) g._usageTimers = new Map();
if (!g._usageStopDebounce) g._usageStopDebounce = new Map();
const accounts: Map<string, AccountState> = g._usageAccounts;
const vpsOrg: Map<string, string> = g._usageVpsOrg;
const timers: Map<string, ReturnType<typeof setInterval>> = g._usageTimers;
const stopDebounce: Map<string, ReturnType<typeof setTimeout>> = g._usageStopDebounce;

function accountState(key: string): AccountState {
  let st = accounts.get(key);
  if (!st) {
    st = { last: null, lastPollAt: 0, inflight: null, slotReadyAt: 0, hardRetryAt: 0, softRetryAt: 0, failStreak: 0, rotate: 0 };
    accounts.set(key, st);
  }
  return st;
}

/** Restore the last good snapshot per account + the learned VPS→account map.
 *  Idempotent; called from every entry point (module init order is not
 *  guaranteed relative to the first poll). */
function loadPersisted(): void {
  if (g._usageLoaded) return;
  g._usageLoaded = true;
  try {
    const raw = getSetting('usage.snapshots');
    if (!raw) return;
    const p = JSON.parse(raw) as { vpsOrg?: Record<string, string>; accounts?: Record<string, AccountUsage> };
    for (const [v, o] of Object.entries(p.vpsOrg ?? {})) if (v && o) vpsOrg.set(v, o);
    for (const [k, snap] of Object.entries(p.accounts ?? {})) {
      if (snap && snap.ok) accountState(k).last = snap;
    }
  } catch { /* a corrupt cache is not worth a boot failure */ }
}

/** Persist the good snapshots (called on every success — a handful per hour). */
function persistSnapshots(): void {
  try {
    const out: Record<string, AccountUsage> = {};
    for (const [k, st] of accounts) if (st.last?.ok) out[k] = st.last;
    setSetting('usage.snapshots', JSON.stringify({ vpsOrg: Object.fromEntries(vpsOrg), accounts: out }));
  } catch { /* best-effort */ }
}

function accountKeyFor(vpsId: string): string {
  loadPersisted();
  return vpsOrg.get(vpsId) ?? `vps:${vpsId}`;
}

/** Every VPS known to sit on this account (stable order → fair rotation). */
function vpsesForAccount(key: string): string[] {
  if (key.startsWith('vps:')) return [key.slice(4)];
  const out: string[] = [];
  for (const [v, o] of vpsOrg) if (o === key) out.push(v);
  return out.sort();
}

/** The account's VPSes that could actually carry the RPC right now. */
function eligibleVpses(key: string): string[] {
  const out: string[] = [];
  for (const vpsId of vpsesForAccount(key)) {
    try {
      const [row] = db.select({ loggedIn: vpsTable.claudeLoggedIn })
        .from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
      if (!row || row.loggedIn !== 1) continue;
    } catch { continue; }
    try {
      if (getAgentClientForVpsId(vpsId).status !== 'connected') continue;
    } catch { continue; }
    out.push(vpsId);
  }
  return out;
}

/** Fan one account's snapshot to every VPS on it — the SSE event is keyed by
 *  vpsId, so each tab updates whichever VPS its selected session lives on. */
function fanOut(key: string, usage: AccountUsage): void {
  for (const vpsId of vpsesForAccount(key)) {
    try { emitGlobalAccountUsage(vpsId, usage); } catch { /* bus is best-effort */ }
  }
}

/** Learn which account a VPS belongs to and fold its private bucket into the
 *  shared one. Returns the state the fresh snapshot belongs in. */
function adoptOrg(vpsId: string, orgId: string | null | undefined, from: AccountState, fromKey: string): AccountState {
  if (!orgId || fromKey === orgId) return from;
  vpsOrg.set(vpsId, orgId);
  const dst = accountState(orgId);
  // Carry the pacing forward so the merge can't hand out a free extra call.
  dst.lastPollAt = Math.max(dst.lastPollAt, from.lastPollAt);
  dst.hardRetryAt = Math.max(dst.hardRetryAt, from.hardRetryAt);
  if (fromKey.startsWith('vps:')) accounts.delete(fromKey);
  return dst;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function normalizeWindow(w: any): AccountUsageWindow | null {
  if (!w || typeof w !== 'object') return null;
  return { utilization: numOrNull(w.utilization), resetsAt: strOrNull(w.resets_at) };
}

/** Map the raw `get_usage` envelope → the client-facing AccountUsage. */
function normalize(raw: AgentUsageResult): AccountUsage {
  const fetchedAt = Date.now();
  if (!raw || !raw.ok) {
    return {
      ok: false,
      fetchedAt,
      error: (raw && (raw as any).error) || 'unknown',
      statusCode: (raw && (raw as any).status_code) ?? null,
    };
  }
  const u = (raw.usage && typeof raw.usage === 'object') ? raw.usage : {};
  const limits: AccountUsageLimit[] | null = Array.isArray(u.limits)
    ? u.limits.map((l: any): AccountUsageLimit => ({
        kind: String(l?.kind ?? ''),
        group: l?.group ?? null,
        percent: numOrNull(l?.percent) ?? 0,
        severity: String(l?.severity ?? 'normal'),
        resetsAt: strOrNull(l?.resets_at),
        scopeModel: l?.scope?.model?.display_name ?? null,
        isActive: Boolean(l?.is_active),
      }))
    : null;
  const eu = (u.extra_usage && typeof u.extra_usage === 'object') ? u.extra_usage : null;
  return {
    ok: true,
    fetchedAt,
    subscriptionType: raw.subscription_type ?? null,
    orgId: raw.org_id ?? null,
    degraded: null,
    fiveHour: normalizeWindow(u.five_hour),
    sevenDay: normalizeWindow(u.seven_day),
    limits,
    extraUsage: eu ? { isEnabled: Boolean(eu.is_enabled), utilization: numOrNull(eu.utilization) } : null,
  };
}

/**
 * Refresh the account-usage gauges for the ACCOUNT that `vpsId` belongs to.
 *
 * Gating, in order (all of it per-ACCOUNT, not per-VPS — see the header):
 *   inflight → Retry-After wall → 2-min floor → soft backoff → steady cadence.
 * `force` (the ↻ button, a session switch) skips the soft backoff and the
 * steady cadence, but NEVER the 2-min floor or a server-dictated Retry-After:
 * retrying inside the server's own wall is guaranteed to 429 again, and each
 * such attempt used to re-cache the error as the widget's state.
 *
 * `steady` marks the background tick, which additionally waits out
 * ACCOUNT_STEADY_MS. Returns the fresh (or cached) snapshot, or null.
 */
export function pollUsageForVps(vpsId: string, opts?: { force?: boolean; steady?: boolean }): Promise<AccountUsage | null> {
  const key = accountKeyFor(vpsId);
  const st = accountState(key);
  const force = opts?.force ?? false;
  const now = Date.now();

  if (st.inflight) {
    // A run is pending. If it's still queued far out on the global slot, don't
    // make this caller (e.g. the GET route) hang on the queue — serve the cache;
    // the fresh result lands via the `account_usage` SSE when the run completes.
    if (st.slotReadyAt - now > 3_000) return Promise.resolve(st.last);
    return st.inflight;
  }
  if (now < st.hardRetryAt) return Promise.resolve(st.last);
  if (now - st.lastPollAt < ACCOUNT_MIN_GAP_MS) return Promise.resolve(st.last);
  if (!force && now < st.softRetryAt) return Promise.resolve(st.last);
  if (opts?.steady && now - st.lastPollAt < ACCOUNT_STEADY_MS) return Promise.resolve(st.last);

  // Rotate the RPC over the account's eligible VPSes: the throttle is keyed on
  // the SOURCE IP, so spreading the calls buys the account N times the budget.
  const candidates = eligibleVpses(key);
  if (!candidates.length) return Promise.resolve(st.last);
  const target = candidates[st.rotate++ % candidates.length];

  const wait = reserveGlobalSlot();
  st.slotReadyAt = Date.now() + wait;

  const run = (async (): Promise<AccountUsage | null> => {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let client;
    try { client = getAgentClientForVpsId(target); } catch { return st.last; }
    if (client.status !== 'connected') return st.last; // dropped while queued
    st.lastPollAt = Date.now();
    let raw: AgentUsageResult;
    try {
      raw = await client.call<AgentUsageResult>('get_usage');
    } catch {
      // RPC timeout / disconnect — a transport failure, not an endpoint
      // verdict: don't burn a backoff over it.
      return st.last;
    }
    const usage = normalize(raw);

    if (!usage.ok) {
      st.failStreak = Math.min(st.failStreak + 1, SOFT_BACKOFF_MS.length);
      const retryAfter = (raw && !raw.ok) ? raw.retry_after : undefined;
      if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
        // The exact wall the server gave us (+1s of slack for clock skew).
        st.hardRetryAt = Date.now() + Math.min(retryAfter * 1000, MAX_HARD_BACKOFF_MS) + 1_000;
      } else if (usage.statusCode === 429) {
        // Agent < 0.22.0, or the short burst bucket (which answers
        // `Retry-After: 0` — no information) → escalating guess.
        st.softRetryAt = Date.now() + SOFT_BACKOFF_MS[st.failStreak - 1];
      } else {
        st.softRetryAt = Date.now() + ACCOUNT_MIN_GAP_MS;
      }
      // Never blank working gauges over a transient failure: keep the last good
      // snapshot and just mark it stale, so the widget shows real numbers with
      // an age instead of an error. Only cache the failure itself when there is
      // nothing better to show.
      if (st.last?.ok) {
        st.last = {
          ...st.last,
          degraded: {
            reason: usage.error ?? 'unknown',
            statusCode: usage.statusCode ?? null,
            retryAt: st.hardRetryAt || st.softRetryAt || null,
          },
        };
      } else {
        st.last = usage;
      }
      fanOut(key, st.last);
      return st.last;
    }

    st.failStreak = 0;
    st.hardRetryAt = 0;
    st.softRetryAt = 0;
    // First success for this VPS teaches us its account; its private bucket is
    // folded into the shared one and every sibling VPS is served from here on.
    const dst = adoptOrg(target, usage.orgId, st, key);
    dst.last = usage;
    dst.lastPollAt = Date.now();
    dst.failStreak = 0;
    dst.hardRetryAt = 0;
    dst.softRetryAt = 0;
    const dstKey = usage.orgId ?? key;
    fanOut(dstKey, usage);
    persistSnapshots();
    return usage;
  })();

  st.inflight = run.finally(() => { st.inflight = null; });
  // Same no-hang rule for the caller that created a long-queued run.
  if (wait > 3_000) return Promise.resolve(st.last);
  return st.inflight;
}

/**
 * Ensure a steady poll loop for a VPS. Idempotent per vpsId (a single interval
 * regardless of how many times the agent reconnects). Called from
 * armAgentClientHooks on every `connected` transition. The tick is cheap and
 * frequent but the ACCOUNT gating decides whether it actually calls out, so N
 * VPSes on one account still produce one poll per ACCOUNT_STEADY_MS between
 * them — not N.
 */
export function armUsageWatch(vpsId: string): void {
  loadPersisted();
  void pollUsageForVps(vpsId, { steady: true });
  if (timers.has(vpsId)) return;
  const t = setInterval(() => { void pollUsageForVps(vpsId, { steady: true }); }, TICK_MS);
  // Don't keep the event loop alive just for the poll (Node).
  (t as any).unref?.();
  timers.set(vpsId, t);
}

/** Latest cached snapshot for the GET hydration route (may be null/stale). */
export function getUsageSnapshot(vpsId: string): AccountUsage | null {
  return accounts.get(accountKeyFor(vpsId))?.last ?? null;
}

export function usageSnapshotAge(vpsId: string): number {
  const at = accounts.get(accountKeyFor(vpsId))?.last?.fetchedAt ?? 0;
  return at ? Date.now() - at : Infinity;
}

/**
 * Opportunistic refresh a beat after a turn finishes (the quota just moved).
 * Debounced per ACCOUNT so a burst of stops across sibling sessions/VPSes
 * coalesces into one poll. Wired into sessionOps' `stop` handler via
 * setUsagePollTrigger (injection avoids an import cycle).
 */
export function triggerUsagePoll(vpsId: string): void {
  const key = accountKeyFor(vpsId);
  if (stopDebounce.has(key)) return;
  const t = setTimeout(() => {
    stopDebounce.delete(key);
    void pollUsageForVps(vpsId, {});
  }, 5_000);
  (t as any).unref?.();
  stopDebounce.set(key, t);
}

// Wire the post-stop trigger into sessionOps (one-directional: sessionOps owns
// the bus + the stop handler, this module owns the poll). Runs at import time;
// autoConnect imports armUsageWatch, so this module is loaded at boot.
setUsagePollTrigger(triggerUsagePoll);

// ── Codex account-usage poller (the Codex `/usage` gauges) — §14.58 ──────────
//
// Parallel to the Claude poller above, for VPSes that run Codex. Source: the
// agent's `get_codex_usage` RPC (app-server rate-limit utilization). Emits the
// SAME `account_usage` synthetic event (sessionId = vpsId) but with
// provider='codex' set — the client's UsageMeter routes by provider (a VPS can
// have BOTH gauges). Snapshots are stored in a separate per-VPS map so the GET
// hydration route can return {usage (claude), codexUsage (codex)}. Best-effort;
// never throws. Login-state discovery is a side effect (vps.codexLoggedIn).

const cg = globalThis as unknown as { _codexUsageWatch?: Map<string, VpsUsageState> };
if (!cg._codexUsageWatch) cg._codexUsageWatch = new Map();
const codexStates: Map<string, VpsUsageState> = cg._codexUsageWatch;

function codexStateFor(vpsId: string): VpsUsageState {
  let st = codexStates.get(vpsId);
  if (!st) {
    // slotReadyAt unused here: the Codex poll hits the agent's LOCAL app-server,
    // not Anthropic's per-account endpoint — no global slot needed.
    st = { timer: null, last: null, lastPollAt: 0, inflight: null, slotReadyAt: 0, backoffUntil: 0, stopDebounce: null };
    codexStates.set(vpsId, st);
  }
  return st;
}

/** Normalize one Codex rate-limit window → AccountUsageWindow. resets_at is
 *  unix SECONDS from the agent → ISO string. */
function normalizeCodexWindow(w: CodexRateWindow | null | undefined): AccountUsageWindow | null {
  if (!w) return null;
  const utilization = numOrNull(w.used_percent);
  const resetsAt = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
    ? new Date(w.resets_at * 1000).toISOString()
    : null;
  if (utilization === null && resetsAt === null) return null;
  return { utilization, resetsAt };
}

/** Map the raw `get_codex_usage` envelope → the client-facing AccountUsage
 *  (provider='codex'). Codex exposes rate-limit windows only — no per-model
 *  `limits[]` / `extra_usage` like Anthropic's endpoint. */
function normalizeCodex(raw: AgentCodexUsageResult): AccountUsage {
  const fetchedAt = Date.now();
  if (!raw || !raw.ok) {
    return {
      ok: false,
      provider: 'codex',
      fetchedAt,
      error: (raw && (raw as { error?: string }).error) || 'unknown',
      statusCode: null,
    };
  }
  return {
    ok: true,
    provider: 'codex',
    fetchedAt,
    subscriptionType: raw.plan_type ?? null,
    fiveHour: normalizeCodexWindow(raw.five_hour),
    sevenDay: normalizeCodexWindow(raw.seven_day),
    limits: null,
    extraUsage: null,
  };
}

function pushField(obj: Record<string, unknown>, snake: string, camel: string): unknown {
  return obj[snake] ?? obj[camel];
}

/** Normalize one AccountRateLimitsUpdated payload from the app-server FIFO.
 * Generated SDK models currently dump snake_case; accepting camelCase too
 * keeps this path tolerant of a future alias/default change. */
function pushedCodexWindow(value: unknown): CodexRateWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const w = value as Record<string, unknown>;
  const used = numOrNull(pushField(w, 'used_percent', 'usedPercent'));
  const resets = numOrNull(pushField(w, 'resets_at', 'resetsAt'));
  const minutes = numOrNull(pushField(w, 'window_duration_mins', 'windowDurationMins'))
    ?? numOrNull(pushField(w, 'window_minutes', 'windowMinutes'));
  if (used === null && resets === null) return null;
  return { used_percent: used, resets_at: resets, window_minutes: minutes };
}

/** Consume a pushed rate-limit snapshot without another RPC. Polling remains
 * the cold-start/offline fallback; a running Codex thread now updates gauges
 * immediately when app-server announces a change. */
export function ingestCodexUsagePush(vpsId: string, detail: unknown): AccountUsage | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const d = detail as Record<string, unknown>;
  const windows = [pushedCodexWindow(d.primary), pushedCodexWindow(d.secondary)]
    .filter((w): w is CodexRateWindow => w !== null);
  if (windows.length === 0) return null;
  let fiveHour: CodexRateWindow | null = null;
  let sevenDay: CodexRateWindow | null = null;
  for (const w of windows) {
    if (w.window_minutes != null && w.window_minutes <= 360) fiveHour = w;
    else sevenDay = w;
  }
  const raw: AgentCodexUsageResult = {
    ok: true,
    provider: 'codex',
    plan_type: strOrNull(pushField(d, 'plan_type', 'planType')),
    five_hour: fiveHour,
    seven_day: sevenDay,
    windows,
    fetched_at: Date.now() / 1000,
  };
  const usage = normalizeCodex(raw);
  const st = codexStateFor(vpsId);
  st.last = usage;
  st.lastPollAt = Date.now();
  try { emitGlobalAccountUsage(vpsId, usage); } catch {}
  return usage;
}

/** Best-effort classification of a codex-usage failure as an auth problem
 *  (→ mark vps.codexLoggedIn=0). The agent returns a free-form
 *  "ExcType: message" string, so we keyword-match. A non-auth failure
 *  (transient app-server error) leaves the login flag untouched. */
function looksLikeCodexAuthFailure(err: string | null | undefined): boolean {
  if (!err) return false;
  return /auth|credential|login|logged|token|unauthor|401|no account|sign[\s-]?in/i.test(err);
}

function setCodexLoggedIn(vpsId: string, val: 0 | 1, current: number | null): void {
  if (current === val) return; // no churn
  try {
    db.update(vpsTable)
      .set({ codexLoggedIn: val, codexLoggedInCheckedAt: Math.floor(Date.now() / 1000) })
      .where(eq(vpsTable.id, vpsId)).run();
  } catch {}
}

/**
 * Poll one VPS's Codex account usage. Gated on: connected agent + the agent's
 * LIVE hello reporting codex_available (avoids a first-connect DB-write ordering
 * race — hello is set before the DB persist) + MIN_GAP + 429 backoff. When not
 * forced, also skips VPSes we've confirmed are NOT logged into Codex
 * (codexLoggedIn===0) so we don't hammer the app-server. Caches + broadcasts on
 * success. Discovers/persists the login state as a side effect. Returns the
 * fresh (or cached) snapshot, or null when it couldn't/shouldn't poll.
 */
export function pollCodexUsageForVps(vpsId: string, opts?: { force?: boolean }): Promise<AccountUsage | null> {
  const st = codexStateFor(vpsId);
  const force = opts?.force ?? false;
  const now = Date.now();
  if (st.inflight) return st.inflight;
  if (!force) {
    if (now - st.lastPollAt < MIN_GAP_MS) return Promise.resolve(st.last);
    if (now < st.backoffUntil) return Promise.resolve(st.last);
  }

  const run = (async (): Promise<AccountUsage | null> => {
    let client;
    try { client = getAgentClientForVpsId(vpsId); } catch { return st.last; }
    if (client.status !== 'connected') return st.last;
    // Live availability from hello (set before the DB persist → no first-connect
    // race). Old agents (< 0.15.0) omit codex_available → falsy → skip.
    if (!client.hello?.codex_available) return st.last;

    // Read the current login flag: skip the steady poll once we've confirmed
    // NOT logged in (a forced poll — connect / GET route — still re-checks).
    let loggedIn: number | null = null;
    try {
      const [row] = db.select({ loggedIn: vpsTable.codexLoggedIn })
        .from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
      loggedIn = row?.loggedIn ?? null;
    } catch { loggedIn = null; }
    if (!force && loggedIn === 0) return st.last;

    st.lastPollAt = Date.now();
    let raw: AgentCodexUsageResult;
    try {
      raw = await client.call<AgentCodexUsageResult>('get_codex_usage');
    } catch {
      return st.last; // RPC timeout / disconnect / method-not-found → keep last
    }
    const usage = normalizeCodex(raw);
    // Login-state side effect: ok ⇒ logged in; a clear auth failure ⇒ not.
    if (raw?.ok) {
      setCodexLoggedIn(vpsId, 1, loggedIn);
    } else if (looksLikeCodexAuthFailure((raw as { error?: string })?.error)) {
      setCodexLoggedIn(vpsId, 0, loggedIn);
    }
    st.last = usage;
    try { emitGlobalAccountUsage(vpsId, usage); } catch {}
    return usage;
  })();

  st.inflight = run.finally(() => { st.inflight = null; });
  return st.inflight;
}

/**
 * Ensure a steady Codex-usage poll loop for a VPS. Idempotent per vpsId. Called
 * from armAgentClientHooks on `connected` for Codex-capable VPSes: immediate
 * forced poll (fresh gauges + login discovery) + install the interval once.
 */
export function armCodexUsageWatch(vpsId: string): void {
  const st = codexStateFor(vpsId);
  void pollCodexUsageForVps(vpsId, { force: true });
  if (st.timer) return;
  st.timer = setInterval(() => { void pollCodexUsageForVps(vpsId, {}); }, POLL_INTERVAL_MS);
  (st.timer as any).unref?.();
}

/** Latest cached Codex snapshot for the GET hydration route (may be null/stale). */
export function getCodexUsageSnapshot(vpsId: string): AccountUsage | null {
  return codexStates.get(vpsId)?.last ?? null;
}

export function codexUsageSnapshotAge(vpsId: string): number {
  const at = codexStates.get(vpsId)?.last?.fetchedAt ?? 0;
  return at ? Date.now() - at : Infinity;
}

/** Opportunistic Codex-usage refresh a beat after a Codex turn finishes.
 *  Debounced; respects MIN_GAP. Wired into sessionOps' `stop` handler (only
 *  fired for kind==='codex' sessions) via setCodexUsagePollTrigger. */
export function triggerCodexUsagePoll(vpsId: string): void {
  const st = codexStateFor(vpsId);
  if (st.stopDebounce) return;
  st.stopDebounce = setTimeout(() => {
    st.stopDebounce = null;
    void pollCodexUsageForVps(vpsId, {});
  }, 2500);
  (st.stopDebounce as any).unref?.();
}

setCodexUsagePollTrigger(triggerCodexUsagePoll);
setCodexUsagePushHandler(ingestCodexUsagePush);
setUsageResetResolver((vpsId, kind) => {
  const snapshot = kind === 'codex' ? getCodexUsageSnapshot(vpsId) : getUsageSnapshot(vpsId);
  if (!snapshot?.ok) return null;
  const exhausted: number[] = [];
  const future: number[] = [];
  const add = (percent: number | null | undefined, reset: string | null | undefined) => {
    const at = reset ? Date.parse(reset) : NaN;
    if (!Number.isFinite(at) || at < Date.now() - 60_000) return;
    (percent != null && percent >= 100 ? exhausted : future).push(at);
  };
  add(snapshot.fiveHour?.utilization, snapshot.fiveHour?.resetsAt);
  add(snapshot.sevenDay?.utilization, snapshot.sevenDay?.resetsAt);
  for (const limit of snapshot.limits ?? []) add(limit.percent, limit.resetsAt);
  return exhausted.length ? Math.max(...exhausted) : future.length ? Math.min(...future) : null;
});
