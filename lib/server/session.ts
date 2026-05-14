import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession, getSessionKey, SESSION_COOKIE } from './auth';

export type SessionContext = {
  userId: number;
  sessionId: string;
  aesKey: Buffer | null;
};

// Read-only session lookup. Cookie refresh is handled by middleware.
export async function readSession(): Promise<SessionContext | null> {
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
