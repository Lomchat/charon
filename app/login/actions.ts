'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  checkPassword, deriveMasterKey,
  createSession, setSessionKey, SESSION_COOKIE, SESSION_TTL_MS
} from '@/lib/server/auth';
import { seedInitialData } from '@/lib/server/seed';

export async function loginAction(_prev: { error?: string } | null, formData: FormData) {
  const password = String(formData.get('password') ?? '');
  if (!password) return { error: 'mot de passe requis' };

  if (!checkPassword(password)) return { error: 'mot de passe invalide' };

  // Idempotent seed at first login
  seedInitialData();

  const session = await createSession();
  const key = deriveMasterKey();
  setSessionKey(session.id, key);
  const c = await cookies();
  c.set(SESSION_COOKIE, session.id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  redirect('/');
}
