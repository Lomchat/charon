'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  checkPassword, deriveMasterKey,
  createSession, setSessionKey, SESSION_COOKIE, SESSION_TTL_MS
} from '@/lib/server/auth';
import { seedInitialData } from '@/lib/server/seed';
import { sanitizeNextPath } from '@/lib/nextPath';
import {
  check as rateLimitCheck,
  recordFailure as rateLimitFailure,
  recordSuccess as rateLimitSuccess,
  keyFromHeaders,
} from '@/lib/server/loginRateLimit';

export async function loginAction(_prev: { error?: string } | null, formData: FormData) {
  const password = String(formData.get('password') ?? '');
  // Where to land after login — sanitized to a same-origin path (defaults to
  // "/"). Lets a mobile user logged-out by inactivity return to /m/... instead
  // of the desktop UI.
  const next = sanitizeNextPath(formData.get('next'));
  if (!password) return { error: 'password required' };

  // Brute-force throttle: ONE MASTER_PASSWORD guards the whole fleet, so gate
  // the attempt on a per-IP (or global-fallback) in-memory limiter before
  // touching the password at all.
  const rlKey = keyFromHeaders(await headers());
  const gate = rateLimitCheck(rlKey);
  if (!gate.allowed) {
    const secs = Math.ceil(gate.retryAfterMs / 1000);
    return { error: `too many attempts, retry in ${secs}s` };
  }

  if (!checkPassword(password)) {
    rateLimitFailure(rlKey);
    return { error: 'invalid password' };
  }
  rateLimitSuccess(rlKey);

  // Idempotent seed at first login
  seedInitialData();

  const session = await createSession();
  const key = deriveMasterKey();
  setSessionKey(session.id, key);
  const c = await cookies();
  c.set(SESSION_COOKIE, session.id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  redirect(next);
}
