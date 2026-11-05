import { describe, expect, it } from 'vitest';
import { REVEAL_MARGIN, revealScrollDelta } from '@/app/sidebarReveal';

// The band: y 100 (under the pinned server head) to y 500 (bottom edge).
const band = { bandTop: 100, bandBottom: 500 };

describe('sidebar reveal (Sidebar § reveal)', () => {
  it('does not move for a fully visible row', () => {
    expect(revealScrollDelta({ ...band, rowTop: 100, rowBottom: 140 })).toBe(0);
    expect(revealScrollDelta({ ...band, rowTop: 460, rowBottom: 500 })).toBe(0);
  });

  it('scrolls a row cut by the bottom edge just enough to show it', () => {
    // 20px hidden ⇒ 20px + air, never the ~250px a recentre would move.
    expect(revealScrollDelta({ ...band, rowTop: 480, rowBottom: 520 })).toBe(20 + REVEAL_MARGIN);
  });

  it('scrolls a row half under the pinned head just enough to show it', () => {
    expect(revealScrollDelta({ ...band, rowTop: 80, rowBottom: 120 })).toBe(-20 - REVEAL_MARGIN);
  });

  it('centres a row that is entirely out of sight', () => {
    // Row centre 1020, band centre 300.
    expect(revealScrollDelta({ ...band, rowTop: 1000, rowBottom: 1040 })).toBe(720);
    expect(revealScrollDelta({ ...band, rowTop: -400, rowBottom: -360 })).toBe(-680);
    // Wholly under the pinned head counts as out of sight.
    expect(revealScrollDelta({ ...band, rowTop: 60, rowBottom: 100 })).toBe(-220);
  });

  it('aligns the top of a row taller than the band', () => {
    expect(revealScrollDelta({ ...band, rowTop: 300, rowBottom: 900 })).toBe(200);
  });
});
