// In-memory, per-key login brute-force throttle.
//
// The whole fleet's SSH access sits behind ONE MASTER_PASSWORD, so an
// unthrottled /login is a single-target brute-force surface. This module is a
// PURE, module-level, in-memory limiter (no DB, no I/O): a Map of buckets keyed
// by client IP (or a single global bucket when the IP is unknown).
//
// Policy: the first FREE_ATTEMPTS consecutive failures are allowed with no
// delay. Each failure beyond that arms an exponential lockout window that grows
// with the consecutive-failure count and is capped at MAX_LOCKOUT_MS. A success
// clears the bucket entirely. Buckets idle past a generous TTL are reaped so the
// Map can't grow unbounded under random-IP spray.
//
// The clock is injectable (`now()` arg, default Date.now) so tests are fully
// deterministic without real sleeps. This is app runtime code (not a workflow
// script), so Date.now is available and fine as the default.

export const FREE_ATTEMPTS = 5; // failures allowed before any lockout kicks in
const BASE_LOCKOUT_MS = 2_000; // first lockout after the free attempts
export const MAX_LOCKOUT_MS = 5 * 60_000; // cap (5 min) — never lock out forever
const BUCKET_TTL_MS = 60 * 60_000; // reap idle buckets after 1h

type Bucket = {
  // Count of consecutive failures (reset to 0 on success).
  failures: number;
  // Absolute time (ms) until which this key is locked out. 0 = not locked.
  lockedUntil: number;
  // Last time this bucket was touched — used only for idle reaping.
  lastSeen: number;
};

const buckets = new Map<string, Bucket>();

function defaultNow(): number {
  return Date.now();
}

// Lockout duration for the Nth failure (1-indexed). The first FREE_ATTEMPTS
// failures are free (0ms); afterward each extra failure doubles the window from
// BASE_LOCKOUT_MS, capped at MAX_LOCKOUT_MS.
export function lockoutForFailures(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  const over = failures - FREE_ATTEMPTS; // 1, 2, 3, ...
  const ms = BASE_LOCKOUT_MS * 2 ** (over - 1);
  return Math.min(ms, MAX_LOCKOUT_MS);
}

function reapIfStale(bucket: Bucket, key: string, now: number) {
  // Only reap a bucket that is BOTH idle and not currently locked.
  if (now - bucket.lastSeen > BUCKET_TTL_MS && now >= bucket.lockedUntil) {
    buckets.delete(key);
  }
}

/**
 * Is a login attempt for `key` currently allowed?
 * Returns `retryAfterMs` (>0) only when genuinely locked out. Read-only: it
 * does not mutate failure counts (call recordFailure/recordSuccess for that).
 */
export function check(
  key: string,
  now: number = defaultNow(),
): { allowed: boolean; retryAfterMs: number } {
  const bucket = buckets.get(key);
  if (!bucket) return { allowed: true, retryAfterMs: 0 };
  reapIfStale(bucket, key, now);
  if (now < bucket.lockedUntil) {
    return { allowed: false, retryAfterMs: bucket.lockedUntil - now };
  }
  // Lockout window has elapsed — allowed again (the bucket keeps its failure
  // count so the NEXT failure escalates, but a single retry is permitted).
  return { allowed: true, retryAfterMs: 0 };
}

/** Record a failed login for `key`, arming/growing the lockout window. */
export function recordFailure(key: string, now: number = defaultNow()): void {
  const bucket = buckets.get(key) ?? { failures: 0, lockedUntil: 0, lastSeen: now };
  bucket.failures += 1;
  bucket.lastSeen = now;
  const lock = lockoutForFailures(bucket.failures);
  bucket.lockedUntil = lock > 0 ? now + lock : 0;
  buckets.set(key, bucket);
}

/** Record a successful login for `key` — clears the bucket entirely. */
export function recordSuccess(key: string): void {
  buckets.delete(key);
}

/**
 * Derive a stable limiter key from request headers. Prefers the left-most
 * x-forwarded-for hop, then x-real-ip; falls back to a single shared global
 * bucket when no client IP is available (fail-closed: an attacker that strips
 * the header just shares one throttled bucket with everyone else).
 */
export function keyFromHeaders(
  headers: { get(name: string): string | null } | null | undefined,
): string {
  if (!headers) return 'global';
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  return 'global';
}

/** Test-only: wipe all buckets. */
export function _resetAll(): void {
  buckets.clear();
}
