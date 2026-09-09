import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ensureUser, getSession, getSessionKey, SESSION_COOKIE } from './auth';
import { isAuthRequired } from './authGate.js';

export type SessionContext = {
  userId: number;
  sessionId: string;
  aesKey: Buffer | null;
};

// Session id handed out when the hub-wide auth switch is off (§12). Not a
// token and never stored: `getSessionKey` falls back to the env-derived AES
// key for an id it has never seen, so encrypted settings still decrypt, and
// no caller reads this field for anything but the gate itself.
const AUTH_DISABLED_SESSION_ID = 'auth-disabled';

// Read-only session lookup. Cookie refresh is handled by middleware.
export async function readSession(): Promise<SessionContext | null> {
  // §12: with authentication switched off there is no cookie to read. Answer
  // here rather than teaching each of the ~250 `requireApiSession()` gates
  // about the switch — one place to reason about, and a route can never
  // forget it. The middleware has already let the request through.
  if (!isAuthRequired()) {
    return {
      userId: await ensureUser(),
      sessionId: AUTH_DISABLED_SESSION_ID,
      aesKey: getSessionKey(AUTH_DISABLED_SESSION_ID),
    };
  }
  const c = await cookies();
  const sid = c.get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  const session = await getSession(sid);
  if (!session) return null;
  return {
    userId: session.userId,
    sessionId: session.id,
    aesKey: getSessionKey(session.id)
  };
}

export async function requireSession(): Promise<SessionContext> {
  const s = await readSession();
  if (!s) redirect('/login');
  return s;
}

export async function requireApiSession(): Promise<SessionContext | Response> {
  const s = await readSession();
  if (!s) return new Response('unauthorized', { status: 401 });
  return s;
}
