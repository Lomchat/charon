import { describe, it, expect } from 'vitest';
import { shouldApplyCachedHistory, shouldApplyFetchedHistory } from '@/app/historyRefetch';

// Full history reloads vs a live transcript. The failure these pin: during
// tool-heavy turns the 5s poll reloads almost every tick, and repainting the
// cached (previous-fetch) snapshot over the live view removed the newest tool
// rows and assistant text, which came back a tick later — a rolling flicker.

describe('shouldApplyCachedHistory', () => {
  it('paints the cache on first load, when there is nothing newer to lose', () => {
    expect(shouldApplyCachedHistory(false)).toBe(true);
  });

  it('never repaints a live view with the cache', () => {
    expect(shouldApplyCachedHistory(true)).toBe(false);
  });
});

describe('shouldApplyFetchedHistory', () => {
  it('always applies the first load', () => {
    expect(shouldApplyFetchedHistory({ initialLoadDone: false, revisionAtRequest: 0, revisionNow: 7 })).toBe(true);
  });

  it('applies a response nothing live overtook', () => {
    expect(shouldApplyFetchedHistory({ initialLoadDone: true, revisionAtRequest: 4, revisionNow: 4 })).toBe(true);
  });

  it('drops a response that predates live events', () => {
    expect(shouldApplyFetchedHistory({ initialLoadDone: true, revisionAtRequest: 4, revisionNow: 5 })).toBe(false);
  });
});

// The sequence from the bug report, replayed against the policy: rows are ids,
// the "cache" is whatever the previous full fetch returned, SSE appends rows.
describe('a poll reload during a busy turn', () => {
  function reload(view: string[], cache: string[], server: string[], liveDuringFetch: string[], initialLoadDone: boolean) {
    let shown = view;
    let revision = 0;
    if (shouldApplyCachedHistory(initialLoadDone)) shown = cache;
    const atRequest = revision;
    // Live events land while the fetch is in flight.
    for (const row of liveDuringFetch) { shown = [...shown, row]; revision += 1; }
    if (shouldApplyFetchedHistory({ initialLoadDone, revisionAtRequest: atRequest, revisionNow: revision })) {
      shown = server;
    }
    return { shown, cache: server };
  }

  it('never removes a row the view already showed', () => {
    // Previous fetch saw [a]; since then SSE delivered tool rows b and c.
    const before = ['a', 'b', 'c'];
    const { shown } = reload(before, ['a'], ['a', 'b', 'c'], ['d'], true);
    for (const row of before) expect(shown).toContain(row);
    expect(shown).toEqual(['a', 'b', 'c', 'd']);
  });

  it('still adopts the server snapshot in a quiet moment', () => {
    const { shown } = reload(['a', 'b'], ['a'], ['a', 'b', 'c'], [], true);
    expect(shown).toEqual(['a', 'b', 'c']);
  });

  it('opens a session instantly from cache, then takes the network answer', () => {
    const { shown } = reload([], ['a'], ['a', 'b'], ['c'], false);
    expect(shown).toEqual(['a', 'b']);
  });
});
