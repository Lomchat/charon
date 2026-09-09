import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { dropSession, SESSION_COOKIE } from '@/lib/server/auth';
import { isAuthRequired } from '@/lib/server/authGate.js';

export async function POST(req: Request) {
  const c = await cookies();
  const sid = c.get(SESSION_COOKIE)?.value;
  if (sid) await dropSession(sid);
  c.delete(SESSION_COOKIE);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost';
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  // §12: with authentication off, /login redirects straight back to "/" — go
  // there directly rather than bouncing through a page that cannot log anyone
  // out. Any leftover cookie from a password-protected past is still dropped.
  const dest = isAuthRequired() ? '/login' : '/';
  return NextResponse.redirect(`${proto}://${host}${dest}`, 303);
}
