import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { isSessionProvider } from '@/lib/sessionCapabilities';
import { startLogin } from '@/lib/server/accounts/engine';

// POST /api/accounts/login {provider, accountId?} — sign an account in (or
// again) at the HUB: Claude = link + pasted code, Codex = device code, Cursor =
// link (run through one agent's Cursor runtime, which keeps nothing). §14.115.
export async function POST(req: Request) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  try {
    const body = await req.json();
    if (!isSessionProvider(body.provider)) throw new Error('Provider required');
    const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : null;
    return NextResponse.json({ attempt: await startLogin(body.provider, accountId) });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
