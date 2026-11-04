import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { cancelLogin, loginStatus, submitLoginCode } from '@/lib/server/accounts/engine';

type Ctx = { params: Promise<{ attempt: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const attempt = loginStatus((await params).attempt);
  return attempt ? NextResponse.json({ attempt }) : NextResponse.json({ error: 'This sign-in attempt is over — start again.' }, { status: 404 });
}

/** Claude: the code shown after signing in (`code#state`). */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  try {
    const { code } = await req.json();
    if (typeof code !== 'string' || !code.trim()) throw new Error('Paste the code first');
    return NextResponse.json({ attempt: await submitLoginCode((await params).attempt, code.trim().slice(0, 4096)) });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  await cancelLogin((await params).attempt);
  return NextResponse.json({ ok: true });
}
