import 'server-only';
import { ensureUser, getSession, getSessionKey, SESSION_COOKIE } from './auth';
import { isAuthRequired } from './authGate.js';
import { API_TOKEN_SESSION_ID, apiTokenMatches } from './apiToken';
import { currentRequest, requestCookie } from './requestContext';

export type SessionContext = {
  userId: number;
  sessionId: string;
  aesKey: Buffer | null;
};

// Session id handed out when the hub-wide auth switch is off (§12). Not a
// token and never stored: `getSessionKey` falls back to the env-derived AES
// key for an id it has never seen, so encrypted settings still decrypt, and
// no caller reads this field for anything but the gate itself.
export const AUTH_DISABLED_SESSION_ID = 'auth-disabled';

// Read-only lookup of the CURRENT request's session (requestContext.ts).
// Cookie refresh is the HTTP gate's (server/http/gate.ts).
export async function readSession(): Promise<SessionContext | null> {
  // §12: with authentication switched off there is no cookie to read. Answer
  // here rather than teaching each of the ~250 `requireApiSession()` gates
  // about the switch — one place to reason about, and a route can never
  // forget it. The gate has already let the request through.
  if (!isAuthRequired()) {
    return {
      userId: await ensureUser(),
      sessionId: AUTH_DISABLED_SESSION_ID,
      aesKey: getSessionKey(AUTH_DISABLED_SESSION_ID),
    };
  }
  const sid = requestCookie(SESSION_COOKIE);
  const session = sid ? await getSession(sid) : null;
  if (session) {
    return {
      userId: session.userId,
      sessionId: session.id,
      aesKey: getSessionKey(session.id)
    };
  }
  // §12 automation token. The gate has already confined it to the allow-list
  // in apiToken.ts; like the auth-off branch, the id is never stored.
  if (apiTokenMatches(currentRequest()?.headers.get('authorization'))) {
    return {
      userId: await ensureUser(),
      sessionId: API_TOKEN_SESSION_ID,
      aesKey: getSessionKey(API_TOKEN_SESSION_ID),
    };
  }
  return null;
}

export async function requireApiSession(): Promise<SessionContext | Response> {
  const s = await readSession();
  if (!s) return new Response('unauthorized', { status: 401 });
  return s;
}
