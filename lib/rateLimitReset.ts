const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2020, 0, 1);

/** Normalize provider reset instants. Both current SDKs use unix seconds. */
export function normalizeResetAtMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const ms = n < 100_000_000_000 ? n * 1000 : n;
  return ms >= MIN_PLAUSIBLE_EPOCH_MS ? Math.round(ms) : null;
}

function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

function wallValue(p: ReturnType<typeof zonedParts>): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Convert an IANA-zone wall time without trusting the hub or browser timezone. */
function zonedWallToEpochMs(wall: ReturnType<typeof zonedParts>, timeZone: string): number | null {
  const wanted = wallValue(wall);
  let candidate = wanted;
  try {
    for (let i = 0; i < 4; i += 1) candidate += wanted - wallValue(zonedParts(candidate, timeZone));
    const actual = zonedParts(candidate, timeZone);
    return Math.abs(wallValue(actual) - wanted) < 1000 ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Legacy fallback for prose such as "resets 4:40pm (Europe/Paris)". Bare
 * local times are deliberately rejected: guessing the hub/browser zone can
 * send too early. Structured epoch/ISO values always win.
 */
export function resetAtFromMessage(message: string, nowMs = Date.now()): number | null {
  const epoch = message.match(/\bresets?(?:\s+at)?\s+(\d{10,13})\b/i)?.[1];
  if (epoch) return normalizeResetAtMs(epoch);

  const iso = message.match(/\b(20\d\d-\d\d-\d\d[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d))\b/i)?.[1];
  if (iso) {
    const parsed = Date.parse(iso.replace(' ', 'T'));
    if (Number.isFinite(parsed)) return parsed;
  }

  const match = message.match(/\bresets?(?:\s+at)?\s+(?<hour>[01]?\d|2[0-3]):(?<minute>[0-5]\d)\s*(?<meridiem>am|pm)?(?:\s+on\s+(?<date>\d{4}-\d{2}-\d{2}))?\s*\((?<zone>[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+|UTC)\)/i)
    ?? message.match(/\bresets?(?:\s+at)?\s+(?<hour>[01]?\d)\s*(?<meridiem>am|pm)(?:\s+on\s+(?<date>\d{4}-\d{2}-\d{2}))?\s*\((?<zone>[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+|UTC)\)/i);
  if (!match) return null;

  let hour = Number(match.groups?.hour);
  const minute = Number(match.groups?.minute ?? 0);
  const meridiem = match.groups?.meridiem?.toLowerCase();
  const timeZone = match.groups?.zone ?? '';
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  }
  try {
    const localNow = zonedParts(nowMs, timeZone);
    let wall = { ...localNow, hour, minute, second: 0 };
    if (match.groups?.date) {
      const [year, month, day] = match.groups.date.split('-').map(Number);
      wall = { year, month, day, hour, minute, second: 0 };
    }
    let instant = zonedWallToEpochMs(wall, timeZone);
    if (instant == null) return null;
    if (!match.groups?.date && instant <= nowMs + 30_000) {
      const nextDayUtc = Date.UTC(wall.year, wall.month - 1, wall.day + 1, hour, minute, 0);
      const d = new Date(nextDayUtc);
      wall = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute, second: 0 };
      instant = zonedWallToEpochMs(wall, timeZone);
    }
    return instant;
  } catch {
    return null;
  }
}

export function resolveResetAtMs(structured: unknown, message = '', nowMs = Date.now()): number | null {
  return normalizeResetAtMs(structured) ?? resetAtFromMessage(message, nowMs);
}
