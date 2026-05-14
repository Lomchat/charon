import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js).*)'],
  runtime: 'nodejs'
};

const PUBLIC_PATHS = ['/login'];
// Routes API qui s'authentifient elles-mêmes (Bearer token, etc.) — le
// middleware les laisse passer sans cookie.
const PUBLIC_API_PATHS = ['/api/sync'];
const SESSION_COOKIE = 'heimdall_session';
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
    res.cookies.set(SESSION_COOKIE, sid, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: false,
      maxAge: SESSION_TTL_SECS
    });
  }
  return res;
}
