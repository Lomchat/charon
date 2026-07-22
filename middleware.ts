import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const config = {
  // notif.wav: notification sound, a non-sensitive static asset loaded by
  // `new Audio()`. Excluded so the fetch isn't 307-redirected to /login
  // (which would return HTML and break audio decoding). If you rename the
  // sound file (see NOTIF_SOUND_URL in ClaudePanel.tsx), update this too.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|notif.wav).*)'],
  runtime: 'nodejs'
};

const PUBLIC_PATHS = ['/login'];
// API routes that authenticate themselves (Bearer token, etc.) or that need
// to be reachable without a session — the middleware lets them through
// without a cookie.
// - /api/sync : Bearer-authenticated upsert endpoint.
// - /api/health : public liveness probe for reverse proxies / Docker.
const PUBLIC_API_PATHS = ['/api/sync', '/api/health'];
const SESSION_COOKIE = 'charon_session';
const SESSION_TTL_SECS = 24 * 60 * 60;

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/_next') || pathname === '/favicon.ico') {
    return NextResponse.next();
  }
  if (PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
  const isApi = pathname.startsWith('/api/');
  const sid = req.cookies.get(SESSION_COOKIE)?.value;

  // CSRF hardening (P1.4): cookie-authenticated API mutations must come from
  // our own origin. Browsers ALWAYS attach Origin to cross-site fetches; when
  // present it must match the request Host / a forwarded host / the
  // configured public URL. Origin-less requests (curl, native tools) pass —
  // the session cookie is still required, and non-browser clients don't
  // carry ambient cookies. /api/sync is Bearer-authed server-to-server
  // (already excluded above via PUBLIC_API_PATHS).
  const MUTATING = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE';
  if (isApi && MUTATING) {
    const origin = req.headers.get('origin');
    if (origin) {
      let oHost: string | null = null;
      try { oHost = new URL(origin).host; } catch {}
      const allowed = new Set<string>();
      const h = req.headers.get('host'); if (h) allowed.add(h);
      const xfh = req.headers.get('x-forwarded-host');
      if (xfh) for (const part of xfh.split(',')) allowed.add(part.trim());
      try {
        const { getSetting } = await import('@/lib/server/claude/settings');
        const pu = getSetting('app.public_url');
        if (pu) allowed.add(new URL(pu).host);
      } catch {}
      if (!oHost || !allowed.has(oHost)) {
        return new NextResponse('cross-origin request rejected', { status: 403 });
      }
    }
  }

  let valid = false;
  if (sid) {
    const { getSession, touchSession } = await import('@/lib/server/auth');
    const session = await getSession(sid);
    if (session) {
      // Sliding-TTL refresh, THROTTLED (P1.5): only rewrite expires_at when
      // the last refresh is >30 min old (i.e. remaining TTL dipped below
      // TTL-30min). Untouched, every authed request — 5s polling included —
      // was one SQLite UPDATE in the WAL. Pass the RAW cookie token —
      // session.id is the HASHED row id and touchSession hashes its arg.
      const remaining = session.expiresAt - Math.floor(Date.now() / 1000);
      if (remaining < SESSION_TTL_SECS - 30 * 60) {
        await touchSession(sid);
      }
      valid = true;
    }
  }

  const res = valid
    ? NextResponse.next()
    : (() => {
        if (isApi) return new NextResponse('unauthorized', { status: 401 });
        if (isPublic) return NextResponse.next();
        const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost';
        const proto = req.headers.get('x-forwarded-proto') || 'https';
        const loginUrl = new URL(`${proto}://${host}/login`);
        // Preserve where the user was headed so that after re-login we send
        // them back there (e.g. a mobile user on /m/... must not be bounced to
        // the desktop "/" UI). `pathname + search` is inherently same-origin;
        // the login flow re-validates it through sanitizeNextPath. Skip "/"
        // (nothing to restore) to keep the login URL clean.
        const dest = pathname + (req.nextUrl.search || '');
        if (dest && dest !== '/') loginUrl.searchParams.set('next', dest);
        return NextResponse.redirect(loginUrl);
      })();

  if (valid && sid) {
    // `secure: true` in prod (cookie only sent over HTTPS — protects against
    // a leak if the user types http://). In local dev the server runs on
    // http://127.0.0.1, keep it false so login still works.
    res.cookies.set(SESSION_COOKIE, sid, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_SECS,
    });
  }
  return res;
}
