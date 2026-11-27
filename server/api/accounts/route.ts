import { requireApiSession } from '@/lib/server/session';
import { isSessionProvider } from '@/lib/sessionCapabilities';
import { listProviderAccounts, removeAccount, renameAccount, reorderAccounts, accountUsage } from '@/lib/server/accounts/engine';
import { migrationBacklog } from '@/lib/server/accounts/migration';
import { seenResetNotices } from '@/lib/server/accounts/resetNotices';

// Hub-owned provider accounts (CLAUDE.md §14.115). Never a credential here.

export async function GET() {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const accounts = listProviderAccounts();
  return Response.json({
    accounts,
    usage: Object.fromEntries(accounts.map((a) => [a.id, accountUsage(a.id)])),
    migration: migrationBacklog(),
    resetNoticesSeen: seenResetNotices(),
  });
}

export async function PATCH(req: Request) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  try {
    const body = await req.json();
    if (typeof body.id === 'string' && typeof body.name === 'string') renameAccount(body.id, body.name);
    else if (isSessionProvider(body.provider) && Array.isArray(body.order) && body.order.every((x: unknown) => typeof x === 'string')) reorderAccounts(body.provider, body.order);
    else throw new Error('Nothing to change');
    return Response.json({ ok: true });
  } catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
}

export async function DELETE(req: Request) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== 'string') return Response.json({ error: 'Account required' }, { status: 400 });
  await removeAccount(id);
  return Response.json({ ok: true });
}
