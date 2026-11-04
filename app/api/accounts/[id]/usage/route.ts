import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { accountUsage, pollAccountUsage } from '@/lib/server/accounts/engine';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  return NextResponse.json({ usage: accountUsage((await params).id) });
}

/** ↻ — read the account's gauges now (the 2-min floor and Retry-After still hold). */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  return NextResponse.json({ usage: await pollAccountUsage((await params).id, { force: true }) });
}
