// Banked limit resets and the reset calendar, as data (§14.126). Pure: the
// usage popover's button, the resets modal and the header calendar draw it.
import type { AccountResetGrant, AccountUsage } from '@/lib/server/hub/types';
import type { ProviderAccount } from '@/lib/providerAccounts';
import { nextRunAt, type RoutineSchedule } from '@/lib/routineSchedule';

const DAY_MS = 86_400_000;

/** The calendar's account colours, in account order: semantic tokens only
 *  (themes.css), never the "needs you" orange nor the destructive red. */
export const ACCOUNT_TONES = ['--accent', '--violet', '--success', '--warning', '--info', '--lavender'] as const;
export function accountTone(index: number): string {
  return `var(${ACCOUNT_TONES[index % ACCOUNT_TONES.length]})`;
}

/** Short who: the name the user gave, else the login. */
export function accountShortName(a: Pick<ProviderAccount, 'name' | 'email' | 'displayName'>): string {
  return a.name?.trim() || a.email?.trim() || a.displayName?.trim() || '';
}

/** The model-scoped weekly cap's name (Claude `seven_day_overage_included` =
 *  the `weekly_scoped` limit, e.g. Fable). */
function scopedModel(usage: AccountUsage | null): string | null {
  const scoped = (usage?.limits ?? []).filter((l) => l.kind === 'weekly_scoped' && l.scopeModel);
  return scoped.length === 1 ? scoped[0]!.scopeModel! : null;
}

export type ResetWindow = { key: string; label: string; pct: number | null };

/** One window a grant refills: its name and how full it is now. */
function windowOf(key: string, grant: AccountResetGrant | null, usage: AccountUsage | null): ResetWindow {
  const fromGrant = grant?.used?.[key];
  const scoped = (usage?.limits ?? []).find((l) => l.kind === 'weekly_scoped');
  switch (key) {
    case 'five_hour':
      return { key, label: '5h', pct: fromGrant ?? usage?.fiveHour?.utilization ?? null };
    case 'seven_day':
      return { key, label: 'Weekly', pct: fromGrant ?? usage?.sevenDay?.utilization ?? null };
    case 'seven_day_overage_included':
      return { key, label: scopedModel(usage) ?? 'Model', pct: fromGrant ?? scoped?.percent ?? null };
    default: {
      const m = /^seven_day_(.+)$/.exec(key);
      const name = (m?.[1] ?? key).replace(/_/g, ' ');
      return { key, label: name.charAt(0).toUpperCase() + name.slice(1), pct: fromGrant ?? null };
    }
  }
}

/** What a grant refills, as gauges. `all` (Codex) = the account's windows. */
export function grantWindows(grant: AccountResetGrant, usage: AccountUsage | null): ResetWindow[] {
  if (grant.clears.includes('all')) {
    const out: ResetWindow[] = [];
    if (usage?.fiveHour) out.push(windowOf('five_hour', null, usage));
    if (usage?.sevenDay) out.push(windowOf('seven_day', null, usage));
    return out.length ? out : [{ key: 'all', label: 'All limits', pct: null }];
  }
  return grant.clears.map((k) => windowOf(k, grant, usage));
}

const BLOCKED: Record<string, string> = {
  nothing_to_reset: 'nothing to reset',
  needs_limit: 'once at a limit',
  cooldown: 'cooling down',
  paused: 'paused',
  plan: 'not on this plan',
  cannot_clear: 'nothing it can clear',
  blocked_five_hour: '5h limit blocks it',
  blocked_seven_day: 'weekly limit blocks it',
  blocked_opus: 'Opus limit blocks it',
  blocked_sonnet: 'Sonnet limit blocks it',
  blocked_other: 'another limit blocks it',
  unavailable: 'unavailable',
};
export function blockedText(reason: string | null | undefined): string {
  if (!reason) return 'not now';
  return BLOCKED[reason] ?? reason.replace(/_/g, ' ');
}

// ── Dates ────────────────────────────────────────────────────────────────────

let dayFmt: Intl.DateTimeFormat | null = null;
let dayYearFmt: Intl.DateTimeFormat | null = null;
let timeFmt: Intl.DateTimeFormat | null = null;
let monthFmt: Intl.DateTimeFormat | null = null;

/** "Tue 25 Nov" (+ the year when not this one). */
export function fmtDay(at: number, now = Date.now()): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  if (sameYear) return (dayFmt ??= new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })).format(at);
  return (dayYearFmt ??= new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })).format(at);
}
export function fmtTime(at: number): string {
  return (timeFmt ??= new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).format(at);
}
export function fmtMonth(year: number, month: number): string {
  return (monthFmt ??= new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' })).format(new Date(year, month, 1));
}

/** "in 22h" within two days (a day count rounds a whole day away), "in 3d"
 *  beyond, "now" once past. */
export function fmtIn(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms <= 60_000) return 'now';
  const h = ms / 3_600_000;
  if (h < 1) return `in ${Math.round(ms / 60_000)}m`;
  if (h < 48) return `in ${Math.round(h)}h`;
  return `in ${Math.round(ms / DAY_MS)}d`;
}

let shortFmt: Intl.DateTimeFormat | null = null;
/** "25 Nov": a dense row's date. */
export function fmtShortDay(at: number): string {
  return (shortFmt ??= new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })).format(at);
}

/** Local calendar day key: events land on the user's day, not UTC's. */
export function dayKey(at: number | Date): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** A Monday-first month as 6 full weeks (stable height across months). */
export function monthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - lead + i));
}

// ── Calendar events ──────────────────────────────────────────────────────────

export type ResetEvent = {
  accountId: string;
  at: number;
  /** refill = a limit window starts over; expiry = a banked reset ends unused. */
  kind: 'refill' | 'expiry';
  /** refill: the windows ('Weekly', 'Fable'); expiry: the grant's title. */
  what: string[];
  /** expiry: resets lost with it. */
  count?: number;
};

/** An account's dated facts: weekly windows refilling (5h is not a calendar
 *  fact), banked resets expiring. Only what the provider said — no guessed
 *  recurrence: a window restarts on first use after its reset. */
export function accountEvents(accountId: string, usage: AccountUsage | null, now = Date.now()): ResetEvent[] {
  if (!usage?.ok) return [];
  const out: ResetEvent[] = [];
  const refill = (resetsAt: string | null | undefined, label: string) => {
    const at = resetsAt ? Date.parse(resetsAt) : NaN;
    if (!Number.isFinite(at) || at <= now) return;
    // A model cap refilling with the weekly one (Claude's Fable) IS the
    // weekly refill: one moment, one word (the user's call).
    if (out.some((e) => e.kind === 'refill' && Math.abs(e.at - at) < 3_600_000)) return;
    out.push({ accountId, at, kind: 'refill', what: [label] });
  };
  // The account-wide weekly first: it names a shared moment.
  const weekly = (usage.limits ?? []).filter((l) => l.group === 'weekly' || l.kind.startsWith('weekly'))
    .sort((a, b) => Number(b.kind === 'weekly_all') - Number(a.kind === 'weekly_all'));
  if (weekly.length) {
    for (const l of weekly) refill(l.resetsAt, l.kind === 'weekly_all' ? 'Weekly' : l.scopeModel ?? 'Weekly');
  } else {
    refill(usage.sevenDay?.resetsAt, 'Weekly');
  }
  for (const g of usage.resets?.grants ?? []) {
    const at = g.expiresAt ? Date.parse(g.expiresAt) : NaN;
    if (!Number.isFinite(at) || at <= now) continue;
    out.push({ accountId, at, kind: 'expiry', what: [g.title], count: g.left });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** A routine's runs in [from, to] (§14.120): its schedule IS the calendar
 *  fact, so its recurrence is drawn (a paused one draws nothing). */
export function routineRuns(r: RoutineSchedule & { enabled: boolean }, from: number, to: number): number[] {
  if (!r.enabled) return [];
  const out: number[] = [];
  for (let at = nextRunAt(r, from - 1); at != null && at <= to && out.length < 64; at = nextRunAt(r, at)) out.push(at);
  return out;
}

/** A banked reset ends within `days`: the calendar button's dot. */
export function resetExpiresSoon(usage: AccountUsage | null, now = Date.now(), days = 3): boolean {
  return (usage?.resets?.grants ?? []).some((g) => {
    const at = g.expiresAt ? Date.parse(g.expiresAt) : NaN;
    return Number.isFinite(at) && at > now && at - now <= days * DAY_MS;
  });
}
