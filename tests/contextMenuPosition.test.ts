import { describe, expect, it } from 'vitest';
import { positionContextMenu } from '../app/contextMenuPosition';

describe('positionContextMenu', () => {
  it('keeps the click anchor when the measured menu fits', () => {
    expect(positionContextMenu(100, 80, 200, 240, 1000, 800))
      .toEqual({ left: 100, top: 80 });
  });

  it('opens upward when the real height would cross the bottom edge', () => {
    expect(positionContextMenu(100, 700, 200, 260, 1000, 800))
      .toEqual({ left: 100, top: 440 });
  });

  it('clamps to the top margin when the menu fits neither side of the click', () => {
    expect(positionContextMenu(100, 120, 200, 700, 1000, 720))
      .toEqual({ left: 100, top: 8 });
  });

  it('stays inside the right and left viewport edges', () => {
    expect(positionContextMenu(950, 80, 200, 240, 1000, 800).left).toBe(792);
    expect(positionContextMenu(-20, 80, 200, 240, 1000, 800).left).toBe(8);
  });

  it('pins oversized boxes to the viewport margin', () => {
    expect(positionContextMenu(40, 40, 500, 500, 320, 240))
      .toEqual({ left: 8, top: 8 });
  });
});
