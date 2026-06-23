import { describe, it, expect, beforeEach } from 'vitest';
import {
  check,
  recordFailure,
  recordSuccess,
  keyFromHeaders,
  lockoutForFailures,
  FREE_ATTEMPTS,
  MAX_LOCKOUT_MS,
  _resetAll,
} from './loginRateLimit';

// A deterministic, monotonic fake clock. All tests pass an explicit `now` so
// nothing depends on real time / sleeps.
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
  };
}

beforeEach(() => {
  _resetAll();
});

describe('loginRateLimit', () => {
  it('allows the first FREE_ATTEMPTS failures with no lockout, then locks', () => {
    const clk = makeClock();
    const key = 'ip-a';

    // The free attempts: each check() is allowed, each failure adds no lockout.
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      expect(check(key, clk.now())).toEqual({ allowed: true, retryAfterMs: 0 });
      recordFailure(key, clk.now());
    }

    // Still allowed right after the last free failure (lockout is 0 so far).
    expect(check(key, clk.now()).allowed).toBe(true);

    // The (FREE_ATTEMPTS + 1)th failure arms a real lockout.
    recordFailure(key, clk.now());
    const gate = check(key, clk.now());
    expect(gate.allowed).toBe(false);
    expect(gate.retryAfterMs).toBeGreaterThan(0);
  });

  it('grows retryAfterMs exponentially with consecutive failures', () => {
    const clk = makeClock();
    const key = 'ip-grow';

    // Burn the free attempts.
    for (let i = 0; i < FREE_ATTEMPTS; i++) recordFailure(key, clk.now());

    // First locking failure.
    recordFailure(key, clk.now());
    const first = check(key, clk.now()).retryAfterMs;
    expect(first).toBeGreaterThan(0);

    // Wait out the lock, then fail again at the SAME instant the lock expires.
    clk.advance(first);
    recordFailure(key, clk.now());
    const second = check(key, clk.now()).retryAfterMs;

    // The second lockout window is strictly longer (exponential growth).
    expect(second).toBeGreaterThan(first);

    // And again.
    clk.advance(second);
    recordFailure(key, clk.now());
    const third = check(key, clk.now()).retryAfterMs;
    expect(third).toBeGreaterThan(second);
  });

  it('caps the lockout window at MAX_LOCKOUT_MS', () => {
    const clk = makeClock();
    const key = 'ip-cap';

    // Pile on far more failures than needed to exceed the cap.
    for (let i = 0; i < FREE_ATTEMPTS + 40; i++) recordFailure(key, clk.now());
    const gate = check(key, clk.now());
    expect(gate.allowed).toBe(false);
    expect(gate.retryAfterMs).toBeLessThanOrEqual(MAX_LOCKOUT_MS);

    // lockoutForFailures saturates exactly at the cap for huge failure counts.
    expect(lockoutForFailures(10_000)).toBe(MAX_LOCKOUT_MS);
    expect(lockoutForFailures(FREE_ATTEMPTS)).toBe(0);
  });

  it('lock expires after the window — a later check is allowed again', () => {
    const clk = makeClock();
    const key = 'ip-expire';

    for (let i = 0; i < FREE_ATTEMPTS; i++) recordFailure(key, clk.now());
    recordFailure(key, clk.now());

    const locked = check(key, clk.now());
    expect(locked.allowed).toBe(false);
    const wait = locked.retryAfterMs;

    // One ms before expiry: still locked, with 1ms remaining.
    clk.advance(wait - 1);
    const almost = check(key, clk.now());
    expect(almost.allowed).toBe(false);
    expect(almost.retryAfterMs).toBe(1);

    // At/after expiry: allowed again.
    clk.advance(1);
    expect(check(key, clk.now())).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('recordSuccess resets the bucket entirely', () => {
    const clk = makeClock();
    const key = 'ip-success';

    for (let i = 0; i < FREE_ATTEMPTS + 1; i++) recordFailure(key, clk.now());
    expect(check(key, clk.now()).allowed).toBe(false);

    recordSuccess(key);

    // Fresh bucket: allowed, and the failure escalation restarts from zero —
    // a single subsequent failure must NOT re-lock (it's within the free band).
    expect(check(key, clk.now())).toEqual({ allowed: true, retryAfterMs: 0 });
    recordFailure(key, clk.now());
    expect(check(key, clk.now()).allowed).toBe(true);
  });

  it('keeps different keys independent', () => {
    const clk = makeClock();

    // Lock out key A completely.
    for (let i = 0; i < FREE_ATTEMPTS + 1; i++) recordFailure('ip-A', clk.now());
    expect(check('ip-A', clk.now()).allowed).toBe(false);

    // Key B is untouched.
    expect(check('ip-B', clk.now())).toEqual({ allowed: true, retryAfterMs: 0 });
    // Failing B doesn't affect A's lock and vice-versa.
    recordFailure('ip-B', clk.now());
    expect(check('ip-B', clk.now()).allowed).toBe(true);
    expect(check('ip-A', clk.now()).allowed).toBe(false);
  });

  it('check() is read-only — it does not itself escalate lockout', () => {
    const clk = makeClock();
    const key = 'ip-readonly';
    for (let i = 0; i < FREE_ATTEMPTS + 1; i++) recordFailure(key, clk.now());
    const a = check(key, clk.now()).retryAfterMs;
    const b = check(key, clk.now()).retryAfterMs;
    // Two checks in a row at the same instant report the same remaining time.
    expect(a).toBe(b);
  });

  describe('keyFromHeaders', () => {
    const mk = (h: Record<string, string>) => ({
      get: (n: string) => h[n.toLowerCase()] ?? null,
    });

    it('uses the left-most x-forwarded-for hop', () => {
      expect(keyFromHeaders(mk({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4');
    });

    it('trims whitespace around the forwarded IP', () => {
      expect(keyFromHeaders(mk({ 'x-forwarded-for': '  9.9.9.9  ' }))).toBe('9.9.9.9');
    });

    it('falls back to x-real-ip when no x-forwarded-for', () => {
      expect(keyFromHeaders(mk({ 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8');
    });

    it('prefers x-forwarded-for over x-real-ip', () => {
      expect(
        keyFromHeaders(mk({ 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '8.8.8.8' })),
      ).toBe('1.1.1.1');
    });

    it('falls back to a single global bucket when no IP header present', () => {
      expect(keyFromHeaders(mk({}))).toBe('global');
      expect(keyFromHeaders(null)).toBe('global');
      expect(keyFromHeaders(undefined)).toBe('global');
    });

    it('falls back to global when x-forwarded-for is empty / whitespace', () => {
      expect(keyFromHeaders(mk({ 'x-forwarded-for': '   ' }))).toBe('global');
    });

    it('produces a shared global lockout for header-stripping attackers', () => {
      const clk = makeClock();
      const k = keyFromHeaders(mk({}));
      for (let i = 0; i < FREE_ATTEMPTS + 1; i++) recordFailure(k, clk.now());
      // Any later anonymous attempt hits the same locked global bucket.
      expect(check(keyFromHeaders(null), clk.now()).allowed).toBe(false);
    });
  });
});
