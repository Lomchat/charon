import { describe, it, expect } from 'vitest';
import { pruneUnconfirmed } from '@/app/interactionResync';

// The regression this exists to prevent: the reconnect handler used to EMPTY
// the cross-session queues and rely on the connect replay to refill them.
// Nothing else repopulates those queues — no poll, no refetch, only a live
// event or a remount — so a replay that was missed or late left them empty
// until the user pressed F5. Reported as: popup and NEEDS YOU work after a
// refresh, stop firing at some later point, and come back on the next refresh.
//
// The rule now is that entries are only ever dropped against positive evidence
// that the snapshot did not list them.

const q = (...ids: string[]) => ids.map((id) => ({ id }));

describe('pruneUnconfirmed', () => {
  it('keeps an entry the snapshot confirmed', () => {
    expect(pruneUnconfirmed(q('a'), new Set(['a']))).toEqual(q('a'));
  });

  it('drops an entry the snapshot did not mention', () => {
    // Answered on another device while this tab was disconnected:
    // `interaction_resolved` is live-only, so its absence is the only signal.
    expect(pruneUnconfirmed(q('a', 'b'), new Set(['a']))).toEqual(q('a'));
  });

  it('keeps an interaction that fired mid-resync', () => {
    // Anything arriving while the snapshot drains is recorded too, so a prompt
    // raised in that window is not mistaken for a resolved one.
    expect(pruneUnconfirmed(q('old', 'fresh'), new Set(['old', 'fresh'])))
      .toEqual(q('old', 'fresh'));
  });

  it('empties the queue only when the snapshot confirmed nothing', () => {
    expect(pruneUnconfirmed(q('a', 'b'), new Set<string>([]))).toEqual([]);
  });

  it('handles an already-empty queue', () => {
    expect(pruneUnconfirmed([], new Set(['a']))).toEqual([]);
  });

  it('ignores confirmations for entries it never held', () => {
    expect(pruneUnconfirmed(q('a'), new Set(['a', 'ghost']))).toEqual(q('a'));
  });

  it('preserves array identity when nothing is dropped', () => {
    // Consumers memoise on these arrays; a new one every reconnect would
    // invalidate the popup and the badge projection for no reason.
    const before = q('a', 'b');
    expect(pruneUnconfirmed(before, new Set(['a', 'b']))).toBe(before);
  });

  it('returns a new array when something is dropped', () => {
    const before = q('a', 'b');
    expect(pruneUnconfirmed(before, new Set(['a']))).not.toBe(before);
  });

  it('preserves order', () => {
    expect(pruneUnconfirmed(q('c', 'a', 'b'), new Set(['c', 'b'])))
      .toEqual(q('c', 'b'));
  });
});

// The reported failure, replayed as the sequence of states the queue goes
// through. The old code is represented by the clear it used to perform.
describe('a reconnect while a prompt is pending', () => {
  it('never goes blind, and keeps the prompt when the snapshot re-lists it', () => {
    const pending = q('question-1');

    // OLD BEHAVIOUR: emptied here, and stayed empty if the replay was missed.
    const clearedAndHoping: typeof pending = [];
    expect(clearedAndHoping).toEqual([]);          // the dead state users hit

    // NEW: the queue is untouched while the snapshot arrives, so the popup and
    // the badge keep showing a prompt that is genuinely still pending.
    expect(pending).toEqual(q('question-1'));

    // Snapshot drains and re-lists it → nothing is dropped.
    expect(pruneUnconfirmed(pending, new Set(['question-1']))).toEqual(q('question-1'));
  });

  it('drops it only once the snapshot proves it was answered elsewhere', () => {
    const pending = q('question-1');
    expect(pruneUnconfirmed(pending, new Set<string>([]))).toEqual([]);
  });
});
