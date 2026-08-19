import { describe, expect, it } from 'vitest';
import { normalizeResetAtMs, resetAtFromMessage, resolveResetAtMs } from '@/lib/rateLimitReset';

describe('rate-limit reset instants', () => {
  it('normalizes unix seconds and milliseconds to the same UTC instant', () => {
    expect(normalizeResetAtMs(1_800_000_000)).toBe(1_800_000_000_000);
    expect(normalizeResetAtMs('1800000000000')).toBe(1_800_000_000_000);
  });

  it('parses an explicit ISO offset without using the machine timezone', () => {
    expect(resetAtFromMessage('limit; resets at 2026-08-18T16:30:00+02:00'))
      .toBe(Date.parse('2026-08-18T14:30:00Z'));
  });

  it('parses a legacy IANA-zone clock and rolls it to tomorrow when needed', () => {
    const now = Date.parse('2026-08-18T15:00:00Z'); // 17:00 Europe/Paris
    expect(resetAtFromMessage('resets 4:40pm (Europe/Paris)', now))
      .toBe(Date.parse('2026-08-19T14:40:00Z'));
  });

  it('handles a non-European IANA zone across DST', () => {
    const now = Date.parse('2026-03-08T06:00:00Z'); // 01:00 New York, DST day
    expect(resetAtFromMessage('resets 4:00am (America/New_York)', now))
      .toBe(Date.parse('2026-03-08T08:00:00Z'));
  });

  it('honours an explicit calendar date in an IANA zone', () => {
    const now = Date.parse('2026-08-18T10:00:00Z');
    expect(resetAtFromMessage('resets 4:40pm on 2026-08-21 (Europe/Paris)', now))
      .toBe(Date.parse('2026-08-21T14:40:00Z'));
  });

  it('rejects ambiguous bare local times and prefers structured values', () => {
    expect(resetAtFromMessage('resets at 4:40pm')).toBeNull();
    expect(resolveResetAtMs(1_800_000_000, 'resets 4:40pm (Europe/Paris)'))
      .toBe(1_800_000_000_000);
  });
});
