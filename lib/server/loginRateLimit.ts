// In-memory, per-key login brute-force throttle.
//
// The whole fleet's SSH access sits behind ONE MASTER_PASSWORD, so an
// unthrottled /login is a single-target brute-force surface. This module is a
// PURE, module-level, in-memory limiter (no DB, no I/O): a Map of buckets keyed
// by client (`clientKey`), plus ONE hub-wide failure budget.
//
// Policy: the first FREE_ATTEMPTS consecutive failures are allowed with no
// delay. Each failure beyond that arms an exponential lockout window that grows
// with the consecutive-failure count and is capped at MAX_LOCKOUT_MS. A success
// clears the bucket entirely. Buckets idle past a generous TTL are reaped so the
// Map can't grow unbounded under random-IP spray.
//
// The client key is only as good as its source: a header the CLIENT writes
// would hand an attacker a fresh bucket per attempt. So the socket peer is the
// truth, and forwarding headers count only when that peer is a proxy we sit
// behind (loopback / private address), and then only the hop IT appended (the
// RIGHT-most X-Forwarded-For entry). Spoofing aside, addresses are cheap (an
// IPv6 /64, a botnet): GLOBAL_MAX_FAILURES per GLOBAL_WINDOW_MS across every
// client bounds the guessing rate whatever the key. Reaching it pauses every
// login, the right password included (an accepted guess would tell), while
// signed-in browsers keep their sessions.
//
// The clock is injectable (`now()` arg, default Date.now) so tests are fully
// deterministic without real sleeps. This is app runtime code (not a workflow
// script), so Date.now is available and fine as the default.

import { isIP } from 'node:net';

export const FREE_ATTEMPTS = 5; // failures allowed before any lockout kicks in
const BASE_LOCKOUT_MS = 2_000; // first lockout after the free attempts
export const MAX_LOCKOUT_MS = 5 * 60_000; // cap (5 min) — never lock out forever
const BUCKET_TTL_MS = 60 * 60_000; // reap idle buckets after 1h
const SWEEP_ABOVE_BUCKETS = 10_000; // a full idle sweep once the Map is this big
export const GLOBAL_MAX_FAILURES = 50; // hub-wide failures allowed…
export const GLOBAL_WINDOW_MS = 15 * 60_000; // …per sliding window

// Failure times, oldest first, never more than GLOBAL_MAX_FAILURES: at the
// cap every attempt is refused before its password is checked, so none is
// recorded until the oldest leaves the window.
const globalFailures: number[] = [];
let globalPauseLogged = false;

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
  while (globalFailures.length && now - globalFailures[0] >= GLOBAL_WINDOW_MS) globalFailures.shift();
  if (globalFailures.length >= GLOBAL_MAX_FAILURES) {
    const retryAfterMs = globalFailures[0] + GLOBAL_WINDOW_MS - now;
    if (!globalPauseLogged) {
      globalPauseLogged = true;
      console.warn(`[login] ${GLOBAL_MAX_FAILURES} failed logins within ${GLOBAL_WINDOW_MS / 60_000} min: every login paused for ${Math.ceil(retryAfterMs / 1000)}s`);
    }
    return { allowed: false, retryAfterMs };
  }
  globalPauseLogged = false;
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
  globalFailures.push(now);
  if (globalFailures.length > GLOBAL_MAX_FAILURES) globalFailures.shift();
  if (buckets.size >= SWEEP_ABOVE_BUCKETS) for (const [k, b] of buckets) reapIfStale(b, k, now);
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

/** `::ffff:1.2.3.4` → `1.2.3.4`; anything else trimmed. */
function normalizeAddress(ip: string): string {
  const s = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return mapped ? mapped[1] : s;
}

/** The 8 groups of a VALID IPv6 address (zone dropped, IPv4 tail = 2 groups). */
function ipv6Groups(ip: string): number[] {
  const addr = ip.split('%')[0];
  const part = (s: string) => (s ? s.split(':') : []).flatMap((g) => {
    if (!g.includes('.')) return [parseInt(g, 16)];
    const [a, b, c, d] = g.split('.').map(Number);
    return [(a << 8) | b, (c << 8) | d];
  });
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, ''];
  const h = part(head), t = part(tail);
  return [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
}

/** Loopback or private: a peer that is a reverse proxy we sit behind. */
function isProxyPeer(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const g = ipv6Groups(ip);
  return g.slice(0, 7).every((x) => x === 0) && g[7] === 1 // ::1
    || (g[0] & 0xfe00) === 0xfc00 // fc00::/7
    || (g[0] & 0xffc0) === 0xfe80; // fe80::/10
}

/** One bucket per IPv4 address, per IPv6 /64 (one host owns the whole /64). */
function bucketOf(ip: string): string {
  if (isIP(ip) === 4) return ip;
  return `${ipv6Groups(ip).slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * The limiter key of a login attempt. `peer` = the TCP socket's remote
 * address. A public peer is the client itself: its headers are ignored. A
 * loopback/private peer is our reverse proxy: the right-most X-Forwarded-For
 * entry (the one the proxy appended), else X-Real-IP. No usable address ⇒ one
 * shared `global` bucket (fail-closed).
 */
export function clientKey(
  headers: { get(name: string): string | null } | null | undefined,
  peer: string | null | undefined,
): string {
  const p = peer ? normalizeAddress(peer) : '';
  if (isIP(p) && !isProxyPeer(p)) return bucketOf(p);
  const forwarded = normalizeAddress(headers?.get('x-forwarded-for')?.split(',').pop() ?? '');
  if (isIP(forwarded)) return bucketOf(forwarded);
  const real = normalizeAddress(headers?.get('x-real-ip') ?? '');
  if (isIP(real)) return bucketOf(real);
  return isIP(p) ? bucketOf(p) : 'global';
}

/** Test-only: wipe all buckets and the hub-wide budget. */
export function _resetAll(): void {
  buckets.clear();
  globalFailures.length = 0;
  globalPauseLogged = false;
}
