import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { AgentClient } from '@/lib/server/agent/AgentClient';
import type { Vps } from '@/lib/db/schema';

// A subscribe fired while CONNECTED must remember its durable cursor: the
// reconnect re-subscribe otherwise fell back to `replay:300`, a ring tail big
// enough to overflow the agent's send queue on every reconnect.
describe('subscribe cursor across reconnects', () => {
  it('re-subscribes with the explicit after_seq, not a ring replay', () => {
    const client = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    const sent: Record<string, unknown>[] = [];
    (client as any).call = (method: string, params: Record<string, unknown>) => {
      if (method === 'subscribe') sent.push(params);
      return Promise.resolve({ ok: true });
    };
    client.status = 'connected';
    client.subscribe('s1', () => {}, { afterSeq: 1304 });
    // What _onConnected does for every subscribed session.
    (client as any)._fireSubscribe('s1');
    expect(sent).toEqual([
      { session_id: 's1', after_seq: 1304 },
      { session_id: 's1', after_seq: 1304 },
    ]);
  });
});
