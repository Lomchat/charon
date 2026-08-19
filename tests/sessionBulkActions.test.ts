import { describe, expect, it } from 'vitest';
import { canResumeSession, canSleepSession } from '../app/sessionBulkActions';

describe('sidebar bulk session lifecycle actions', () => {
  it('offers sleep only for running-like sessions', () => {
    for (const status of ['active', 'thinking', 'starting', 'failed', 'background']) {
      expect(canSleepSession({ status }), status).toBe(true);
      expect(canResumeSession({ status }), status).toBe(false);
    }
  });

  it('offers resume for paused and error sessions', () => {
    for (const status of ['sleeping', 'error']) {
      expect(canResumeSession({ status }), status).toBe(true);
      expect(canSleepSession({ status }), status).toBe(false);
    }
  });

  it('uses live status over a stale database status', () => {
    expect(canResumeSession({ status: 'active', liveStatus: 'sleeping' })).toBe(true);
    expect(canSleepSession({ status: 'sleeping', liveStatus: 'thinking' })).toBe(true);
  });
});
