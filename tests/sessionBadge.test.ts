import { describe, it, expect } from 'vitest';
import {
  liveWaitingCounts, waitingCount, badgeState, WAITING_PROMOTABLE,
} from '@/app/sessionBadge';

// The failure these pin, as reported: answer a question card and the sidebar
// keeps the lock on — sometimes for the best part of a minute — while the tab
// strip clears instantly. The strip read the live SSE queues; the sidebar and
// the header nav read `pendingPermissions`, a count that only moves when the
// session list is refetched. Nothing about a prompt firing or being answered
// refetches the list.

describe('liveWaitingCounts', () => {
  it('counts one session blocked on one permission', () => {
    const counts = liveWaitingCounts([{ sessionId: 'a' }], [], []);
    expect(counts.get('a')).toBe(1);
  });

  it('sums across permissions, questions and exit plans', () => {
    const counts = liveWaitingCounts(
      [{ sessionId: 'a' }],
      [{ sessionId: 'a' }, { sessionId: 'b' }],
      [{ sessionId: 'a' }],
    );
    expect(counts.get('a')).toBe(3);
    expect(counts.get('b')).toBe(1);
  });

  it('reports nothing for a session with no pending interaction', () => {
    const counts = liveWaitingCounts([{ sessionId: 'a' }], [], []);
    expect(counts.get('quiet')).toBeUndefined();
  });
});

describe('waitingCount', () => {
  it('seeds from the polled count before the stream has synced', () => {
    // First paint: the queues are empty because nothing has ARRIVED, not
    // because nothing is pending. The server-rendered count is all we have.
    expect(waitingCount({
      pendingPermissions: 2, liveWaitingCount: 0, liveSynced: false,
    })).toBe(2);
  });

  it('lets the live queues override a stale count once synced', () => {
    // THE regression. You answered; the queue emptied; the poll has not run
    // yet and still says 1. Live wins, so the lock clears now rather than at
    // the next refetch.
    expect(waitingCount({
      pendingPermissions: 1, liveWaitingCount: 0, liveSynced: true,
    })).toBe(0);
  });

  it('shows a live prompt the polled count has not caught up with', () => {
    // The same staleness in the other direction: the prompt just fired.
    expect(waitingCount({
      pendingPermissions: 0, liveWaitingCount: 1, liveSynced: true,
    })).toBe(1);
  });

  it('treats a missing live entry as zero once synced', () => {
    expect(waitingCount({
      pendingPermissions: 3, liveWaitingCount: null, liveSynced: true,
    })).toBe(0);
  });

  it('never reports a negative count', () => {
    expect(waitingCount({ pendingPermissions: -1, liveSynced: false })).toBe(0);
  });
});

describe('badgeState', () => {
  it('says "needs you" mid-turn, which is when prompts actually fire', () => {
    // The old rule promoted only from 'active'. A prompt happens inside a
    // turn, so the session is 'thinking' and the card said WORKING while it
    // sat blocked — the one case the word existed for.
    expect(badgeState({ liveStatus: 'thinking', waiting: 1 })).toBe('waiting');
  });

  it('still says "needs you" for a session idle between turns', () => {
    expect(badgeState({ liveStatus: 'active', waiting: 1 })).toBe('waiting');
  });

  it('promotes over every live status a turn can be in', () => {
    for (const status of WAITING_PROMOTABLE) {
      expect(badgeState({ liveStatus: status, waiting: 1 })).toBe('waiting');
    }
  });

  it('does not ask you to answer a sleeping session', () => {
    // A pending row here is a leftover the turn never resolved.
    expect(badgeState({ liveStatus: 'sleeping', waiting: 1 })).toBe('sleeping');
  });

  it('does not ask you to answer a failed session', () => {
    expect(badgeState({ liveStatus: 'failed', waiting: 1 })).toBe('failed');
  });

  it('reports what the session is doing when nothing is pending', () => {
    expect(badgeState({ liveStatus: 'thinking', waiting: 0 })).toBe('thinking');
    expect(badgeState({ liveStatus: 'active', waiting: 0 })).toBe('active');
  });

  it('prefers the live status over the durable row status', () => {
    expect(badgeState({ status: 'active', liveStatus: 'thinking', waiting: 0 })).toBe('thinking');
  });

  it('falls back to the row status before any live status arrives', () => {
    expect(badgeState({ status: 'active', waiting: 0 })).toBe('active');
  });
});

// The reported sequence, replayed against the policy. `polled` is what the
// list endpoint last returned and deliberately never changes: the whole point
// is that the badge stays correct without a refetch.
describe('a question card raised and answered, with no poll in between', () => {
  const polled = 0;      // the list was fetched before any of this happened
  const liveSynced = true;

  it('locks the card the moment the question arrives, and clears it on answer', () => {
    // 1. Quiet session, mid-turn.
    let queues = liveWaitingCounts([], [], []);
    let waiting = waitingCount({
      pendingPermissions: polled, liveWaitingCount: queues.get('s1'), liveSynced,
    });
    expect(badgeState({ liveStatus: 'thinking', waiting })).toBe('thinking');

    // 2. user_question arrives over SSE. No refetch has run.
    queues = liveWaitingCounts([], [{ sessionId: 's1' }], []);
    waiting = waitingCount({
      pendingPermissions: polled, liveWaitingCount: queues.get('s1'), liveSynced,
    });
    expect(waiting).toBe(1);
    expect(badgeState({ liveStatus: 'thinking', waiting })).toBe('waiting');

    // 3. You answer. interaction_resolved empties the queue. Still no refetch.
    queues = liveWaitingCounts([], [], []);
    waiting = waitingCount({
      pendingPermissions: polled, liveWaitingCount: queues.get('s1'), liveSynced,
    });
    expect(waiting).toBe(0);
    expect(badgeState({ liveStatus: 'thinking', waiting })).toBe('thinking');

    // 4. Turn ends.
    expect(badgeState({ liveStatus: 'active', waiting })).toBe('active');
  });

  it('would have stayed locked under the old union rule', () => {
    // Guards the decision recorded in the module header: taking the union of
    // the polled count and the live queues re-breaks step 3. Here the poll is
    // mid-flight and still carries the answered prompt.
    const stalePoll = 1;
    const union = Math.max(stalePoll, 0);
    expect(union).toBe(1);                                    // the old bug
    expect(waitingCount({
      pendingPermissions: stalePoll, liveWaitingCount: 0, liveSynced: true,
    })).toBe(0);                                              // what we ship
  });
});
