import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/db/schema';
import { accountProfileId, accountProfileNumber } from '@/lib/accountProfiles';

const fake = vi.hoisted(() => ({ call: vi.fn(), invalidate: vi.fn(), emit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const tables = await import('@/lib/db/schema');
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: tables });
  migrate(db, { migrationsFolder: './drizzle' });
  return { ...tables, db };
});
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ status: 'connected', call: fake.call }),
}));
vi.mock('@/lib/server/agent/sessionOps', () => ({ emitGlobalAccountProfiles: fake.emit, emitGlobalVpsStatus: vi.fn(), emitGlobalVpsRuntimeFromDb: vi.fn() }));
vi.mock('@/lib/server/agent/usagePoll', () => ({ invalidateAccountProfileUsage: fake.invalidate }));
vi.mock('@/lib/server/hub/codexModels', () => ({ invalidateCodexAccountModels: vi.fn() }));

import { db } from '@/lib/db';
import { createAccountProfile, listLegacyAccountProfiles as listAccountProfiles, profileStatuses, readProfileStatus,
  removeAccountProfile, requireAccountProfile } from '@/lib/server/agent/accountProfiles';

beforeEach(() => {
  fake.call.mockReset(); fake.invalidate.mockReset(); fake.emit.mockReset();
  profileStatuses.clear();
  db.delete(schema.agentSessions).run();
  db.delete(schema.accountProfiles).run();
  db.delete(schema.vps).run();
  db.insert(schema.vps).values([
    { id: 'a', name: 'A', ip: '192.0.2.1', sshUser: 'user' },
    { id: 'b', name: 'B', ip: '192.0.2.2', sshUser: 'user' },
  ]).run();
  fake.call.mockImplementation(async (_method, params) => ({ profiles: params.profiles.map((p: { provider: string; id: string }) => ({
    ok: true, provider: p.provider, account_profile: p.id, logged_in: false,
    account_key: null, generation: 'generation-1', config_dir: `/home/user/accounts/${p.id}`,
  })) }));
});

describe('VPS account profiles', () => {
  it('never creates a profile before its daemon supports isolation', async () => {
    fake.call.mockRejectedValue({ code: -32601 });
    await expect(createAccountProfile('a', 'claude', 'Work')).rejects.toMatchObject({ code: -32601 });
    expect(db.select().from(schema.accountProfiles).all()).toHaveLength(0);
  });

  it('scopes profiles to both VPS and provider, with a default on each VPS', async () => {
    const profile = await createAccountProfile('a', 'claude', 'Work');
    expect(listAccountProfiles('a').filter((p) => p.provider === 'claude')).toHaveLength(2);
    expect(listAccountProfiles('b').filter((p) => p.provider === 'claude')).toHaveLength(1);
    expect(() => requireAccountProfile('b', 'claude', profile.id)).toThrow(/does not belong/);
    expect(() => requireAccountProfile('a', 'codex', profile.id)).toThrow(/does not belong/);
  });

  it("keeps an unprobed default profile's last probed identity, and forgets it on sign-out", async () => {
    const answer = (loggedIn: boolean, key: string | null) => fake.call.mockImplementation(async (_m, params) => ({
      profiles: params.profiles.map((p: { provider: string; id: string }) => ({ ok: true, provider: p.provider,
        account_profile: p.id, logged_in: loggedIn, account_key: key, generation: `g-${key}` })),
    }));
    answer(true, 'K1');
    await readProfileStatus('a', 'codex');
    const keyOf = () => listAccountProfiles('a').find((p) => p.provider === 'codex' && p.id === 'default')?.accountKey;
    expect(keyOf()).toBe('K1');
    profileStatuses.clear(); // hub restart: the VPS is not probed yet
    expect(keyOf()).toBe('K1');
    expect(listAccountProfiles('b').find((p) => p.provider === 'codex')?.accountKey).toBeNull();
    answer(false, null);
    await readProfileStatus('a', 'codex');
    profileStatuses.clear();
    expect(keyOf()).toBeNull();
  });

  it('does not recycle a removed profile number', async () => {
    const second = await createAccountProfile('a', 'claude', 'Work');
    expect(second.number).toBe(2);
    await removeAccountProfile('a', 'claude', second.id);
    const third = await createAccountProfile('a', 'claude', 'Personal');
    expect(third.number).toBe(3);
    expect(listAccountProfiles('a').some((p) => p.id === second.id)).toBe(false);
    expect(() => requireAccountProfile('a', 'claude', second.id)).toThrow();
  });

  it('protects profiles used by paused or archived sessions', async () => {
    const profile = await createAccountProfile('a', 'codex', 'Work');
    db.insert(schema.agentSessions).values({ id: 'session', vpsId: 'a', cwd: '/project',
      kind: 'codex', status: 'sleeping', archived: 1, providerConfig: JSON.stringify({ accountProfile: profile.id }) }).run();
    await expect(removeAccountProfile('a', 'codex', profile.id)).rejects.toThrow(/sessions/);
  });

  it('signs a removed profile out first, and keeps it while the VPS cannot confirm', async () => {
    const profile = await createAccountProfile('a', 'codex', 'Work');
    let signedIn = true;
    fake.call.mockImplementation(async (method, params) => {
      if (method === 'codex_logout') { signedIn = false; return { ok: true }; }
      return { profiles: params.profiles.map((p: { provider: string; id: string }) => ({
        ok: true, provider: p.provider, account_profile: p.id, logged_in: signedIn,
        account_key: signedIn ? 'A' : null, generation: signedIn ? 'in' : 'out', config_dir: '/home/user/accounts/x',
      })) };
    });
    await removeAccountProfile('a', 'codex', profile.id);
    expect(fake.call).toHaveBeenCalledWith('codex_logout', { account_profile: profile.id });
    expect(fake.call.mock.calls.map(([method]) => method).at(-1)).toBe('account_profiles');
    expect(listAccountProfiles('a').some((p) => p.id === profile.id)).toBe(false);

    const kept = await createAccountProfile('a', 'codex', 'Personal');
    fake.call.mockRejectedValue(new Error('agent a: not connected'));
    await expect(removeAccountProfile('a', 'codex', kept.id)).rejects.toThrow(/reachable/);
    expect(listAccountProfiles('a').some((p) => p.id === kept.id)).toBe(true);
  });

  it('invalidates gauges only on identity changes, including external switching and logout', async () => {
    fake.call.mockImplementation(async (_method, params) => ({ profiles: params.profiles.map((p: { provider: string; id: string }) => ({
      ok: true, provider: p.provider, account_profile: p.id, logged_in: true, account_key: 'A', generation: 'token-1',
    })) }));
    await readProfileStatus('a', 'claude');
    // A first sighting lets usagePoll compare against the persisted identity.
    expect(fake.invalidate).toHaveBeenLastCalledWith('a', 'claude', 'default', 'A', { firstSighting: true, priorKey: null });
    fake.invalidate.mockClear();
    await readProfileStatus('a', 'claude');
    expect(fake.invalidate).not.toHaveBeenCalled();
    fake.call.mockResolvedValue({ profiles: [{ ok: true, provider: 'claude', account_profile: 'default', logged_in: true,
      account_key: 'B', generation: 'token-2' }] });
    await readProfileStatus('a', 'claude');
    expect(fake.invalidate).toHaveBeenLastCalledWith('a', 'claude', 'default', 'B', true);
    fake.call.mockResolvedValue({ profiles: [{ ok: true, provider: 'claude', account_profile: 'default', logged_in: false,
      account_key: null, generation: 'none' }] });
    await readProfileStatus('a', 'claude');
    expect(fake.invalidate).toHaveBeenLastCalledWith('a', 'claude', 'default', null, true);
  });

  it('hands an extra profile\'s persisted login to the first sighting (a change during downtime is announced)', async () => {
    const profile = await createAccountProfile('a', 'claude', 'Work');
    db.update(schema.accountProfiles).set({ accountKey: 'OLD', loggedIn: 1 }).run();
    profileStatuses.clear(); fake.invalidate.mockClear();
    fake.call.mockResolvedValue({ profiles: [{ ok: true, provider: 'claude', account_profile: profile.id,
      logged_in: true, account_key: 'NEW', generation: 'g' }] });
    await readProfileStatus('a', 'claude', profile.id);
    expect(fake.invalidate).toHaveBeenLastCalledWith('a', 'claude', profile.id, 'NEW', { firstSighting: true, priorKey: 'OLD' });
  });

  it('clears a previous account’s gauges if credentials change but identity cannot be checked yet', async () => {
    fake.call.mockResolvedValue({ profiles: [{ ok: true, provider: 'claude', account_profile: 'default',
      logged_in: true, account_key: 'A', generation: 'old' }] });
    await readProfileStatus('a', 'claude');
    fake.call.mockResolvedValue({ profiles: [{ ok: false, provider: 'claude', account_profile: 'default',
      generation: 'new', error: 'Account check unavailable' }] });
    await expect(readProfileStatus('a', 'claude')).rejects.toThrow('Account check unavailable');
    expect(fake.invalidate).toHaveBeenLastCalledWith('a', 'claude', 'default', null);
    expect(profileStatuses.get('a:claude:default')?.logged_in).toBe(true);
  });

  it('reads redacted session metadata and legacy construction JSON consistently', () => {
    const config = { accountProfile: '0123456789abcdef', accountProfileNumber: 2 };
    expect(accountProfileId({ ...config, providerConfig: undefined })).toBe(config.accountProfile);
    expect(accountProfileNumber({ providerConfig: JSON.stringify(config) })).toBe(2);
    expect(accountProfileId(null)).toBe('default');
  });
});
