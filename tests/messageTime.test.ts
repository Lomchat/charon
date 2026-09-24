import { describe, it, expect } from 'vitest';
import { formatMessageTime } from '../app/messageTime';

// Built from LOCAL fields, like the formatter reads them, so the suite passes
// in any TZ.
const sec = (...a: [number, number, number, number, number, number]) => new Date(...a).getTime() / 1000;
const today = new Date(2026, 8, 24).getTime();

describe('formatMessageTime', () => {
  it('says Today for any moment of the reference day', () => {
    expect(formatMessageTime(sec(2026, 8, 24, 14, 32, 5), today)).toBe('Today - 14:32:05');
    expect(formatMessageTime(sec(2026, 8, 24, 23, 59, 59), today)).toBe('Today - 23:59:59');
  });

  it('prints midnight as 00, never 24', () => {
    expect(formatMessageTime(sec(2026, 8, 24, 0, 5, 7), today)).toBe('Today - 00:05:07');
  });

  it('dates any other day of this year as dd/mm', () => {
    expect(formatMessageTime(sec(2026, 8, 23, 23, 59, 59), today)).toBe('23/09 - 23:59:59');
    expect(formatMessageTime(sec(2026, 0, 2, 8, 0, 0), today)).toBe('02/01 - 08:00:00');
  });

  it('adds the year once it is not this one', () => {
    expect(formatMessageTime(sec(2025, 11, 31, 18, 4, 0), today)).toBe('31/12/2025 - 18:04:00');
  });

  it('follows the reference day, not the clock', () => {
    const tomorrow = new Date(2026, 8, 25).getTime();
    expect(formatMessageTime(sec(2026, 8, 24, 14, 32, 5), tomorrow)).toBe('24/09 - 14:32:05');
  });
});
