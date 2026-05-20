import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js).*)'],
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

  let valid = false;
  if (sid) {
    const { getSession, touchSession } = await import('@/lib/server/auth');
    const session = await getSession(sid);
    if (session) {
      await touchSession(session.id);
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
        return NextResponse.redirect(`${proto}://${host}/login`);
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
