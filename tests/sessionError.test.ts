import { describe, expect, it } from 'vitest';
import { classifySessionError, parseSessionError } from '../lib/sessionError';

describe('provider-neutral blocking session errors', () => {
  it('gives both providers a sign-in recovery action', () => {
    expect(classifySessionError({
      provider: 'claude', message: 'Failed to authenticate. API Error: 401 Unauthorized',
      turnFailure: true,
    })).toMatchObject({ kind: 'authentication', action: 'sign_in' });
    expect(classifySessionError({
      provider: 'codex', message: 'Not logged in. Run codex login.', turnFailure: true,
    })).toMatchObject({ kind: 'authentication', action: 'sign_in' });
  });

  it('offers Continue for recoverable Codex turn failures', () => {
    expect(classifySessionError({
      provider: 'codex', message: 'stream disconnected while reading the response',
      turnFailure: true,
    })).toMatchObject({ kind: 'transport', action: 'continue', fatal: false });
    expect(classifySessionError({
      provider: 'codex', message: 'turn failed', turnFailure: true,
    })).toMatchObject({ kind: 'api', action: 'continue' });
  });

  it('does not suggest Continue while a quota is exhausted', () => {
    expect(classifySessionError({
      provider: 'codex', message: 'rate limit exceeded (429)', turnFailure: true,
      resetAt: 1_800_000_000_000,
    })).toMatchObject({ kind: 'rate_limit', action: null, resetAt: 1_800_000_000_000 });
  });

  it('round-trips only the durable payload shape', () => {
    const payload = classifySessionError({
      provider: 'codex', message: 'Not signed in', turnFailure: true,
    });
    expect(parseSessionError(JSON.stringify(payload))).toEqual(payload);
    expect(parseSessionError('plain error')).toBeNull();
    expect(parseSessionError('{"type":"session_error","provider":"other"}')).toBeNull();
  });
});
