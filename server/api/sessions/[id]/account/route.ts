import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { switchSessionAccount } from '@/lib/server/accounts/migration';

// POST /api/sessions/[id]/account {accountId} — the next reply comes from that
// account (same provider; shared history ⇒ same conversation). §14.115.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const { id } = await params;
  try {
    const { accountId } = await req.json();
    if (typeof accountId !== 'string') throw new Error('Account required');
    const result = await switchSessionAccount(id, accountId);
    return NextResponse.json({ ok: true, ...result, sync: syncAfter([id]) });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
