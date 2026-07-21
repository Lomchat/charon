import 'server-only';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { getAgentClientForVpsId } from './AgentClientPool';
import { emitGlobalAccountUsage, setUsagePollTrigger } from './sessionOps';
import type { AgentUsageResult } from './types';
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

const POLL_INTERVAL_MS = 60_000;      // steady cadence (utilization moves slowly)
const MIN_GAP_MS = 8_000;             // never poll faster than this (endpoint 429s)
const BACKOFF_429_MS = 5 * 60_000;    // cool-down after the endpoint rate-limits us
export const USAGE_STALE_MS = 45_000; // GET route forces a refresh past this age

type VpsUsageState = {
  timer: ReturnType<typeof setInterval> | null;
  last: AccountUsage | null;
  lastPollAt: number;
  inflight: Promise<AccountUsage | null> | null;
  backoffUntil: number;
  stopDebounce: ReturnType<typeof setTimeout> | null;
};

const g = globalThis as unknown as { _usageWatch?: Map<string, VpsUsageState> };
if (!g._usageWatch) g._usageWatch = new Map();
const states: Map<string, VpsUsageState> = g._usageWatch;

function stateFor(vpsId: string): VpsUsageState {
  let st = states.get(vpsId);
  if (!st) {
    st = { timer: null, last: null, lastPollAt: 0, inflight: null, backoffUntil: 0, stopDebounce: null };
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
  if (st.inflight) return st.inflight;
  if (!force) {
    if (now - st.lastPollAt < MIN_GAP_MS) return Promise.resolve(st.last);
    if (now < st.backoffUntil) return Promise.resolve(st.last);
  }

  const run = (async (): Promise<AccountUsage | null> => {
    // Gate: must be logged in (else no creds → no usage) and connected.
    try {
      const [row] = db.select({ loggedIn: vpsTable.claudeLoggedIn })
        .from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
      if (!row || row.loggedIn !== 1) return st.last;
    } catch { return st.last; }

    let client;
    try { client = getAgentClientForVpsId(vpsId); } catch { return st.last; }
    if (client.status !== 'connected') return st.last;

    st.lastPollAt = Date.now();
    let raw: AgentUsageResult;
    try {
      raw = await client.call<AgentUsageResult>('get_usage');
    } catch {
      return st.last; // RPC timeout / disconnect → keep the last snapshot
    }
    const usage = normalize(raw);
    if (!usage.ok && usage.statusCode === 429) {
      st.backoffUntil = Date.now() + BACKOFF_429_MS;
    }
    st.last = usage;
    try { emitGlobalAccountUsage(vpsId, usage); } catch {}
    return usage;
  })();

  st.inflight = run.finally(() => { st.inflight = null; });
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
  void pollUsageForVps(vpsId, { force: true });
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
