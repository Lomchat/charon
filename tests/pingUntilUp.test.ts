import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// A freshly installed or restarted daemon can take seconds to open its socket:
// the post-install/update ping waits while the socket is merely absent, and
// answers at once for any other failure (lib/server/hub/bootstrap.ts).

const ABSENT = { ok: false, detail: 'charon-agent: socket /root/.charon/agent.sock not found (daemon not started?)\n' };
const UP = { ok: true, version: '0.121.0', detail: 'agent 0.121.0' };

async function run(results: Array<typeof ABSENT | typeof UP>, budgetMs = 20_000) {
  const { pingUntilUp } = await import('@/lib/server/hub/bootstrap');
  let t = 0;
  const slept: number[] = [];
  const ping = vi.fn(async () => results.shift() ?? ABSENT);
  const r = await pingUntilUp(ping as never, { budgetMs, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  return { r, calls: ping.mock.calls.length, slept };
}

describe('pingUntilUp', () => {
  it('waits while the socket is absent, then returns the answer', async () => {
    const { r, calls, slept } = await run([ABSENT, ABSENT, UP]);
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
    expect(slept).toEqual([1_000, 2_000]);
  });

  it('any other failure answers at once', async () => {
    const { r, calls } = await run([{ ok: false, detail: 'Permission denied (publickey)' }, UP]);
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('a daemon that never comes up fails within the budget', async () => {
    const { r, slept } = await run([], 10_000);
    expect(r.ok).toBe(false);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
    expect(Math.max(...slept)).toBeLessThanOrEqual(4_000);
  });
});
