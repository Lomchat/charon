import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountProfile } from '@/lib/accountProfiles';

const fake = vi.hoisted(() => ({ call: vi.fn(), emit: vi.fn(), status: new Map<string, any>(), profiles: [] as AccountProfile[], setting: '' }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  vps: { id: 'id', claudeLoggedIn: 'claudeLoggedIn' },
  db: { select: () => ({ from: () => ({ where: () => ({ all: () => [{ loggedIn: 1 }] }) }) }) },
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({ getAgentClientForVpsId: () => ({ status: 'connected', call: fake.call }) }));
vi.mock('@/lib/server/agent/accountProfiles', () => ({ profileStatuses: fake.status,
  statusKey: (v: string, p: string, id = 'default') => `${v}:${p}:${id}`, listAccountProfiles: () => fake.profiles,
  listLegacyAccountProfiles: () => fake.profiles }));
vi.mock('@/lib/server/hub/settings', () => ({ getSetting: () => fake.setting, setSetting: vi.fn() }));
vi.mock('@/lib/server/agent/sessionOps', () => ({ emitGlobalAccountUsage: fake.emit,
  setUsagePollTrigger: vi.fn(), setCodexUsagePollTrigger: vi.fn(), setCodexUsagePushHandler: vi.fn(),
  setUsageResetResolver: vi.fn(), setUsageWindowsHandler: vi.fn() }));

import { getAccountProfileUsage, ingestProfileCodexPush, ingestProfileUsageWindows,
  invalidateAccountProfileUsage, pollAccountProfileUsage, pollUsageForVps } from '@/lib/server/agent/usagePoll';
import { identityChecked } from '@/lib/server/agent/accountProfileState';

beforeEach(() => {
  fake.call.mockReset(); fake.emit.mockReset(); fake.status.clear(); fake.profiles = []; fake.setting = '';
  identityChecked.clear();
  const globals = globalThis as any;
  globals._usageAccounts?.clear(); globals._usageVpsOrg?.clear(); globals._codexUsageWatch?.clear();
  globals._usageGlobalSlotAt = undefined;
  vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

function profile(vpsId: string, provider: 'claude' | 'codex', id: string, accountKey: string) {
  const p = { vpsId, provider, id, number: 2, name: '', loggedIn: true, accountKey };
  fake.profiles.push(p);
  fake.status.set(`${vpsId}:${provider}:${id}`, { logged_in: true, account_key: accountKey });
  return p;
}
const windows = (percent: number) => ({ five_hour: { utilization: percent / 100, resets_at: Date.now() / 1000 + 18_000 } });

it('keeps different accounts on the same VPS isolated and rejects old-account live events', () => {
  profile('vps', 'claude', 'profile-a', 'A'); profile('vps', 'claude', 'profile-b', 'B');
  ingestProfileUsageWindows('vps', windows(20), Date.now(), 'profile-a', 'A');
  ingestProfileUsageWindows('vps', windows(70), Date.now(), 'profile-b', 'B');
  expect(getAccountProfileUsage('vps', 'claude', 'profile-a')?.fiveHour?.utilization).toBe(20);
  expect(getAccountProfileUsage('vps', 'claude', 'profile-b')?.fiveHour?.utilization).toBe(70);
  fake.status.set('vps:claude:profile-a', { logged_in: true, account_key: 'B' });
  invalidateAccountProfileUsage('vps', 'claude', 'profile-a', 'B');
  fake.emit.mockClear();
  ingestProfileUsageWindows('vps', windows(99), Date.now() + 1000, 'profile-a', 'A');
  expect(fake.emit).not.toHaveBeenCalled();
  expect(getAccountProfileUsage('vps', 'claude', 'profile-a')?.fiveHour?.utilization).toBe(70);
});

it('shares a confirmed account across VPS profiles and performs one endpoint poll', async () => {
  profile('first', 'claude', 'profile-a', 'A'); profile('second', 'claude', 'profile-b', 'A');
  fake.call.mockResolvedValue({ ok: true, account_profile: 'profile-a', account_key: 'A', usage: { five_hour: { utilization: 33 } } });
  await pollAccountProfileUsage('first', 'claude', 'profile-a');
  await pollAccountProfileUsage('second', 'claude', 'profile-b');
  expect(fake.call).toHaveBeenCalledTimes(1);
  expect(fake.call).toHaveBeenCalledWith('get_usage', { account_profile: 'profile-a' });
  expect(fake.emit.mock.calls.map(([v, u]) => [v, u.accountProfile])).toEqual([
    ['first', 'profile-a'], ['second', 'profile-b'],
  ]);
});

it('does not fan gauges to a VPS whose saved account association has not been reverified', () => {
  profile('active', 'claude', 'default', 'A');
  invalidateAccountProfileUsage('active', 'claude', 'default', 'A');
  (globalThis as any)._usageVpsOrg.set('stale', 'A');
  fake.emit.mockClear();
  ingestProfileUsageWindows('active', windows(35), Date.now(), 'default', 'A');
  expect(fake.emit.mock.calls.map(([v]) => v)).toEqual(['active']);
  expect(getAccountProfileUsage('stale', 'claude', 'default')).toBeNull();
});

it('discards an endpoint result if the profile changes account while it is in flight', async () => {
  profile('vps', 'claude', 'profile-a', 'A');
  let resolve!: (value: any) => void;
  fake.call.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const pending = pollAccountProfileUsage('vps', 'claude', 'profile-a');
  fake.status.set('vps:claude:profile-a', { logged_in: true, account_key: 'B' });
  resolve({ ok: true, account_key: 'A', usage: { five_hour: { utilization: 99 } } });
  await pending;
  expect(getAccountProfileUsage('vps', 'claude', 'profile-a')).toBeNull();
  expect(fake.emit).not.toHaveBeenCalled();
});

it('routes Codex pushes to the profile without emitting a synthetic VPS address', () => {
  profile('vps', 'codex', 'profile-b', 'B');
  ingestProfileCodexPush('vps', { limit_id: 'codex', primary: { used_percent: 45, window_duration_mins: 300 } }, 'profile-b', 'B');
  expect(fake.emit).toHaveBeenCalledTimes(1);
  expect(fake.emit).toHaveBeenCalledWith('vps', expect.objectContaining({ accountProfile: 'profile-b', fiveHour: { utilization: 45, resetsAt: null } }));
  expect(getAccountProfileUsage('vps', 'codex', 'profile-b')?.fiveHour?.utilization).toBe(45);
  expect(getAccountProfileUsage('vps', 'codex', 'default')).toBeNull();
});

it('a manual refresh cannot bypass the Claude Retry-After wall', async () => {
  profile('vps', 'claude', 'profile-a', 'A');
  fake.call.mockResolvedValue({ ok: false, error: 'http_error', status_code: 429, retry_after: 900, account_profile: 'profile-a', account_key: 'A' });
  await pollAccountProfileUsage('vps', 'claude', 'profile-a');
  vi.advanceTimersByTime(180_000);
  await pollAccountProfileUsage('vps', 'claude', 'profile-a', { force: true });
  expect(fake.call).toHaveBeenCalledTimes(1);
});

it('paces different Claude profiles through the shared endpoint burst guard', async () => {
  profile('vps', 'claude', 'profile-a', 'A'); profile('vps', 'claude', 'profile-b', 'B');
  fake.call.mockImplementation(async (_method, params) => ({ ok: true, account_profile: params.account_profile,
    account_key: params.account_profile === 'profile-a' ? 'A' : 'B',
    usage: { five_hour: { utilization: 25 } } }));
  await pollAccountProfileUsage('vps', 'claude', 'profile-a');
  expect(await pollAccountProfileUsage('vps', 'claude', 'profile-b')).toBeNull();
  expect(fake.call).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fake.call).toHaveBeenCalledTimes(2);
  expect(getAccountProfileUsage('vps', 'claude', 'profile-b')?.fiveHour?.utilization).toBe(25);
});

it('waits for a VPS identity before its first endpoint poll after a restart', async () => {
  fake.call.mockResolvedValue({ ok: true, account_key: 'A', usage: { five_hour: { utilization: 10 } } });
  expect(await pollUsageForVps('fresh', { steady: true })).toBeNull();
  expect(fake.call).not.toHaveBeenCalled();
  // The probe answered: the poll lands straight in the account's own bucket.
  fake.status.set('fresh:claude:default', { logged_in: true, account_key: 'A' });
  (globalThis as any)._usageVpsOrg.set('fresh', 'A');
  identityChecked.add('fresh');
  await pollUsageForVps('fresh', { steady: true });
  expect(fake.call).toHaveBeenCalledTimes(1);
  expect(getAccountProfileUsage('fresh', 'claude', 'default')?.fiveHour?.utilization).toBe(10);
});

it('keeps a reading whose identity landed while it was in flight, if the agent stamped the same one', async () => {
  identityChecked.add('late');
  let resolve!: (value: any) => void;
  fake.call.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const pending = pollUsageForVps('late', { steady: true });
  fake.status.set('late:claude:default', { logged_in: true, account_key: 'A' });
  resolve({ ok: true, account_key: 'A', usage: { five_hour: { utilization: 42 } } });
  await pending;
  expect(fake.call).toHaveBeenCalledTimes(1);
  expect(getAccountProfileUsage('late', 'claude', 'default')?.fiveHour?.utilization).toBe(42);
});

it('accepts live windows from a session whose own identity probe failed', () => {
  profile('vps', 'claude', 'profile-a', 'A');
  ingestProfileUsageWindows('vps', windows(55), Date.now(), 'profile-a', null);
  expect(getAccountProfileUsage('vps', 'claude', 'profile-a')?.fiveHour?.utilization).toBe(55);
  // …but a reading for a signed-out profile still is not this account's.
  fake.status.set('vps:claude:profile-a', { logged_in: false, account_key: null });
  fake.emit.mockClear();
  ingestProfileUsageWindows('vps', windows(90), Date.now() + 1000, 'profile-a', null);
  expect(fake.emit).not.toHaveBeenCalled();
});

// ── Two Claude accounts on one VPS (user report: switching sessions showed the
// same gauges for both until account 2 sent a message) ─────────────────────
const KEY_1 = '1'.repeat(64);
const KEY_2 = '2'.repeat(64);
const KEY_3 = '3'.repeat(64);

it('two profiles on one VPS keep their own gauges through polls and unstamped live windows', async () => {
  identityChecked.add('vps');
  profile('vps', 'claude', 'default', KEY_1);
  profile('vps', 'claude', 'profile-2', KEY_2);
  (globalThis as any)._usageVpsOrg.set('vps', KEY_1);
  fake.call.mockImplementation(async (_method, params) => params?.account_profile === 'profile-2'
    ? { ok: true, account_profile: 'profile-2', account_key: KEY_2, usage: { five_hour: { utilization: 25 }, seven_day: { utilization: 82 } } }
    : { ok: true, account_key: KEY_1, usage: { five_hour: { utilization: 81 }, seven_day: { utilization: 34 } } });
  await pollUsageForVps('vps', {});
  await vi.advanceTimersByTimeAsync(10_000);
  await pollAccountProfileUsage('vps', 'claude', 'profile-2');
  // Account 2's session reports live windows WITHOUT an agent stamp: the hub
  // routes it by the session's own profile (sessionOps), never the default.
  fake.emit.mockClear();
  ingestProfileUsageWindows('vps', { five_hour: { utilization: 0.30, resets_at: Date.now() / 1000 + 3600 } }, Date.now() + 1000, 'profile-2', undefined);
  const one = getAccountProfileUsage('vps', 'claude', 'default');
  const two = getAccountProfileUsage('vps', 'claude', 'profile-2');
  expect(one?.fiveHour?.utilization).toBe(81);
  expect(one?.sevenDay?.utilization).toBe(34);
  expect(two?.fiveHour?.utilization).toBe(30);
  expect(two?.sevenDay?.utilization).toBe(82);
  expect(fake.emit.mock.calls.map(([, u]) => u.accountProfile)).toEqual(['profile-2']);
});

it('never fills a profile bucket from an unstamped get_usage (an agent that read the default login)', async () => {
  profile('vps', 'claude', 'profile-2', KEY_2);
  fake.call.mockResolvedValue({ ok: true, usage: { five_hour: { utilization: 81 } } });
  await pollAccountProfileUsage('vps', 'claude', 'profile-2');
  expect(getAccountProfileUsage('vps', 'claude', 'profile-2')).toBeNull();
  expect(fake.emit).not.toHaveBeenCalled();
});

it('a first identity sighting announces only a login that differs from the persisted one', () => {
  invalidateAccountProfileUsage('vps', 'claude', 'profile-2', KEY_2, { firstSighting: true, priorKey: KEY_2 });
  invalidateAccountProfileUsage('vps', 'claude', 'profile-2', KEY_2, { firstSighting: true, priorKey: null });
  expect(fake.emit).not.toHaveBeenCalled();
  // The login moved while the hub was down: open tabs hold the old account's gauges.
  invalidateAccountProfileUsage('vps', 'claude', 'profile-2', KEY_2, { firstSighting: true, priorKey: KEY_1 });
  expect(fake.emit).toHaveBeenLastCalledWith('vps', expect.objectContaining({ error: 'account_changed', accountKey: KEY_2 }));
  fake.emit.mockClear();
  // The Claude default compares against the persisted VPS→account map.
  (globalThis as any)._usageLoaded = true;
  (globalThis as any)._usageVpsOrg.set('vps', KEY_1);
  invalidateAccountProfileUsage('vps', 'claude', 'default', KEY_1, { firstSighting: true });
  expect(fake.emit).not.toHaveBeenCalled();
  invalidateAccountProfileUsage('vps', 'claude', 'default', KEY_2, { firstSighting: true });
  expect(fake.emit).toHaveBeenCalledTimes(1);
  invalidateAccountProfileUsage('vps', 'claude', 'default', KEY_2, { firstSighting: true });
  expect(fake.emit).toHaveBeenCalledTimes(1); // the map now says KEY_2
  invalidateAccountProfileUsage('vps', 'claude', 'profile-2', KEY_2);
  expect(fake.emit).toHaveBeenCalledTimes(2);
});

it('drops pre-v2 live overlays only where a profile could have polluted them, keeps polled ones', () => {
  const g = globalThis as any;
  const v1 = JSON.stringify({ vpsOrg: { vps: KEY_1, solo: KEY_3 }, accounts: {
    [KEY_1]: { ok: true, fetchedAt: 1_000, windowsAt: 2_000, fiveHour: { utilization: 25, resetsAt: null } },
    [KEY_2]: { ok: true, fetchedAt: 3_000, fiveHour: { utilization: 25, resetsAt: null } },
    [KEY_3]: { ok: true, fetchedAt: 1_000, windowsAt: 2_000, fiveHour: { utilization: 60, resetsAt: null } },
  } });
  g._usageLoaded = false; fake.setting = v1;
  profile('vps', 'claude', 'default', KEY_1);
  profile('vps', 'claude', 'profile-2', KEY_2);
  profile('solo', 'claude', 'default', KEY_3);
  expect(getAccountProfileUsage('vps', 'claude', 'default')).toBeNull();
  expect(getAccountProfileUsage('vps', 'claude', 'profile-2')?.fiveHour?.utilization).toBe(25);
  // A single-login VPS keeps its last-good live reading.
  expect(getAccountProfileUsage('solo', 'claude', 'default')?.fiveHour?.utilization).toBe(60);
  g._usageAccounts.clear(); g._usageLoaded = false;
  fake.setting = JSON.stringify({ v: 2, accounts: {
    [KEY_1]: { ok: true, fetchedAt: 1_000, windowsAt: 2_000, fiveHour: { utilization: 81, resetsAt: null } },
  } });
  expect(getAccountProfileUsage('vps', 'claude', 'default')?.fiveHour?.utilization).toBe(81);
  g._usageLoaded = true;
});
