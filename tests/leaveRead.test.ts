import { describe, expect, it, vi } from 'vitest';

// §14.47: a finish stays lit while it is on screen; it is READ when an
// attended view moves its focus OFF it. `setConnectionFocus().read` is that
// decision — the routes clear exactly those markers.

vi.mock('server-only', () => ({}));

type Conns = typeof import('@/lib/server/agent/eventConnections');

async function conn(id: string, focus: string): Promise<[Conns, () => void]> {
  const ec = await import('@/lib/server/agent/eventConnections');
  const unreg = ec.registerConnection({
    connId: id, send: () => {}, initialFocus: focus, initialFocusSeq: 1, initialVisible: true, initialAttentive: false,
  });
  return [ec, unreg];
}

describe('leaving is reading (§14.47)', () => {
  it('showing reads nothing; an attended move reads what it left; a hidden or idle move reads nothing', async () => {
    const [ec, unreg] = await conn('leave-read-a', 'A');
    expect(ec.setConnectionFocus('leave-read-a', 'A', 1, true, { attentive: true }).read).toEqual([]);
    expect(ec.setConnectionFocus('leave-read-a', 'B', 2, true, { attentive: true }).read).toEqual(['A']);
    expect(ec.setConnectionFocus('leave-read-a', 'C', 3, false, { attentive: true }).read).toEqual([]);
    unreg();

    const [, unregIdle] = await conn('leave-read-b', 'A');
    expect(ec.setConnectionFocus('leave-read-b', 'B', 2, true, { attentive: false }).read).toEqual([]);
    // Settled unread: a later attended move reads only what IT left.
    expect(ec.setConnectionFocus('leave-read-b', 'C', 3, true, { attentive: true }).read).toEqual(['B']);
    unregIdle();
  });

  it('a routing-only move (window GET) owes its read to the presence report that follows', async () => {
    const [ec, unreg] = await conn('leave-read-c', 'A');
    expect(ec.setConnectionFocus('leave-read-c', 'B', 2, true, { routingOnly: true }).read).toEqual([]);
    expect(ec.setConnectionFocus('leave-read-c', 'B', 2, true, { attentive: true }).read).toEqual(['A']);
    // Proven attended now: the next routing-only move reads at once.
    expect(ec.setConnectionFocus('leave-read-c', 'C', 3, true, { routingOnly: true }).read).toEqual(['B']);
    // Back to where it was before the report: nothing left.
    expect(ec.setConnectionFocus('leave-read-c', 'C', 3, true, { attentive: true }).read).toEqual([]);
    unreg();
  });
});
