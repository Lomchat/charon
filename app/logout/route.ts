import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { dropSession, SESSION_COOKIE } from '@/lib/server/auth';

export async function POST(req: Request) {
  const c = await cookies();
  const sid = c.get(SESSION_COOKIE)?.value;
  if (sid) await dropSession(sid);
  c.delete(SESSION_COOKIE);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost';
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  return NextResponse.redirect(`${proto}://${host}/login`, 303);
}
