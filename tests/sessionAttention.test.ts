import { describe, it, expect } from 'vitest';
import {
  attentionForRow, deriveAttention, isLiveRow, isUnseenFinish, isWaitingAttention, pendingSplit, rowStatus,
  NON_LIVE_STATUSES,
} from '@/lib/sessionAttention';
import { deriveAttention as reexported } from '@/lib/sessionSummary';
import { isWorkingStatus } from '@/app/sessionUnread';
import { createAttentionTracker, ATTENTION_WINDOW_MS, ATTENTION_POST_INTERVAL_MS } from '@/app/attention';
import { feedFromSummaries, pruneExpired, FEED_EXPIRY_SLACK_S } from '@/app/useCrossSessionInteractionFeed';
import type { SessionSummary } from '@/lib/sessionSummary';

// THE cross-session attention predicate (lib/sessionAttention.ts): one reading
// for the sidebar card, the header nav (+ favicon), the tab bar, the filter
// chip and the desk. The scenarios are R5 §5.1's matrix A–K.

type Row = Parameters<typeof attentionForRow>[0];
const row = (o: Partial<Row> & { status?: string } = {}): Row => ({
  status: 'active', liveStatus: undefined, unreadStop: 0,
  pendingPermissions: 0, pendingBlocking: 0, pendingAsync: 0, ...o,
});

// The surface rules, written exactly as the components apply them.
const sidebarWord = (r: Row, selected = false) => {
  const a = attentionForRow(r, { viewedHere: selected });
  return a === 'blocked' ? 'needs you' : a === 'question' ? 'question' : rowStatus(r);
};
const headerRunning = (r: Row) => isWorkingStatus(rowStatus(r)) || attentionForRow(r, { viewedHere: false }) === 'blocked';
const headerWaiting = (r: Row) => isWaitingAttention(attentionForRow(r, { viewedHere: false }));
const chipCounts = (r: Row) => isWaitingAttention(attentionForRow(r, { viewedHere: false }));

describe('deriveAttention', () => {
  it('is the module lib/sessionSummary re-exports', () => {
    expect(reexported).toBe(deriveAttention);
  });

  it('orders blocked > question > unread > null', () => {
    const base = { status: 'active', unreadStop: 1, pendingBlocking: 1, pendingAsync: 1 };
    expect(deriveAttention(base)).toBe('blocked');
    expect(deriveAttention({ ...base, pendingBlocking: 0 })).toBe('question');
    expect(deriveAttention({ ...base, pendingBlocking: 0, pendingAsync: 0 })).toBe('unread');
    expect(deriveAttention({ ...base, pendingBlocking: 0, pendingAsync: 0, unreadStop: 0 })).toBe(null);
  });

  it('blocked on every live status, never on a non-live one', () => {
    for (const status of ['active', 'thinking', 'starting', 'background', 'failed']) {
      expect(deriveAttention({ status, unreadStop: 0, pendingBlocking: 1, pendingAsync: 0 })).toBe('blocked');
    }
    for (const status of NON_LIVE_STATUSES) {
      expect(deriveAttention({ status, unreadStop: 0, pendingBlocking: 1, pendingAsync: 0 })).toBe(null);
    }
  });

  it('question on any status', () => {
    for (const status of ['active', 'thinking', 'sleeping', 'error', 'failed']) {
      expect(deriveAttention({ status, unreadStop: 0, pendingBlocking: 0, pendingAsync: 2 })).toBe('question');
    }
  });

  it('unread only on a ready (active) session', () => {
    for (const status of ['thinking', 'starting', 'background', 'sleeping']) {
      expect(deriveAttention({ status, unreadStop: true, pendingBlocking: 0, pendingAsync: 0 })).toBe(null);
    }
    expect(deriveAttention({ status: 'active', unreadStop: true, pendingBlocking: 0, pendingAsync: 0 })).toBe('unread');
  });

  it('error = the unread marker on a failed or crashed session; a seen failure is still', () => {
    for (const status of ['failed', 'error']) {
      expect(deriveAttention({ status, unreadStop: true, pendingBlocking: 0, pendingAsync: 0 })).toBe('error');
      expect(deriveAttention({ status, unreadStop: 0, pendingBlocking: 0, pendingAsync: 0 })).toBe(null);
    }
  });

  it('orders blocked > question > error', () => {
    const failed = { status: 'failed', unreadStop: 1, pendingBlocking: 1, pendingAsync: 1 };
    expect(deriveAttention(failed)).toBe('blocked');
    expect(deriveAttention({ ...failed, pendingBlocking: 0 })).toBe('question');
    expect(deriveAttention({ ...failed, pendingBlocking: 0, pendingAsync: 0 })).toBe('error');
  });
});

describe('attentionForRow: error', () => {
  it('is hidden on the row this tab views, like unread', () => {
    const r = row({ status: 'failed', unreadStop: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('error');
    expect(attentionForRow(r, { viewedHere: true })).toBe(null);
  });

  it('reads the live status first', () => {
    expect(attentionForRow(row({ status: 'active', liveStatus: 'error', unreadStop: 1 }), { viewedHere: false })).toBe('error');
    expect(attentionForRow(row({ status: 'failed', liveStatus: 'thinking', unreadStop: 1 }), { viewedHere: false })).toBe(null);
  });

  it('isUnseenFinish covers unread and error only', () => {
    expect(isUnseenFinish('unread')).toBe(true);
    expect(isUnseenFinish('error')).toBe(true);
    for (const a of ['blocked', 'question', null] as const) expect(isUnseenFinish(a)).toBe(false);
  });
});

describe('row helpers', () => {
  it('rowStatus prefers the live status', () => {
    expect(rowStatus({ liveStatus: 'thinking', status: 'active' })).toBe('thinking');
    expect(rowStatus({ liveStatus: undefined, status: 'sleeping' })).toBe('sleeping');
    expect(rowStatus({ liveStatus: null, status: 'active' })).toBe('active');
  });

  it('isLiveRow: live unless sleeping/error/killed, live status first', () => {
    for (const status of ['active', 'thinking', 'starting', 'background', 'failed']) expect(isLiveRow({ status })).toBe(true);
    for (const status of NON_LIVE_STATUSES) expect(isLiveRow({ status })).toBe(false);
    expect(isLiveRow({ liveStatus: 'sleeping', status: 'active' })).toBe(false);
    expect(isLiveRow({ liveStatus: 'thinking', status: 'sleeping' })).toBe(true);
  });

  it('an older hub (pendingPermissions only) reads as blocking', () => {
    expect(pendingSplit({ pendingPermissions: 3 })).toEqual({ pendingBlocking: 3, pendingAsync: 0 });
    expect(pendingSplit({ pendingPermissions: 3, pendingBlocking: 1, pendingAsync: 2 }))
      .toEqual({ pendingBlocking: 1, pendingAsync: 2 });
    expect(attentionForRow({ status: 'thinking', pendingPermissions: 1 }, { viewedHere: false })).toBe('blocked');
  });
});

describe('R5 §5.1 scenario matrix', () => {
  it('A: blocking gate mid-turn (thinking) ⇒ "needs you" everywhere, still running', () => {
    const r = row({ liveStatus: 'thinking', pendingPermissions: 1, pendingBlocking: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('blocked');
    expect(sidebarWord(r)).toBe('needs you');
    expect(headerWaiting(r)).toBe(true);
    expect(headerRunning(r)).toBe(true);
  });

  it('B: async question on an idle session ⇒ question, not working', () => {
    const r = row({ liveStatus: 'active', pendingPermissions: 1, pendingAsync: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('question');
    expect(sidebarWord(r)).toBe('question');
    expect(headerWaiting(r)).toBe(true);
    expect(headerRunning(r)).toBe(false);
  });

  it('C: async question on a paused session ⇒ question, NOT counted as working', () => {
    const r = row({ status: 'sleeping', liveStatus: 'sleeping', pendingPermissions: 1, pendingAsync: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('question');
    expect(headerWaiting(r)).toBe(true);
    expect(headerRunning(r)).toBe(false);
  });

  it('D: finished unread, not selected ⇒ unread; the viewed row hides it', () => {
    const r = row({ liveStatus: 'active', unreadStop: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('unread');
    expect(attentionForRow(r, { viewedHere: true })).toBe(null);
  });

  it('E: an SSR/older row without liveStatus reads its DB status', () => {
    const r = row({ status: 'active', liveStatus: undefined, unreadStop: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('unread');
    const t = row({ status: 'thinking', liveStatus: undefined });
    expect(headerRunning(t)).toBe(true);
  });

  it('F: the feed is derived from the summaries: a gate they no longer list is gone (no ghost)', () => {
    const summary = (id: string, gates: SessionSummary['gates']) => ({ id, gates } as unknown as SessionSummary);
    const before = feedFromSummaries([
      summary('s', [
        { id: 'p1', kind: 'permission', blocking: true, createdAt: 2, expiresAt: null, title: 'Bash', preview: '{"command":"ls"}' },
        { id: 'p2', kind: 'permission', blocking: true, createdAt: 1, expiresAt: 50, title: 'Edit' },
        { id: 'q1', kind: 'question', blocking: false, createdAt: 3, expiresAt: null, title: 'Which?', delivering: true },
        { id: 'e1', kind: 'exit_plan', blocking: true, createdAt: 4, expiresAt: null, title: 'plan' },
      ]),
    ]);
    expect(before.perms.map((p) => p.id)).toEqual(['p2', 'p1']);           // oldest first
    expect(before.perms[1]).toMatchObject({ sessionId: 's', tool: 'Bash', preview: '{"command":"ls"}' });
    expect(before.perms[0].expiresAt).toBe(50);
    expect(before.questions[0]).toMatchObject({ id: 'q1', delivery: 'async', delivering: true, title: 'Which?' });
    expect(before.exitPlans.map((e) => e.id)).toEqual(['e1']);
    // A resolution missed while away: the next summary simply lacks it.
    const after = feedFromSummaries([summary('s', [
      { id: 'p2', kind: 'permission', blocking: true, createdAt: 1, expiresAt: 50, title: 'Edit' },
    ])]);
    expect(after.perms.map((p) => p.id)).toEqual(['p2']);
    expect(after.questions).toEqual([]);
    expect(after.exitPlans).toEqual([]);
    // Pruned past its expiry + slack when a clock is given.
    expect(feedFromSummaries([summary('s', [
      { id: 'p2', kind: 'permission', blocking: true, createdAt: 1, expiresAt: 50, title: 'Edit' },
    ])], 50 + FEED_EXPIRY_SLACK_S + 1).perms).toEqual([]);
  });

  it('F: an expired gate is pruned after the slack', () => {
    const gates = [{ id: 'a', expiresAt: 100 }, { id: 'b' }, { id: 'c', expiresAt: 1000 }];
    expect(pruneExpired(gates, 100 + FEED_EXPIRY_SLACK_S)).toBe(gates);
    expect(pruneExpired(gates, 100 + FEED_EXPIRY_SLACK_S + 1).map((g) => g.id)).toEqual(['b', 'c']);
  });

  it('G: a blocking gate on a stopped session is not "needs you"', () => {
    for (const status of ['sleeping', 'error']) {
      const r = row({ status, liveStatus: status, pendingPermissions: 1, pendingBlocking: 1 });
      expect(attentionForRow(r, { viewedHere: false })).toBe(null);
      expect(sidebarWord(r)).toBe(status);
      expect(headerWaiting(r)).toBe(false);
    }
  });

  it('I: an idle device is not an attended view', () => {
    let now = 1_000_000;
    let visible = true;
    const posts: number[] = [];
    const t = createAttentionTracker({
      now: () => now, isVisible: () => visible, hasFocus: () => true, post: () => posts.push(now),
    });
    // A fresh page (an automatic reload of a forgotten tab) is not attended (W2 review).
    expect(t.isAttentive()).toBe(false);
    t.noteInput();                                       // the first real input proves it at once
    expect(t.isAttentive()).toBe(true);
    expect(posts).toEqual([now]);
    posts.length = 0;
    now += ATTENTION_WINDOW_MS + 1;
    expect(t.isAttentive()).toBe(false);                 // left open, nobody there
    t.noteInput();                                       // idle → active: proof at once
    expect(t.isAttentive()).toBe(true);
    expect(posts).toEqual([now]);
    now += 1_000; t.noteInput();                         // throttled
    expect(posts.length).toBe(1);
    now += ATTENTION_POST_INTERVAL_MS; t.noteInput();    // ≤ 1 per 30 s while focused
    expect(posts.length).toBe(2);
    visible = false;
    expect(t.isAttentive()).toBe(false);                 // hidden is never attended
    now += 1; t.noteInput();
    expect(posts.length).toBe(2);
    visible = true; t.noteVisible();                     // the focus re-POST is the proof
    expect(t.isAttentive()).toBe(true);
    expect(posts.length).toBe(2);
  });

  it('I: no periodic proof without a focused session', () => {
    let now = 0;
    const posts: number[] = [];
    const t = createAttentionTracker({
      now: () => now, isVisible: () => true, hasFocus: () => false, post: () => posts.push(now),
    });
    t.noteInput();                                       // the idle → active proof
    posts.length = 0;
    for (let i = 0; i < 5; i++) { now += ATTENTION_POST_INTERVAL_MS; t.noteInput(); }
    expect(posts).toEqual([]);
  });

  it('I: the attention age is the time since the last input, null when idle', () => {
    let now = 0;
    const t = createAttentionTracker({
      now: () => now, isVisible: () => true, hasFocus: () => true, post: () => {},
    });
    expect(t.attentionAgeMs()).toBe(null);
    t.noteInput();
    now += 110_000;
    expect(t.attentionAgeMs()).toBe(110_000);
    now = ATTENTION_WINDOW_MS + 1;
    expect(t.attentionAgeMs()).toBe(null);
  });

  it('J: the selected session finishing while the tab is hidden still counts (viewedHere needs visible)', () => {
    const r = row({ liveStatus: 'active', unreadStop: 1 });
    const selected = true; const visible = false;
    expect(attentionForRow(r, { viewedHere: selected && visible })).toBe('unread');
  });

  it('K: a session that just finished turns unread with the stop (status active + marker)', () => {
    const thinking = row({ liveStatus: 'thinking', unreadStop: 1 });
    expect(attentionForRow(thinking, { viewedHere: false })).toBe(null);
    expect(attentionForRow({ ...thinking, liveStatus: 'active' }, { viewedHere: false })).toBe('unread');
  });
});

describe('the sidebar filter chip predicate', () => {
  it('counts a hidden paused session holding only an async question', () => {
    expect(chipCounts(row({ status: 'sleeping', liveStatus: 'sleeping', pendingPermissions: 1, pendingAsync: 1 }))).toBe(true);
  });

  it('does not count an unread one', () => {
    expect(chipCounts(row({ liveStatus: 'active', unreadStop: 1 }))).toBe(false);
  });

  it('counts a blocked one, not a dead gate on a stopped session', () => {
    expect(chipCounts(row({ liveStatus: 'thinking', pendingPermissions: 1, pendingBlocking: 1 }))).toBe(true);
    expect(chipCounts(row({ status: 'error', liveStatus: 'error', pendingPermissions: 1, pendingBlocking: 1 }))).toBe(false);
  });
});
