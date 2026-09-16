import { describe, it, expect } from 'vitest';
import { showsUnreadCue, isWorkingStatus } from '@/app/sessionUnread';

// The green "finished, unread" cue (§14.47). One predicate for the sidebar card
// and the header nav — the marker is durable, the DRAWING is what this decides.

describe('showsUnreadCue', () => {
  const unreadActive = { unreadStop: 1, status: 'active', pendingPermissions: 0 };

  it('draws on a ready session that finished while you were away', () => {
    expect(showsUnreadCue(unreadActive)).toBe(true);
  });

  it('says nothing without the durable marker', () => {
    expect(showsUnreadCue({ ...unreadActive, unreadStop: 0 })).toBe(false);
    expect(showsUnreadCue({ status: 'active' })).toBe(false);
  });

  // A paused session is already telling you it is paused, and a failed one is
  // red: a green "come and see" over either is noise.
  it('stays quiet on a session that is not ready', () => {
    for (const status of ['sleeping', 'error', 'failed', 'killed']) {
      expect(showsUnreadCue({ ...unreadActive, status })).toBe(false);
    }
  });

  it('stays quiet while the session is still working', () => {
    for (const status of ['thinking', 'starting', 'background']) {
      expect(showsUnreadCue({ ...unreadActive, status })).toBe(false);
    }
  });

  it('yields to a pending gate — the more urgent cue', () => {
    expect(showsUnreadCue({ ...unreadActive, pendingPermissions: 1 })).toBe(false);
  });

  it('yields to the card you are reading', () => {
    expect(showsUnreadCue({ ...unreadActive, selected: true })).toBe(false);
  });

  it('treats a missing status as not ready', () => {
    expect(showsUnreadCue({ unreadStop: 1 })).toBe(false);
    expect(showsUnreadCue({ unreadStop: 1, status: null })).toBe(false);
  });
});

describe('isWorkingStatus', () => {
  it('counts background as working — the turn ended, its tasks did not', () => {
    expect(isWorkingStatus('background')).toBe(true);
    expect(isWorkingStatus('thinking')).toBe(true);
    expect(isWorkingStatus('starting')).toBe(true);
  });

  it('leaves every settled status alone', () => {
    for (const status of ['active', 'sleeping', 'error', 'failed', null, undefined]) {
      expect(isWorkingStatus(status)).toBe(false);
    }
  });
});
