import 'server-only';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { getAgentClientForVpsId } from './AgentClientPool';
import { emitGlobalAccountUsage, setUsagePollTrigger, setCodexUsagePollTrigger } from './sessionOps';
import type { AgentUsageResult, AgentCodexUsageResult, CodexRateWindow } from './types';
import type { AccountUsage, AccountUsageWindow, AccountUsageLimit } from '@/lib/server/claude/types';

// ── Account usage poller (the `/usage` gauges) — CLAUDE.md §14.58 ────────────
//
// Usage is ACCOUNT-scoped, not session-scoped: it's the Claude Pro/Max quota of
// the OAuth account a VPS is logged into (`claude login`), read from
// api.anthropic.com/api/oauth/usage via the agent's `get_usage` RPC. The stream
// `RateLimitEvent` gives status/reset but NOT the utilization %, so the endpoint
// poll is the source of the gauges.
//
// Cadence: one steady interval per VPS (POLL_INTERVAL_MS) + an opportunistic
// refresh right after each turn's `stop` (usagePollTrigger). The endpoint is
// itself rate-limited (429s if hammered), so MIN_GAP_MS floors the cadence and a
// 429 arms a cool-down. Snapshots are cached in-memory (globalThis) — a Charon
// restart re-populates within one interval (immediate poll on agent connect).

const POLL_INTERVAL_MS = 90_000;      // steady cadence (utilization moves slowly)
const MIN_GAP_MS = 8_000;             // never poll faster than this (endpoint 429s)
const BACKOFF_429_MS = 5 * 60_000;    // cool-down after the endpoint rate-limits us
export const USAGE_STALE_MS = 45_000; // GET route forces a refresh past this age

// Hub-GLOBAL floor between ANY two /api/oauth/usage calls, across ALL VPSes.
// The endpoint budget is per ACCOUNT and same-account VPSes poll it
// independently: a Charon restart used to fire every VPS's on-connect poll in
// one burst → the account got throttled and the busiest VPS (chalco: extra
// post-`stop` polls) ate persistent 429s while the others slid under. Every
// call — forced or not — reserves a serialized slot ≥ this gap apart. §14.58.
const GLOBAL_SLOT_GAP_MS = 15_000;
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

const g = globalThis as unknown as { _usageWatch?: Map<string, VpsUsageState> };
if (!g._usageWatch) g._usageWatch = new Map();
const states: Map<string, VpsUsageState> = g._usageWatch;

function stateFor(vpsId: string): VpsUsageState {
  let st = states.get(vpsId);
  if (!st) {
    st = { timer: null, last: null, lastPollAt: 0, inflight: null, slotReadyAt: 0, backoffUntil: 0, stopDebounce: null };
    states.set(vpsId, st);
  }
  return st;
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
    fiveHour: normalizeWindow(u.five_hour),
    sevenDay: normalizeWindow(u.seven_day),
    limits,
    extraUsage: eu ? { isEnabled: Boolean(eu.is_enabled), utilization: numOrNull(eu.utilization) } : null,
  };
}

/**
 * Poll one VPS's account usage. Gated on: connected agent + claudeLoggedIn +
 * MIN_GAP + 429 backoff (unless force). Caches + broadcasts on success. Returns
 * the fresh (or cached) snapshot, or null when it couldn't/shouldn't poll.
 */
export function pollUsageForVps(vpsId: string, opts?: { force?: boolean }): Promise<AccountUsage | null> {
  const st = stateFor(vpsId);
  const force = opts?.force ?? false;
  const now = Date.now();
  if (st.inflight) {
    // A run is pending. If it's still queued far out on the global slot, don't
    // make this caller (e.g. the GET route) hang on the queue — serve the cache;
    // the fresh result lands via the `account_usage` SSE when the run completes.
    if (st.slotReadyAt - now > 3_000) return Promise.resolve(st.last);
    return st.inflight;
  }
  if (!force) {
    if (now - st.lastPollAt < MIN_GAP_MS) return Promise.resolve(st.last);
    if (now < st.backoffUntil) return Promise.resolve(st.last);
  }

  // Cheap sync gates BEFORE reserving a global slot (a skipped VPS must not
  // burn a slot): must be logged in (else no creds → no usage) and connected.
  try {
    const [row] = db.select({ loggedIn: vpsTable.claudeLoggedIn })
      .from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
    if (!row || row.loggedIn !== 1) return Promise.resolve(st.last);
  } catch { return Promise.resolve(st.last); }
  let client;
  try { client = getAgentClientForVpsId(vpsId); } catch { return Promise.resolve(st.last); }
  if (client.status !== 'connected') return Promise.resolve(st.last);

  // Hub-global pacing (see GLOBAL_SLOT_GAP_MS): forced polls too — force skips
  // the per-VPS gaps, never the account-level floor.
  const wait = reserveGlobalSlot();
  st.slotReadyAt = Date.now() + wait;

  const run = (async (): Promise<AccountUsage | null> => {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (client.status !== 'connected') return st.last; // dropped while queued
    st.lastPollAt = Date.now();
    let raw: AgentUsageResult;
    try {
      raw = await client.call<AgentUsageResult>('get_usage');
    } catch {
      return st.last; // RPC timeout / disconnect → keep the last snapshot
    }
    const usage = normalize(raw);
    if (!usage.ok) {
      if (usage.statusCode === 429) st.backoffUntil = Date.now() + BACKOFF_429_MS;
      // Never clobber good gauges with a transient failure: keep serving (and
      // showing) the last ok snapshot. Only cache/emit the failure when there's
      // nothing better, so the UI can explain (throttled / token expired)
      // instead of going blank. This is what blanked chalco: a restart-burst
      // 429 overwrote its snapshot while the other VPSes kept theirs.
      if (st.last?.ok) return st.last;
    }
    st.last = usage;
    try { emitGlobalAccountUsage(vpsId, usage); } catch {}
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
 * armAgentClientHooks on every `connected` transition: does an immediate forced
 * poll (fresh gauges on connect) and installs the interval once.
 */
export function armUsageWatch(vpsId: string): void {
  const st = stateFor(vpsId);
  // Non-forced on purpose: a fresh state polls immediately anyway (no gaps
  // armed), and it flows through the hub-global slot so a restart's N
  // simultaneous on-connect polls self-stagger instead of bursting the
  // account's endpoint budget (the chalco-429 incident, §14.58).
  void pollUsageForVps(vpsId, {});
  if (st.timer) return;
  st.timer = setInterval(() => { void pollUsageForVps(vpsId, {}); }, POLL_INTERVAL_MS);
  // Don't keep the event loop alive just for the poll (Node).
  (st.timer as any).unref?.();
}

/** Latest cached snapshot for the GET hydration route (may be null/stale). */
export function getUsageSnapshot(vpsId: string): AccountUsage | null {
  return states.get(vpsId)?.last ?? null;
}

export function usageSnapshotAge(vpsId: string): number {
  const at = states.get(vpsId)?.last?.fetchedAt ?? 0;
  return at ? Date.now() - at : Infinity;
}

/**
 * Opportunistic refresh a beat after a turn finishes (the quota just moved).
 * Debounced so a burst of stops coalesces into one poll; respects MIN_GAP so it
 * never stacks on top of the steady interval. Wired into sessionOps' `stop`
 * handler via setUsagePollTrigger (injection avoids an import cycle).
 */
export function triggerUsagePoll(vpsId: string): void {
  const st = stateFor(vpsId);
  if (st.stopDebounce) return;
  st.stopDebounce = setTimeout(() => {
    st.stopDebounce = null;
    void pollUsageForVps(vpsId, {});
  }, 2500);
  (st.stopDebounce as any).unref?.();
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
