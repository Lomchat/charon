import { describe, expect, it } from 'vitest';
import { contextUsagePresentation, isMcpServerReady } from '../app/sessionInsightState';

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
