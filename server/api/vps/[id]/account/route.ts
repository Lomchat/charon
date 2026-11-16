import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { refreshClaudeLoginStatus } from '@/lib/server/agent/claudeLoginCheck';
import { getAgentClient } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalVpsStatus } from '@/lib/server/agent/sessionOps';
import { providerLoginPatch, SESSION_PROVIDERS, type SessionProvider } from '@/lib/sessionCapabilities';
import type { ProviderAccountResponse } from '@/lib/types/api';
import { acceptCursorIdentity, requireAccountProfile, readProfileStatus, signOutAccountProfile } from '@/lib/server/agent/accountProfiles';
import { profileStatuses, statusKey } from '@/lib/server/agent/accountProfileState';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Refresh public account metadata, never credentials or usage counters. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const body = await req.json().catch(() => null);
  if (!SESSION_PROVIDERS.includes(body?.provider)) {
    return NextResponse.json({ ok: false, error: 'Unknown provider' }, { status: 400 });
  }
  const provider: SessionProvider = body.provider;
  const { id } = await params;
  const v = db.select().from(vpsTable).where(eq(vpsTable.id, id)).get();
  if (!v) return NextResponse.json({ ok: false, error: 'VPS not found' }, { status: 404 });
  const result: ProviderAccountResponse = { ok: true };
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  try {
    const profile = requireAccountProfile(id, provider, body?.profile ?? 'default');
    if (profile.id !== 'default') {
      const status = await readProfileStatus(id, provider, profile.id, true);
      return NextResponse.json({ ok: true, loggedIn: status.logged_in, email: status.email, name: text(status.display_name),
        organization: status.organization, subscriptionType: status.subscription_type,
        authMethod: status.auth_method, checkedAt: Math.floor(Date.now() / 1000) });
    }
    switch (provider) {
      case 'claude': {
        const r = await refreshClaudeLoginStatus(v);
        if (!r.ok) throw new Error('Could not verify account');
        result.loggedIn = r.loggedIn;
        result.email = text(r.account?.email);
        result.organization = text(r.account?.orgName);
        result.subscriptionType = text(r.account?.subscriptionType);
        result.authMethod = text(r.account?.authMethod);
        // The account's own name, from the last probe of this same login.
        const probed = profileStatuses.get(statusKey(id, provider));
        if (probed?.logged_in && result.email && probed.email?.toLowerCase() === result.email.toLowerCase()) {
          result.name = text(probed.display_name);
        }
        break;
      }
      case 'codex':
      case 'cursor': {
        const methods = { codex: 'codex_auth_status', cursor: 'cursor_auth_status' } as const;
        const r = await getAgentClient(v).call<{
          ok: boolean; logged_in?: boolean; email?: string; subscription_type?: string;
          auth_method?: string; expires_at_ms?: number; source?: string;
        }>(methods[provider], {});
        if (!r?.ok || typeof r.logged_in !== 'boolean') throw new Error('Could not verify account');
        result.loggedIn = r.logged_in;
        if (r.logged_in) {
          result.email = text(r.email);
          result.subscriptionType = text(r.subscription_type);
          result.authMethod = text(r.auth_method) ?? (r.source === 'env' ? 'api_key' : undefined);
          if (typeof r.expires_at_ms === 'number' && Number.isFinite(r.expires_at_ms)
              && r.expires_at_ms > 0 && r.expires_at_ms < 8.64e15) result.expiresAtMs = r.expires_at_ms;
        }
        break;
      }
    }
    result.checkedAt = Math.floor(Date.now() / 1000);
    const patch = providerLoginPatch(provider, result.loggedIn ? 1 : 0, result.checkedAt);
    db.update(vpsTable).set(patch).where(eq(vpsTable.id, id)).run();
    // After the login flag lands: the header names the Cursor login by its email.
    if (provider === 'cursor') acceptCursorIdentity(id, result.loggedIn === true, result.email);
    if (v.agentStatus === 'ok') emitGlobalVpsStatus(id, 'ok', patch);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const tooOld = (e as { code?: number })?.code === -32601;
    return NextResponse.json({ ok: false, error: tooOld
      ? 'Update the agent to view account information'
      : 'Account information unavailable. Try refreshing.' }, { status: tooOld ? 409 : 502 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const query = new URL(req.url).searchParams;
  const provider = query.get('provider');
  if (provider !== 'claude' && provider !== 'codex') return NextResponse.json({ error: 'Additional accounts are unavailable for this provider' }, { status: 400 });
  const v = db.select().from(vpsTable).where(eq(vpsTable.id, id)).get();
  if (!v) return NextResponse.json({ error: 'VPS not found' }, { status: 404 });
  try {
    // Extra profiles only; the default account keeps its provider's route.
    await signOutAccountProfile(id, provider, query.get('profile') ?? '');
    return NextResponse.json({ ok: true });
  } catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 }); }
}
