import { describe, it, expect } from 'vitest';
import { insertRelative } from '@/app/useReorder';

// ── The drag-to-reorder rule (§14.80) ──────────────────────────────────────
//
// Every drop is "put this row before/after that one", decided by the target's
// midpoint. The predecessor inserted at the target's INDEX, which can only
// ever mean "before" — so the tail of every list was unreachable (you could
// put a row second-to-last and no further) and, on a forward drag, the item
// landed one slot past where the indicator had drawn the line.

const L = ['a', 'b', 'c', 'd'];

describe('insertRelative', () => {
  it('reaches the END of the list — the case that was impossible', () => {
    expect(insertRelative(L, 'a', 'd', true)).toEqual(['b', 'c', 'd', 'a']);
    expect(insertRelative(L, 'b', 'd', true)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('reaches the START of the list', () => {
    expect(insertRelative(L, 'd', 'a', false)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('means the same thing dragging forwards and backwards', () => {
    // "before c" is one position, whichever side you came from.
    expect(insertRelative(L, 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd']);
    expect(insertRelative(L, 'd', 'c', false)).toEqual(['a', 'b', 'd', 'c']);
    // and so is "after c" — which, coming from d, is where d already is.
    expect(insertRelative(L, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(insertRelative(L, 'd', 'c', true)).toBeNull();
  });

  it('is null when nothing moves, so no request goes out', () => {
    expect(insertRelative(L, 'a', 'a', false)).toBeNull();
    expect(insertRelative(L, 'a', 'a', true)).toBeNull();
    expect(insertRelative(L, 'a', 'b', false)).toBeNull();   // already there
    expect(insertRelative(L, 'd', 'c', true)).toBeNull();    // already there
    expect(insertRelative(L, 'b', 'a', true)).toBeNull();
  });

  it('is null for ids the list no longer has (a stale drag)', () => {
    expect(insertRelative(L, 'z', 'b', true)).toBeNull();
    expect(insertRelative(L, 'a', 'z', true)).toBeNull();
  });

  it('handles a two-item list at both ends', () => {
    expect(insertRelative(['a', 'b'], 'a', 'b', true)).toEqual(['b', 'a']);
    expect(insertRelative(['a', 'b'], 'b', 'a', false)).toEqual(['b', 'a']);
  });
});
