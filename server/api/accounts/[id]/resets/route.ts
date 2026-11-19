import { requireApiSession } from '@/lib/server/session';
import { claimAccountReset } from '@/lib/server/accounts/engine';

type Ctx = { params: Promise<{ id: string }> };

/** Spend one banked limit reset of `grantId` (§14.126). Irreversible: the
 *  engine single-flights it per account and only spends a grant it was shown. */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const body = await req.json().catch(() => null) as { grantId?: unknown } | null;
  const grantId = typeof body?.grantId === 'string' ? body.grantId : '';
  if (!grantId || grantId.length > 128) return Response.json({ error: 'grantId required' }, { status: 400 });
  return Response.json(await claimAccountReset((await params).id, grantId));
}
