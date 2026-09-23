import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Live 5h/7d windows off a Claude session's rate_limit event (§14.72): the
// gauges stay fresh while /api/oauth/usage is throttled, and the per-turn
// poll that fed the lockouts is dropped once an account reports them.
const fake = vi.hoisted(() => ({ call: vi.fn(), emit: vi.fn(), setSetting: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  vps: { id: 'id', claudeLoggedIn: 'claudeLoggedIn' },
  db: { select: () => ({ from: () => ({ where: () => ({ all: () => [{ loggedIn: 1 }] }) }) }) },
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ status: 'connected', call: fake.call }),
}));
vi.mock('@/lib/server/claude/settings', () => ({ getSetting: () => '', setSetting: fake.setSetting }));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  emitGlobalAccountUsage: fake.emit,
  setUsagePollTrigger: vi.fn(), setCodexUsagePollTrigger: vi.fn(),
  setCodexUsagePushHandler: vi.fn(), setUsageResetResolver: vi.fn(), setUsageWindowsHandler: vi.fn(),
}));

import { getUsageSnapshot, ingestUsageWindows, pollUsageForVps, triggerUsagePoll } from '@/lib/server/agent/usagePoll';
import { newestAccountUsage } from '@/app/accountUsageState';

const FIVE_H = Math.floor(Date.now() / 1000) + 5 * 3600;
const SEVEN_D = Math.floor(Date.now() / 1000) + 5 * 86400;
const windows = (five: number, seven: number) => ({
  five_hour: { utilization: five, resets_at: FIVE_H },
  seven_day: { utilization: seven, resets_at: SEVEN_D },
});
const endpoint = (session: number, weekly: number) => ({
  ok: true, subscription_type: 'max', org_id: null, fetched_at: Date.now() / 1000,
  usage: {
    five_hour: { utilization: session, resets_at: new Date(FIVE_H * 1000).toISOString() },
    seven_day: { utilization: weekly, resets_at: new Date(SEVEN_D * 1000).toISOString() },
    limits: [
      { kind: 'session', group: 'session', percent: session, severity: 'normal' },
      { kind: 'weekly_all', group: 'weekly', percent: weekly, severity: 'normal' },
      { kind: 'weekly_scoped', group: 'weekly', percent: 34, severity: 'warning', scope: { model: { display_name: 'Fable' } } },
    ],
  },
});

// A fake clock that jumps a minute per test clears the hub-wide 10s slot
// between polls; `later()` moves it forward inside one test.
let clock = Date.now();
const later = (ms = 1_000) => { vi.setSystemTime(Date.now() + ms); return Date.now(); };
beforeEach(() => {
  fake.call.mockReset(); fake.emit.mockClear(); fake.setSetting.mockClear();
  vi.useFakeTimers({ now: (clock += 60_000) });
});
afterEach(() => { vi.useRealTimers(); });

it('lays live windows over a polled snapshot, per-model caps untouched', async () => {
  fake.call.mockResolvedValueOnce(endpoint(21, 21));
  await pollUsageForVps('polled', { force: true });
  const next = ingestUsageWindows('polled', windows(0.33, 0.22), later());
  expect(next?.fiveHour?.utilization).toBe(33);
  expect(next?.sevenDay?.utilization).toBe(22);
  expect(next?.limits?.map((l) => [l.kind, l.percent])).toEqual([['session', 33], ['weekly_all', 22], ['weekly_scoped', 34]]);
  expect(next?.limits?.[2].severity).toBe('warning');
  expect(next!.windowsAt!).toBeGreaterThan(next!.fetchedAt);
  expect(fake.emit).toHaveBeenLastCalledWith('polled', next);
});

it('drops a replayed reading older than the one on screen', async () => {
  fake.call.mockResolvedValueOnce(endpoint(40, 30));
  await pollUsageForVps('replay', { force: true });
  expect(ingestUsageWindows('replay', windows(0.1, 0.1), Date.now() - 60_000)).toBeNull();
  expect(getUsageSnapshot('replay')?.fiveHour?.utilization).toBe(40);
});

it('ignores expired windows and malformed payloads', () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  expect(ingestUsageWindows('bad', { five_hour: { utilization: 0.5, resets_at: past } }, Date.now())).toBeNull();
  expect(ingestUsageWindows('bad', { five_hour: { utilization: '0.5', resets_at: FIVE_H } }, Date.now())).toBeNull();
  expect(ingestUsageWindows('bad', null, Date.now())).toBeNull();
  expect(getUsageSnapshot('bad')).toBeNull();
});

it('shows live windows before any poll succeeded, carrying the throttle as degraded', async () => {
  fake.call.mockResolvedValueOnce({ ok: false, error: 'http_error', status_code: 429, retry_after: 3000 });
  await pollUsageForVps('cold', { force: true });
  const next = ingestUsageWindows('cold', windows(0.5, 0.25), Date.now());
  expect(next).toMatchObject({ ok: true, fetchedAt: 0, limits: null, fiveHour: { utilization: 50 } });
  expect(next?.degraded?.statusCode).toBe(429);
  // Later readings keep arriving while the endpoint is still walled off.
  expect(ingestUsageWindows('cold', windows(0.51, 0.25), later())?.fiveHour?.utilization).toBe(51);
});

it('persists only when a window actually moved', () => {
  ingestUsageWindows('persist', windows(0.2, 0.1), Date.now());
  ingestUsageWindows('persist', windows(0.2, 0.1), later());
  expect(fake.setSetting).toHaveBeenCalledTimes(1);
});

it('stops polling after every turn once the account reports live windows', () => {
  ingestUsageWindows('quiet', windows(0.2, 0.1), Date.now());
  triggerUsagePoll('quiet');
  vi.advanceTimersByTime(10_000);
  expect(fake.call).not.toHaveBeenCalled();
});

it('the browser keeps a live update over an older hydration of the same poll', () => {
  const polled = { ok: true, fetchedAt: 1000 };
  const live = { ...polled, windowsAt: 2000 };
  expect(newestAccountUsage(live, polled)).toBe(live);
  expect(newestAccountUsage(polled, live)).toBe(live);
});
