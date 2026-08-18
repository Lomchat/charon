import { describe, expect, it } from 'vitest';
import {
  canCompactSession, contextUsagePercentage, contextUsagePresentation,
  contextWindowTokenLabel, insightSnapshotRequestState, isMcpServerReady,
} from '../app/sessionInsightState';

describe('isMcpServerReady', () => {
  it.each(['ready', 'READY', 'connected', 'running', 'started', 'ok'])(
    'recognises healthy provider status %s',
    (status) => expect(isMcpServerReady(status)).toBe(true),
  );

  it.each([undefined, null, '', 'disabled', 'failed', 'starting', 'auth required'])(
    'keeps reconnect available for unhealthy status %s',
    (status) => expect(isMcpServerReady(status)).toBe(false),
  );
});

describe('contextUsagePresentation', () => {
  it('renders an available measurement', () => {
    expect(contextUsagePresentation({ ok: true }, 43.6)).toEqual({
      meta: '44% used',
      empty: null,
    });
  });

  it('does not call an idle thread stopped when telemetry is absent', () => {
    expect(contextUsagePresentation({ ok: true }, null)).toEqual({
      meta: 'usage not reported yet',
      empty: 'context usage has not been reported yet',
    });
  });

  it('keeps real runtime failures explicit', () => {
    expect(contextUsagePresentation({ ok: false, error: 'Codex thread is not running' }, null)).toEqual({
      meta: 'unavailable',
      empty: 'Codex thread is not running',
    });
  });
});

describe('shared context gauge values', () => {
  it('prefers the provider percentage and accepts numeric SDK strings', () => {
    expect(contextUsagePercentage({ percentage: '83.54', total_tokens: 1, max_tokens: 2 })).toBe(83.54);
  });

  it('computes occupancy when a provider only supplies token counts', () => {
    expect(contextUsagePercentage({ total_tokens: 129_000, max_tokens: 258_000 })).toBe(50);
  });

  it('uses the same concise numbers in the header and Tools', () => {
    expect(contextWindowTokenLabel({ total_tokens: 215_338, max_tokens: 258_000 })).toBe('215k / 258k');
    expect(contextWindowTokenLabel({ total_tokens: 2_640, max_tokens: 200_000 })).toBe('2.6k / 200k');
  });

  it('does not invent a gauge without both token figures', () => {
    expect(contextUsagePercentage({ total_tokens: 1_000 })).toBeNull();
    expect(contextWindowTokenLabel({ total_tokens: 1_000 })).toBeNull();
  });
});

describe('canCompactSession', () => {
  it.each(['active', 'failed', 'background'])('allows idle live state %s', (status) => {
    expect(canCompactSession(status)).toBe(true);
  });

  it.each([null, undefined, 'starting', 'thinking', 'sleeping', 'error', 'reconnecting', 'killed'])(
    'blocks non-idle state %s',
    (status) => expect(canCompactSession(status)).toBe(false),
  );
});

describe('insight snapshot loading state', () => {
  it('retries a cold non-blocking snapshot without pretending it is unavailable', () => {
    expect(insightSnapshotRequestState({
      ok: false,
      reason: 'loading',
      _snapshot: { state: 'loading', retry_after_ms: 1_200 },
    })).toEqual({
      waiting: true,
      refreshing: false,
      shouldRetry: true,
      retryAfterMs: 1_200,
    });
  });

  it('keeps stale data usable while scheduling its refresh', () => {
    expect(insightSnapshotRequestState({
      ok: true,
      _snapshot: { state: 'refreshing', retry_after_ms: 50 },
    })).toEqual({
      waiting: false,
      refreshing: true,
      shouldRetry: true,
      retryAfterMs: 500,
    });
  });
});
