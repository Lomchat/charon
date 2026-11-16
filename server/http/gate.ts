import 'server-only';
import { isAuthRequired } from '@/lib/server/authGate.js';
import { apiTokenMatches, apiTokenRouteAllowed, isBearerAttempt } from '@/lib/server/apiToken';
import { getSession, SESSION_COOKIE, SESSION_TTL_MS, touchSession } from '@/lib/server/auth';
import { getSetting } from '@/lib/server/hub/settings';
import { readCookie } from '@/lib/server/requestContext';

// THE HTTP auth gate (§12): every page and API request passes here before its
// handler; static assets and the shell WebSocket (server.js) do not.
//
// Order matters:
//   1. self-authenticating API paths pass (`/api/sync` Bearer, `/api/health`,
//      `/api/preview` capability URL, §14.110);
//   2. an API request that PRESENTS a Bearer is judged on it alone: the right
//      token on an allow-listed route passes, anything else is a 401 — never
//      a fall-through to the cookie;
//   3. cookie-authenticated API mutations must come from our own origin when
//      they carry an Origin (CSRF) — still on with authentication off;
//   4. auth off (`CHARON_AUTH_REQUIRED=false`) ⇒ pass;
//   5. a valid session cookie passes and is re-sent (sliding TTL, the DB row
//      refreshed at most every 30 min); else API → 401, page → /login?next=.

const PUBLIC_PAGES = ['/login'];
const PUBLIC_API = ['/api/sync', '/api/health', '/api/preview'];
const TTL_SECS = SESSION_TTL_MS / 1000;
const REFRESH_AFTER_SECS = 30 * 60;

export type GateResult =
  | { pass: true; setCookie: string | null }
  | { pass: false; response: Response };

const under = (pathname: string, p: string) => pathname === p || pathname.startsWith(p + '/');
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** The session cookie as the hub sets it (create, refresh). */
export function sessionCookie(token: string, maxAgeSecs = TTL_SECS): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', `Max-Age=${maxAgeSecs}`,
    'HttpOnly', 'SameSite=Lax',
  ];
  // Over HTTPS only in production; local dev serves plain http://127.0.0.1.
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/** Same-origin check: an absent Origin passes (curl, native clients — they
 *  carry no ambient cookie); a present one must name the request Host, a
 *  forwarded host or the configured public URL. */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  let oHost: string;
  try { oHost = new URL(origin).host; } catch { return false; }
  const allowed = new Set<string>();
  const host = req.headers.get('host');
  if (host) allowed.add(host);
  const xfh = req.headers.get('x-forwarded-host');
  if (xfh) for (const part of xfh.split(',')) allowed.add(part.trim());
  try {
    const pu = getSetting('app.public_url');
    if (pu) allowed.add(new URL(pu).host);
  } catch { /* no public URL configured */ }
  return allowed.has(oHost);
}

/** The browser-facing origin: the reverse proxy's (X-Forwarded-*), else the
 *  request's own (direct http access: Docker, dev). */
export function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || url.host;
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(/:$/, '');
  return `${proto}://${host}`;
}

/** The login page URL for a page request, `?next=` carrying where it was going. */
export function loginRedirect(req: Request): Response {
  const url = new URL(req.url);
  const login = new URL(`${publicOrigin(req)}/login`);
  const dest = url.pathname + url.search;
  if (dest && dest !== '/') login.searchParams.set('next', dest);
  return new Response(null, { status: 307, headers: { Location: login.toString() } });
}

export async function gate(req: Request): Promise<GateResult> {
  const pathname = new URL(req.url).pathname;
  if (PUBLIC_API.some((p) => under(pathname, p))) return { pass: true, setCookie: null };
  const isApi = pathname.startsWith('/api/');
  const isPublic = PUBLIC_PAGES.some((p) => under(pathname, p));

  const authorization = req.headers.get('authorization');
  if (isApi && authorization && isBearerAttempt(authorization)) {
    return apiTokenMatches(authorization) && apiTokenRouteAllowed(req.method, pathname)
      ? { pass: true, setCookie: null }
      : { pass: false, response: new Response('unauthorized', { status: 401 }) };
  }

  if (isApi && MUTATING.has(req.method) && !originAllowed(req)) {
    return { pass: false, response: new Response('cross-origin request rejected', { status: 403 }) };
  }

  if (!isAuthRequired()) return { pass: true, setCookie: null };

  const sid = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
  if (sid) {
    const session = await getSession(sid);
    if (session) {
      const remaining = session.expiresAt - Math.floor(Date.now() / 1000);
      if (remaining < TTL_SECS - REFRESH_AFTER_SECS) await touchSession(sid);
      return { pass: true, setCookie: sessionCookie(sid) };
    }
  }
  if (isApi) return { pass: false, response: new Response('unauthorized', { status: 401 }) };
  if (isPublic) return { pass: true, setCookie: null };
  return { pass: false, response: loginRedirect(req) };
}
