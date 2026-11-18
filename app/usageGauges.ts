// The account-usage gauges, as data (§14.58/§14.72): which windows a reading
// has, how full, how far through their time, and how to say it. Pure — the
// widgets (UsageMeter.tsx) and the desk's limits panel draw the SAME cells.
import type { AccountUsage } from '@/lib/server/hub/types';

export function sevClass(severity: string | undefined, percent: number | null): string {
  if (severity === 'critical') return 'crit';
  if (severity === 'warning' || severity === 'warn') return 'warn';
  const p = percent ?? 0;
  if (p >= 90) return 'crit';
  if (p >= 70) return 'warn';
  return 'ok';
}

export function fmtReset(resetsAt: string | null | undefined): string {
  if (!resetsAt) return '';
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return '';
  let s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return 'resets now';
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

export function fmtPct(p: number | null | undefined): string {
  if (p == null) return '—';
  return `${Math.round(p)}%`;
}

export const HOUR_MS = 3_600_000;

/** A limit's window length. The payload does not carry it; the kind says it. */
export function windowMsOf(kind: string | null | undefined, group?: string | null): number | null {
  if (kind === 'session' || group === 'session') return 5 * HOUR_MS;
  if (group === 'weekly' || kind?.startsWith('weekly')) return 168 * HOUR_MS;
  return null;
}

/** THE PACE MARK: how far through its window the clock stands (0–1), or null
 *  when that is unknown (no reset time: an idle window). A gauge filled past
 *  it is spending faster than a pace that lasts until the reset. */
export function paceFraction(resetsAt: string | null | undefined, windowMs: number | null, now: number): number | null {
  if (!now || !resetsAt || !windowMs) return null;
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return null;
  const left = t - now;
  if (left <= 0 || left > windowMs) return null;
  return 1 - left / windowMs;
}

/** One headline gauge: a rate-limit window. */
export type UsageCell = {
  k: string;
  /** What the window is, in a sentence. */
  name: string;
  pct: number | null;
  /** The endpoint's own verdict; absent on the plain 5h/7d windows. */
  sev?: string;
  resetsAt: string | null;
  windowMs: number | null;
  /** A model-specific cap. It only ever comes from the POLL, never from a
   *  turn's live `rate_limit`, so it goes stale on its own (§14.72). */
  scoped: boolean;
};

/** Both headline windows and every model-specific cap the endpoint currently
 *  reports (e.g. Fable) — it only returns the relevant scoped limits, so a
 *  truthy scopeModel is enough, no extra filtering. */
export function usageCells(usage: AccountUsage | null): UsageCell[] {
  const scoped = (usage?.limits ?? []).filter((l) => l.scopeModel);
  // A window a COMPLETE reading leaves out does not exist for this account
  // (Codex has no 5-hour window today): no gauge, until a reading carries it
  // again — the next poll or push redraws. A windows-only snapshot (live
  // `rate_limit` events before any poll: fetchedAt 0) is partial and hides
  // nothing; no reading at all keeps both placeholders. An ok reading always
  // has at least one window (usagePoll.ts turns an empty one into an error).
  const complete = !!usage?.ok && usage.fetchedAt > 0;
  return [
    ...(!complete || usage?.fiveHour ? [{ k: '5h', name: '5-hour window', pct: usage?.fiveHour?.utilization ?? null,
      resetsAt: usage?.fiveHour?.resetsAt ?? null, windowMs: 5 * HOUR_MS, scoped: false }] : []),
    ...(!complete || usage?.sevenDay ? [{ k: '7d', name: 'Weekly window (all models)', pct: usage?.sevenDay?.utilization ?? null,
      resetsAt: usage?.sevenDay?.resetsAt ?? null, windowMs: 168 * HOUR_MS, scoped: false }] : []),
    ...scoped.map((l) => ({
      k: l.scopeModel as string, name: `${l.scopeModel} weekly cap`, pct: l.percent, sev: l.severity,
      resetsAt: l.resetsAt ?? null, windowMs: windowMsOf(l.kind, l.group), scoped: true,
    })),
  ];
}
