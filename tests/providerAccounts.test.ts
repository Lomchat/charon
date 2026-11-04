import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/db/schema';

// Hub-owned provider accounts (CLAUDE.md §14.115).

const fake = vi.hoisted(() => ({
  call: vi.fn(), emitProfiles: vi.fn(), emitUsage: vi.fn(), emitRuntime: vi.fn(), restart: vi.fn(), listChanged: vi.fn(),
  clients: [] as { vps: { id: string }; status: string; hello: Record<string, unknown> | null; call: (...a: any[]) => unknown }[],
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const tables = await import('@/lib/db/schema');
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: tables });
  migrate(db, { migrationsFolder: './drizzle' });
  return { ...tables, db };
});
vi.mock('@/lib/server/masterKey', () => ({ getEnvAesKey: () => Buffer.alloc(32, 7) }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: (id: string) => fake.clients.find((c) => c.vps.id === id) ?? { vps: { id }, status: 'disconnected', hello: null, call: fake.call },
  listAgentClients: () => fake.clients,
}));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  emitGlobalAccountProfiles: fake.emitProfiles, emitGlobalAccountUsage: fake.emitUsage,
  emitGlobalVpsRuntimeFromDb: fake.emitRuntime, emitGlobalSessionListChanged: fake.listChanged, restartSession: fake.restart,
}));
vi.mock('@/lib/server/hub/bgTaskState', () => ({ runningBgTasksIfWarm: () => [], pruneStaleBgTasks: () => false }));

import { db } from '@/lib/db';
import { accountKeyFor, agentAccount, getAccountRow, openSecret, sealSecret, type ClaudeSecret, type CodexSecret } from '@/lib/server/accounts/store';
import { claudeAuthorize, claudeExchange, ProviderHttpError } from '@/lib/server/accounts/oauth';

const NOW = Date.UTC(2026, 10, 4, 12);

function claudeRow(id: string, over: Partial<typeof schema.providerAccounts.$inferInsert> = {}, secret: Partial<ClaudeSecret> = {}) {
  const s: ClaudeSecret = { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: NOW + 30 * 60_000, scopes: ['user:inference'],
    refreshTokenExpiresAt: NOW + 20 * 86_400_000, subscriptionType: 'max', rateLimitTier: 'tier', oauthAccount: { accountUuid: 'u' }, ...secret };
  db.insert(schema.providerAccounts).values({ id, provider: 'claude', credentials: sealSecret(s), accountKey: `key-${id}`, email: `${id}@x.test`,
    accessExpiresAt: s.expiresAt, loginExpiresAt: s.refreshTokenExpiresAt ?? null, status: 'ok', ...over }).run();
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(() => {
  vi.useRealTimers();
  fake.call.mockReset(); fake.emitProfiles.mockReset(); fake.emitUsage.mockReset(); fake.emitRuntime.mockReset();
  fake.restart.mockReset(); fake.listChanged.mockReset();
  fake.clients = [];
  db.delete(schema.agentSessions).run();
  db.delete(schema.providerAccounts).run();
  db.delete(schema.vps).run();
  db.insert(schema.vps).values([
    { id: 'a', name: 'A', ip: '192.0.2.1', sshUser: 'u', agentStatus: 'ok' },
    { id: 'b', name: 'B', ip: '192.0.2.2', sshUser: 'u', agentStatus: 'ok' },
  ]).run();
  delete (globalThis as { _accountsEngine?: unknown })._accountsEngine;
  delete (globalThis as { _accountsMigration?: unknown })._accountsMigration;
});

describe('vault and identity', () => {
  it('derives the SAME identity hash the agent computes (account_profiles._identity)', () => {
    // python: sha256(json.dumps([...], separators=(',',':')))
    expect(accountKeyFor('claude', { accountUuid: 'acc-uuid', organizationUuid: 'org-uuid' }))
      .toBe('37c1ea7ed79e4a0192ea86d4fbe46d6287ac3cc25e5bb4570501efb4df5d0cc5');
    expect(accountKeyFor('codex', { accountId: 'acct-1', email: 'User@Example.com' }))
      .toBe('63091f051bafb5580b3d93b4cd16410353a9d9f935e3b6f6362333e37fb98731');
    expect(accountKeyFor('claude', { accountUuid: 'x' })).toBeNull();
  });

  it('seals credentials and hands agents only the short-lived part', () => {
    claudeRow('aaaaaaaaaaaaaaaa');
    const row = getAccountRow('aaaaaaaaaaaaaaaa')!;
    expect(row.credentials).not.toContain('rt-old');
    expect(openSecret<ClaudeSecret>(row).refreshToken).toBe('rt-old');
    const pushed = agentAccount(row);
    expect(JSON.stringify(pushed)).not.toContain('rt-old');
    expect(pushed.credentials).toMatchObject({ accessToken: 'at-old', subscriptionType: 'max' });
  });
});

describe('Claude OAuth at the hub', () => {
  it('builds the CLI authorize link with PKCE', () => {
    const a = claudeAuthorize();
    const u = new URL(a.url);
    expect(u.origin + u.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(u.searchParams.get('scope')).toContain('user:inference');
    expect(u.searchParams.get('state')).toBe(a.state);
  });

  it('refuses a code from another attempt before calling anyone', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(claudeExchange('code#other-state', claudeAuthorize())).rejects.toThrow(/another sign-in attempt/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('classifies a dead login apart from a transient failure', () => {
    expect(new ProviderHttpError('x', 400, 'invalid_grant').revoked).toBe(true);
    expect(new ProviderHttpError('x', 503).revoked).toBe(false);
  });
});

describe('refresh engine', () => {
  it('refreshes, persists BEFORE pushing, and pushes the new token to every capable agent', async () => {
    claudeRow('aaaaaaaaaaaaaaaa');
    const order: string[] = [];
    const call = vi.fn(async (method: string, params: { accounts: { credentials: { accessToken: string } }[] }) => {
      // The push sees the persisted row: the new token is already in the vault.
      order.push(`${method}:${openSecret<ClaudeSecret>(getAccountRow('aaaaaaaaaaaaaaaa')!).accessToken}:${params.accounts[0].credentials.accessToken}`);
      return { ok: true };
    });
    fake.clients = [
      { vps: { id: 'a' }, status: 'connected', hello: { global_accounts: true }, call },
      { vps: { id: 'b' }, status: 'connected', hello: {}, call }, // old agent: no push
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {
      access_token: 'at-new', refresh_token: 'rt-new', expires_in: 28_800, refresh_token_expires_in: 1_000_000, scope: 'user:inference user:profile',
    }));
    const { refreshAccount } = await import('@/lib/server/accounts/engine');
    const row = await refreshAccount('aaaaaaaaaaaaaaaa');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://platform.claude.com/v1/oauth/token');
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-old' });
    expect(openSecret<ClaudeSecret>(row!)).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
    expect(row!.status).toBe('ok');
    expect(order).toEqual(['accounts_set:at-new:at-new']);
    fetchSpy.mockRestore();
  });

  it('marks a revoked login expired (sign in again) and the VPS launchers signed out', async () => {
    claudeRow('aaaaaaaaaaaaaaaa');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(400, { error: 'invalid_grant', error_description: 'Refresh token expired' }));
    const { refreshAccount, syncVpsLoginColumns } = await import('@/lib/server/accounts/engine');
    syncVpsLoginColumns();
    expect(db.select().from(schema.vps).all().map((v) => v.claudeLoggedIn)).toEqual([1, 1]);
    const row = await refreshAccount('aaaaaaaaaaaaaaaa');
    expect(row!.status).toBe('expired');
    expect(row!.lastError).toMatch(/Refresh token expired/);
    expect(db.select().from(schema.vps).all().map((v) => v.claudeLoggedIn)).toEqual([0, 0]);
    expect(fake.emitRuntime).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('keeps a transient failure retrying without signing anyone out', async () => {
    claudeRow('aaaaaaaaaaaaaaaa');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(503, { error: 'overloaded' }));
    const { refreshAccount } = await import('@/lib/server/accounts/engine');
    const row = await refreshAccount('aaaaaaaaaaaaaaaa');
    expect(row!.status).toBe('error');
    expect(openSecret<ClaudeSecret>(row!).refreshToken).toBe('rt-old');
    fetchSpy.mockRestore();
  });

  it('single-flights concurrent refreshes of one account (one rotation, never two)', async () => {
    claudeRow('aaaaaaaaaaaaaaaa');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(200, {
      access_token: 'at-new', refresh_token: 'rt-new', expires_in: 28_800,
    }));
    const { refreshAccount } = await import('@/lib/server/accounts/engine');
    await Promise.all([refreshAccount('aaaaaaaaaaaaaaaa'), refreshAccount('aaaaaaaaaaaaaaaa')]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('refreshes Codex days ahead but never before the provider allows it', async () => {
    const access = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000), iat: 0 })).toString('base64url')}.s`;
    const secret: CodexSecret = { idToken: 'h.e30.s', accessToken: access(Date.now() + 86_400_000), refreshToken: 'rt', accountId: 'acct' };
    db.insert(schema.providerAccounts).values({ id: 'cccccccccccccccc', provider: 'codex', credentials: sealSecret(secret), accountKey: 'k',
      accessExpiresAt: Date.now() + 86_400_000, earliestRefreshAt: Date.now() + 3_600_000, status: 'ok' }).run();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { access_token: access(Date.now() + 10 * 86_400_000), refresh_token: 'rt2' }));
    const engine = await import('@/lib/server/accounts/engine');
    engine.ensureAccountsEngine();
    await new Promise((r) => setTimeout(r, 5_200));
    expect(fetchSpy).not.toHaveBeenCalledWith('https://auth.openai.com/oauth/token', expect.anything());
    fetchSpy.mockRestore();
  }, 10_000);
});

describe('sessions on hub accounts', () => {
  function legacySession(id: string, vpsId: string, status: string, config: Record<string, unknown> = {}) {
    db.insert(schema.agentSessions).values({ id, vpsId, cwd: '/srv/app', status, kind: 'claude', nativeSessionId: null,
      providerConfig: JSON.stringify(config) }).run();
  }

  it('projects every account on every VPS, and new sessions default to the first usable one', async () => {
    claudeRow('aaaaaaaaaaaaaaaa', { position: 1 });
    claudeRow('bbbbbbbbbbbbbbbb', { position: 0, status: 'expired' });
    const { listAccountProfiles } = await import('@/lib/server/agent/accountProfiles');
    const listed = listAccountProfiles();
    expect(listed.filter((p) => p.id === 'aaaaaaaaaaaaaaaa').map((p) => p.vpsId).sort()).toEqual(['a', 'b']);
    expect(listed.some((p) => p.id === 'default')).toBe(false);
    expect(listed.find((p) => p.id === 'bbbbbbbbbbbbbbbb')?.loggedIn).toBe(false);
    const { defaultAccountFor } = await import('@/lib/server/accounts/store');
    expect(defaultAccountFor('claude')).toBe('aaaaaaaaaaaaaaaa');
    expect(defaultAccountFor('codex')).toBeNull();
  });

  it('moves a legacy session only to ITS account, and restarts a running one only when quiet', async () => {
    claudeRow('aaaaaaaaaaaaaaaa', { accountKey: 'key-of-vps-a' });
    const { setSetting } = await import('@/lib/server/hub/settings');
    setSetting('accounts.default_keys', JSON.stringify({ 'a:claude:default': 'key-of-vps-a', 'b:claude:default': 'someone-else' }));
    legacySession('s1', 'a', 'sleeping');
    legacySession('s2', 'b', 'sleeping');
    legacySession('s3', 'a', 'active');
    db.update(schema.agentSessions).set({ scheduledTasksJson: JSON.stringify({ tasks: [{ id: 't', cron: '* * * * *', recurring: true, prompt: 'p', nextFireAt: Date.now() + 60_000 }] }) })
      .run();
    fake.clients = [{ vps: { id: 'a' }, status: 'connected', hello: { global_accounts: true }, call: vi.fn(async () => ({ ok: true, found: {} })) }];
    const { runMigration } = await import('@/lib/server/accounts/migration');
    await runMigration();
    const cfg = (id: string) => JSON.parse(db.select().from(schema.agentSessions).all().find((r) => r.id === id)!.providerConfig!);
    expect(cfg('s1').accountProfile).toBe('aaaaaaaaaaaaaaaa');
    expect(cfg('s2').accountProfile).toBeUndefined(); // its login is not here: untouched
    expect(cfg('s3').accountProfile).toBeUndefined(); // a scheduled task fires within 5 min: not now
    expect(fake.restart).not.toHaveBeenCalled();
  });

  it('switches a session to another account of its provider, refusing mid-turn', async () => {
    claudeRow('aaaaaaaaaaaaaaaa');
    claudeRow('bbbbbbbbbbbbbbbb');
    db.insert(schema.agentSessions).values({ id: 's1', vpsId: 'a', cwd: '/srv/app', status: 'thinking', kind: 'claude',
      providerConfig: JSON.stringify({ accountProfile: 'aaaaaaaaaaaaaaaa' }) }).run();
    const { switchSessionAccount } = await import('@/lib/server/accounts/migration');
    await expect(switchSessionAccount('s1', 'bbbbbbbbbbbbbbbb')).rejects.toThrow(/current turn/);
    db.update(schema.agentSessions).set({ status: 'active' }).run();
    await expect(switchSessionAccount('s1', 'bbbbbbbbbbbbbbbb')).resolves.toEqual({ restarted: true });
    expect(JSON.parse(db.select().from(schema.agentSessions).get()!.providerConfig!).accountProfile).toBe('bbbbbbbbbbbbbbbb');
    expect(fake.restart).toHaveBeenCalledWith('s1');
  });
});
