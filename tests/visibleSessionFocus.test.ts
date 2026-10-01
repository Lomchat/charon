import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  subscribeGlobalSessionEvents: () => () => {},
  setSessionFocusChecker: () => {},
}));

import { registerConnection, setConnectionFocus, wasRecentlyViewed } from '@/lib/server/agent/eventConnections';

describe('visible session focus', () => {
  it('marks a selected session unreadable when its tab is hidden', () => {
    const sessionId = 'visible-focus-test-session';
    const unregister = registerConnection({
      connId: 'visible-focus-test-connection', send: () => {}, initialFocus: sessionId,
      initialFocusSeq: 1, initialVisible: true,
    });

    expect(wasRecentlyViewed(sessionId)).toBe(true);
    setConnectionFocus('visible-focus-test-connection', sessionId, 2, false);
    expect(wasRecentlyViewed(sessionId)).toBe(false);
    setConnectionFocus('visible-focus-test-connection', sessionId, 3, true);
    expect(wasRecentlyViewed(sessionId)).toBe(true);

    unregister();
  });
});
