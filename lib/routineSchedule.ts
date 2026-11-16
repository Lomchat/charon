// A routine's weekly schedule (CLAUDE.md §14.120): weekdays + a wall-clock
// time in an IANA zone. Pure, shared by the hub's scheduler and the modal.

export type RoutineSchedule = {
  /** Weekdays, 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** 'HH:MM', 24 h. */
  time: string;
  timezone: string;
};

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAY_PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function isValidSchedule(s: Partial<RoutineSchedule> | null | undefined): s is RoutineSchedule {
  return !!s && Array.isArray(s.days) && s.days.length > 0
    && s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    && typeof s.time === 'string' && TIME_RE.test(s.time) && isValidTimezone(s.timezone);
}

type Parts = { y: number; m: number; d: number; h: number; min: number; s: number };

function partsIn(ms: number, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(ms)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour, min: out.minute, s: out.second };
}

/** tz's offset from UTC at instant `ms`, in ms (Paris in winter: +3600000). */
function offsetAt(ms: number, tz: string): number {
  const p = partsIn(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant a local wall-clock time names in `tz` (a time skipped by a
 *  spring-forward lands just after the gap). */
function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = offsetAt(guess, tz);
  const t = guess - first;
  const second = offsetAt(t, tz);
  return second === first ? t : guess - second;
}

/** The first run strictly after `afterMs`, or null for an invalid schedule. */
export function nextRunAt(s: RoutineSchedule, afterMs: number): number | null {
  if (!isValidSchedule(s)) return null;
  const [hh, mm] = s.time.split(':').map(Number);
  const today = partsIn(afterMs, s.timezone);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    if (!s.days.includes(day.getUTCDay())) continue;
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, s.timezone);
    if (at > afterMs) return at;
  }
  return null;
}

/** "Sundays · 09:00", "Mon, Wed, Fri · 09:00", "Every day · 09:00". */
export function describeSchedule(s: Pick<RoutineSchedule, 'days' | 'time'>): string {
  const days = [...new Set(s.days)].sort((a, b) => a - b);
  const when = days.length === 7 ? 'Every day'
    : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)) ? 'Weekdays'
      : days.length === 1 ? WEEKDAY_PLURAL[days[0]]
        : days.map((d) => WEEKDAYS[d]).join(', ');
  return `${when} · ${s.time}`;
}
