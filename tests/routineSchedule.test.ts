// A routine fires at a wall-clock time in ITS zone (§14.120): across a DST
// change the UTC instant moves, the local time does not.
import { describe, expect, it } from 'vitest';
import { nextRunAt } from '@/lib/routineSchedule';

const sundays9 = { days: [0], time: '09:00', timezone: 'Europe/Paris' };
const at = (iso: string) => Date.parse(iso);

describe('nextRunAt', () => {
  it('finds the next local slot, after a run, across both DST changes', () => {
    expect(nextRunAt(sundays9, at('2026-11-14T12:00:00Z'))).toBe(at('2026-11-15T08:00:00Z'));
    // Just after this Sunday's run: next week, never the same slot again.
    expect(nextRunAt(sundays9, at('2026-11-15T08:00:00Z'))).toBe(at('2026-11-22T08:00:00Z'));
    // Summer time starts 2026-03-29, ends 2026-10-25 (Paris).
    expect(nextRunAt(sundays9, at('2026-03-28T12:00:00Z'))).toBe(at('2026-03-29T07:00:00Z'));
    expect(nextRunAt(sundays9, at('2026-10-24T12:00:00Z'))).toBe(at('2026-10-25T08:00:00Z'));
    // Several days, another zone.
    expect(nextRunAt({ days: [1, 3], time: '23:30', timezone: 'America/New_York' }, at('2026-11-17T12:00:00Z')))
      .toBe(at('2026-11-19T04:30:00Z'));
  });

  it('refuses an invalid schedule', () => {
    expect(nextRunAt({ days: [], time: '09:00', timezone: 'Europe/Paris' }, Date.now())).toBeNull();
    expect(nextRunAt({ days: [0], time: '25:00', timezone: 'Europe/Paris' }, Date.now())).toBeNull();
    expect(nextRunAt({ days: [0], time: '09:00', timezone: 'Mars/Olympus' }, Date.now())).toBeNull();
  });
});
