import 'server-only';
import {
  checkPassword, createSession, deriveMasterKey, dropSession, SESSION_COOKIE, setSessionKey,
} from '@/lib/server/auth';
import { isAuthRequired } from '@/lib/server/authGate.js';
import { seedInitialData } from '@/lib/server/seed';
import { sanitizeNextPath } from '@/lib/nextPath';
import { readCookie } from '@/lib/server/requestContext';
import {
  check as rateLimitCheck,
  clientKey,
  recordFailure as rateLimitFailure,
  recordSuccess as rateLimitSuccess,
} from '@/lib/server/loginRateLimit';
import { clearSessionCookie, originAllowed, publicOrigin, sessionCookie } from './gate';

// POST /login (web/login.tsx posts the form with fetch): one MASTER_PASSWORD
// guards the whole fleet, so the attempt is throttled per client BEFORE the
// password is looked at (`peer` = the socket's remote address, see
// loginRateLimit § clientKey). Answers JSON: `{ ok, next }` with the session
// cookie, or `{ error }`. Same-origin only (the form is ours; a cross-site
// POST is a login-CSRF attempt).

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export async function loginPost(req: Request, peer: string | null = null): Promise<Response> {
  if (!originAllowed(req)) return json({ error: 'cross-origin request rejected' }, 403);
  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: 'bad request' }, 400); }
  const next = sanitizeNextPath(form.get('next'));
  // §12: no password on this hub. A tab opened before the switch flipped can
  // still post: send it on. Nothing below may run without a password
  // (checkPassword / deriveMasterKey THROW when MASTER_PASSWORD is unset).
  if (!isAuthRequired()) return json({ ok: true, next });

  const password = String(form.get('password') ?? '');
  if (!password) return json({ error: 'password required' }, 400);

  const rlKey = clientKey(req.headers, peer);
  const gate = rateLimitCheck(rlKey);
  if (!gate.allowed) {
    return json({ error: `too many attempts, retry in ${Math.ceil(gate.retryAfterMs / 1000)}s` }, 429);
  }
  if (!checkPassword(password)) {
    rateLimitFailure(rlKey);
    return json({ error: 'invalid password' }, 401);
  }
  rateLimitSuccess(rlKey);

  seedInitialData();   // idempotent
  const session = await createSession();
  setSessionKey(session.id, deriveMasterKey());
  return json({ ok: true, next }, 200, { 'Set-Cookie': sessionCookie(session.id) });
}

/** POST /logout: drops the session row and the cookie. */
export async function logoutPost(req: Request): Promise<Response> {
  const sid = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
  if (sid) await dropSession(sid);
  // §12: with authentication off, /login would bounce straight back to "/".
  const dest = isAuthRequired() ? '/login' : '/';
  return new Response(null, {
    status: 303,
    headers: { Location: `${publicOrigin(req)}${dest}`, 'Set-Cookie': clearSessionCookie() },
  });
}
