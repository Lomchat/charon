import { beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ call: vi.fn(), emit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  vps: { id: 'id', codexLoggedIn: 'codexLoggedIn' },
  db: { select: () => ({ from: () => ({ where: () => ({ all: () => [{ loggedIn: 1 }] }) }) }) },
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ status: 'connected', hello: { codex_available: true }, call: fake.call }),
}));
vi.mock('@/lib/server/claude/settings', () => ({ getSetting: () => '', setSetting: vi.fn() }));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  emitGlobalAccountUsage: fake.emit,
  setUsagePollTrigger: vi.fn(), setCodexUsagePollTrigger: vi.fn(),
  setCodexUsagePushHandler: vi.fn(), setUsageResetResolver: vi.fn(),
}));

import { getCodexUsageSnapshot, ingestCodexUsagePush, pollCodexUsageForVps } from '@/lib/server/agent/usagePoll';
import { newestAccountUsage } from '@/app/accountUsageState';

const window = (percent: number | null, minutes = 10080) => ({
  used_percent: percent, resets_at: 1788776500, window_duration_mins: minutes,
});
const account = (percent = 64) => ({ limit_id: 'codex', primary: window(percent), secondary: null, plan_type: 'pro' });
const poll = (percent = 64) => ({
  ok: true, provider: 'codex', plan_type: 'pro', five_hour: null,
  seven_day: { used_percent: percent, resets_at: 1788776500, window_minutes: 10080 }, fetched_at: 1788690802,
});

beforeEach(() => { fake.call.mockReset(); fake.emit.mockClear(); });

it('keeps the account quota through repeated Spark 0/0 notifications (live regression)', () => {
  const id = 'buckets';
  for (let i = 0; i < 3; i++) {
    ingestCodexUsagePush(id, account());
    expect(ingestCodexUsagePush(id, {
      limit_id: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark',
      primary: window(0, 300), secondary: window(0),
    })).toBeNull();
    expect(getCodexUsageSnapshot(id)?.sevenDay?.utilization).toBe(64);
    expect(getCodexUsageSnapshot(id)?.fiveHour).toBeNull();
  }
  expect(fake.emit).toHaveBeenCalledTimes(3);
});

it('ignores named buckets even before the first account reading', () => {
  expect(ingestCodexUsagePush('cold', { limitId: 'other_model', primary: window(0) })).toBeNull();
  expect(getCodexUsageSnapshot('cold')).toBeNull();
  expect(fake.emit).not.toHaveBeenCalled();
});

it('accepts legacy and camelCase account snapshots, including a genuine reset to zero', () => {
  ingestCodexUsagePush('legacy', { primary: window(64) });
  const next = ingestCodexUsagePush('legacy', {
    limitId: 'codex', primary: { usedPercent: 0, resetsAt: 1789295566, windowDurationMins: 10080 },
  });
  expect(next?.sevenDay?.utilization).toBe(0);
  expect(next?.sevenDay?.resetsAt).toBe(new Date(1789295566000).toISOString());
});

it('leaves an unreported utilization unknown', () => {
  expect(ingestCodexUsagePush('unknown', { ...account(), primary: window(null) })?.sevenDay?.utilization).toBeNull();
});

it('does not let an in-flight poll overwrite a newer pushed reading', async () => {
  let resolve!: (value: unknown) => void;
  fake.call.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const pending = pollCodexUsageForVps('race', { force: true });
  const pushed = ingestCodexUsagePush('race', account(65));
  resolve(poll(64));
  expect(await pending).toBe(pushed);
  expect(getCodexUsageSnapshot('race')?.sevenDay?.utilization).toBe(65);
  expect(fake.emit).toHaveBeenCalledTimes(1);
});

it('preserves last-good gauges and their age on failed or empty polls, then recovers', async () => {
  const last = ingestCodexUsagePush('failure', account())!;
  fake.call.mockResolvedValueOnce({ ok: false, error: 'temporarily unavailable' });
  const failed = await pollCodexUsageForVps('failure', { force: true });
  expect(failed).toMatchObject({ ok: true, fetchedAt: last.fetchedAt, sevenDay: last.sevenDay, degraded: { reason: 'temporarily unavailable' } });
  fake.call.mockResolvedValueOnce({ ...poll(), seven_day: null });
  expect(await pollCodexUsageForVps('failure', { force: true })).toMatchObject({ sevenDay: last.sevenDay, degraded: { reason: 'usage_unavailable' } });
  fake.call.mockResolvedValueOnce(poll(66));
  expect(await pollCodexUsageForVps('failure', { force: true })).toMatchObject({ ok: true, sevenDay: { utilization: 66 } });
  expect(getCodexUsageSnapshot('failure')?.degraded).toBeUndefined();
});

it('keeps newer SSE data when an older session-hydration HTTP response arrives', () => {
  const current = { ok: true, fetchedAt: 200, sevenDay: { utilization: 65, resetsAt: null } };
  const old = { ...current, fetchedAt: 100, sevenDay: { utilization: 64, resetsAt: null } };
  expect(newestAccountUsage(current, old)).toBe(current);
  expect(newestAccountUsage(old, current)).toBe(current);
  expect(newestAccountUsage(undefined, current)).toBe(current);
  // Same measurement, but a refresh failure adds an honest stale indication.
  const degraded = { ...current, degraded: { reason: 'temporary' } };
  expect(newestAccountUsage(current, degraded)).toBe(degraded);
});
