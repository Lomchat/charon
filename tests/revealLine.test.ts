import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { revealLine, subscribeReveal } from '@/app/revealLine';

/**
 * The hand-off from a search hit to the editor pane (§14.82).
 *
 * Both delivery paths matter and they are easy to get wrong in opposite
 * directions: dropping the request when the file is not open yet (the common
 * case — you click a result for a file you have never opened), and dropping it
 * when the file IS open (the second-click case — the pane does not remount, so
 * a prop would never change).
 */
describe('revealLine', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('delivers live to an editor that is already mounted', () => {
    const seen: number[] = [];
    const off = subscribeReveal('v1', '/srv/app', 'src/a.ts', (n) => seen.push(n));
    revealLine('v1', '/srv/app', 'src/a.ts', 42);
    expect(seen).toEqual([42]);
    off();
  });

  it('parks the request until the editor mounts, then drains it once', () => {
    revealLine('v1', '/srv/app', 'src/b.ts', 7);
    const seen: number[] = [];
    const off = subscribeReveal('v1', '/srv/app', 'src/b.ts', (n) => seen.push(n));
    // Parked requests arrive after paint — CodeMirror cannot scroll to a line
    // it has not measured yet.
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([7]);
    off();

    // One-shot: reopening the same file must not resurrect the old jump.
    const again: number[] = [];
    const off2 = subscribeReveal('v1', '/srv/app', 'src/b.ts', (n) => again.push(n));
    vi.advanceTimersByTime(10);
    expect(again).toEqual([]);
    off2();
  });

  it('forgets a parked request nobody ever claimed', () => {
    revealLine('v1', '/srv/app', 'src/ghost.ts', 12);
    vi.advanceTimersByTime(31_000);
    const seen: number[] = [];
    const off = subscribeReveal('v1', '/srv/app', 'src/ghost.ts', (n) => seen.push(n));
    vi.advanceTimersByTime(10);
    expect(seen).toEqual([]);
    off();
  });

  it('keys on (vps, root, path) — the same relative path in two projects is two files', () => {
    const a: number[] = [];
    const b: number[] = [];
    const offA = subscribeReveal('v1', '/srv/one', 'index.ts', (n) => a.push(n));
    const offB = subscribeReveal('v1', '/srv/two', 'index.ts', (n) => b.push(n));
    revealLine('v1', '/srv/two', 'index.ts', 3);
    expect(a).toEqual([]);
    expect(b).toEqual([3]);
    offA(); offB();
  });

  it('a torn-down pane stops receiving, and its request parks instead', () => {
    const seen: number[] = [];
    const off = subscribeReveal('v1', '/srv/app', 'src/c.ts', (n) => seen.push(n));
    off();
    revealLine('v1', '/srv/app', 'src/c.ts', 9);
    expect(seen).toEqual([]);
    const next: number[] = [];
    const off2 = subscribeReveal('v1', '/srv/app', 'src/c.ts', (n) => next.push(n));
    vi.advanceTimersByTime(1);
    expect(next).toEqual([9]);
    off2();
  });

  it('a listener that throws does not stop the others', () => {
    const seen: number[] = [];
    const offBad = subscribeReveal('v1', '/srv/app', 'src/d.ts', () => { throw new Error('dead pane'); });
    const offGood = subscribeReveal('v1', '/srv/app', 'src/d.ts', (n) => seen.push(n));
    expect(() => revealLine('v1', '/srv/app', 'src/d.ts', 5)).not.toThrow();
    expect(seen).toEqual([5]);
    offBad(); offGood();
  });
});
