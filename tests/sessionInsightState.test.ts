import { describe, expect, it } from 'vitest';
import { isMcpServerReady } from '../app/sessionInsightState';

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
