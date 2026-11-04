import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// A (re)connect re-subscribes ONE session at a time (S1 review §2): the agent
// queues each replay burst whole in one send queue (10 000 events / 32 MiB).
// The connected hook's reconcile attaches every agent-known stream from INSIDE
// the hello handler's status change; those subscribes must join the chain, not
// fire in parallel with it (nor make it send the first session twice). Driven
// through the real hello path: a real AgentClient over a fake ssh child.

const fake = vi.hoisted(() => ({ children: [] as any[], client: null as any }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child: any = new EventEmitter();
      child.writes = [] as string[];
      child.stdin = { write: (line: string) => { child.writes.push(line); return true; }, end: () => {} };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      fake.children.push(child);
      return child;
    }),
  };
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => fake.client,
  getAgentClient: () => fake.client,
  dropAgentClient: async () => {},
}));
vi.mock('@/lib/server/hub/codexBgState', () => ({ readCodexBgState: async () => [] }));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: async () => {} }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: async () => {},
  sendQuestionToTelegram: async () => {},
  markInteractionResolvedInTelegram: async () => {},
  sendPlainToTelegram: async () => {},
}));

const VPS = 'chainvps';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const T0 = Date.now() - 3_600_000;

let db: any;
let schema: any;
let AgentClient: typeof import('@/lib/server/agent/AgentClient').AgentClient;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS, name: 'chain', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ({ AgentClient } = await import('@/lib/server/agent/AgentClient'));
});

afterEach(async () => {
  await fake.client?.close();
  fake.client = null;
  fake.children.length = 0;
});

/** The JSON-RPC requests the client wrote to the child. */
function requests(child: any): Array<{ id: number; method: string; params: any }> {
  return child.writes.map((l: string) => JSON.parse(l));
}
function subscribes(child: any): string[] {
  return requests(child).filter((r) => r.method === 'subscribe')
    .map((r) => `${r.params.session_id.slice(0, 1)}@${r.params.after_seq}`);
}
function lastSubscribeId(child: any, sid: string): number {
  return requests(child).filter((r) => r.method === 'subscribe' && r.params.session_id === sid).at(-1)!.id;
}
function feed(child: any, ...lines: unknown[]): void {
  child.stdout.emit('data', Buffer.from(lines.map((l) => JSON.stringify(l) + '\n').join('')));
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };

async function connect(sessions: string[], onConnected: (client: any) => void, agentVersion = '0.102.2'): Promise<any> {
  const client: any = new AgentClient({ id: VPS, name: 'chain', ip: '127.0.0.1', sshUser: 'root' } as any);
  fake.client = client;
  client.onStatus((s: string) => { if (s === 'connected') onConnected(client); });
  void client.ready();
  const child = fake.children.at(-1);
  feed(child, { id: 1, result: { agent_version: agentVersion, sessions: sessions.map((session_id) => ({ session_id, status: 'active' })) } });
  await Promise.resolve();                                           // the hello's `.then`
  return child;
}

describe('the first connection of a client: the chain owns every subscribe', () => {
  it('subscribes issued by a status listener are queued: one outstanding, each session once', async () => {
    const child = await connect([A, B], (client) => {
      client.subscribe(A, () => {}, { afterSeq: 100 });
      client.subscribe(B, () => {}, { afterSeq: 200 });
      client.resubscribe(A);                                           // resumeSession's cursor-less copy
    });
    expect(subscribes(child)).toEqual(['a@100']);
    feed(child, { id: lastSubscribeId(child, A), result: { ok: true, replay_count: 0 } });
    await settle();
    expect(subscribes(child)).toEqual(['a@100', 'b@200']);
    feed(child, { id: lastSubscribeId(child, B), result: { ok: true, replay_count: 0 } });
    await settle();
    expect(subscribes(child)).toEqual(['a@100', 'b@200']);
    // The chain is done: a later subscribe fires at once again.
    fake.client.subscribe('c'.repeat(32), () => {}, { afterSeq: 7 });
    expect(subscribes(child)).toEqual(['a@100', 'b@200', 'c@7']);
  });

  it('a queued session\'s cursor is read when it fires; an explicit-cursor resubscribe joins the queue with that cursor', async () => {
    const C = 'c'.repeat(32);
    const child = await connect([A, B, C], (client) => {
      client.subscribe(A, () => {}, { afterSeq: 100 });
      client.subscribe(B, () => {}, { afterSeq: 200 });
      client.subscribe(C, () => {}, { afterSeq: 300 });
    });
    fake.client.setAfterSeq(B, 250);                                   // B's stream advanced meanwhile
    fake.client.resubscribe(C, { afterSeq: 40 });                      // an explicit cursor (the epoch reset's)
    expect(subscribes(child)).toEqual(['a@100']);                      // never beside the chain's burst
    feed(child, { id: lastSubscribeId(child, A), result: { ok: true, replay_count: 0 } });
    await settle();
    expect(subscribes(child)).toEqual(['a@100', 'b@250']);
    feed(child, { id: lastSubscribeId(child, B), result: { ok: true, replay_count: 0 } });
    await settle();
    expect(subscribes(child)).toEqual(['a@100', 'b@250', 'c@40']);
    feed(child, { id: lastSubscribeId(child, C), result: { ok: true, replay_count: 0 } });
    await settle();
    expect(subscribes(child)).toEqual(['a@100', 'b@250', 'c@40']);  // sent once
  });

  it('a disconnect drops the queue; the next connection queues every session again', async () => {
    const child = await connect([A, B], (client) => {
      client.subscribe(A, () => {}, { afterSeq: 100 });
      client.subscribe(B, () => {}, { afterSeq: 200 });
    });
    expect(subscribes(child)).toEqual(['a@100']);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      child.emit('close', 255);                                        // the burst overflowed the queue
      expect(fake.client.chainPending).toBeNull();
      fake.client.subscribe('c'.repeat(32), () => {}, { afterSeq: 7 }); // while reconnecting: stored
      expect(subscribes(child)).toEqual(['a@100']);
      vi.advanceTimersByTime(1_000);                                   // the first reconnect backoff
    } finally { vi.useRealTimers(); }
    await settle();
    const child2 = fake.children.at(-1);
    expect(child2).not.toBe(child);
    feed(child2, { id: requests(child2).find((r) => r.method === 'hello')!.id, result: { agent_version: '0.102.2', sessions: [] } });
    await Promise.resolve();
    expect(subscribes(child2)).toEqual(['a@100']);
    for (const expected of [['a@100', 'b@200'], ['a@100', 'b@200', 'c@7']]) {
      const last = requests(child2).filter((r) => r.method === 'subscribe').at(-1)!;
      feed(child2, { id: last.id, result: { ok: true, replay_count: 0 } });
      await settle();
      expect(subscribes(child2)).toEqual(expected);
    }
  });
});

describe('a session with NO cursor while the chain runs (S1 final review, G2)', () => {
  const N = 'n'.repeat(32);
  const ringSubscribes = (child: any) => requests(child)
    .filter((r) => r.method === 'subscribe' && r.params.session_id === N).map((r) => r.params);

  it('a session created meanwhile is subscribed at once, never queued to a late ring tail', async () => {
    const child = await connect([A], (client) => { client.subscribe(A, () => {}, { afterSeq: 100 }); });
    expect(subscribes(child)).toEqual(['a@100']);
    fake.client.subscribe(N, () => {});                                // startNewSession's attach: no cursor
    expect(ringSubscribes(child)).toEqual([{ session_id: N, replay: 300 }]);
    feed(child, { id: lastSubscribeId(child, N), result: { ok: true, replay_count: 0 } });
    feed(child, { id: lastSubscribeId(child, A), result: { ok: true, replay_count: 0 } });
    await settle();
    // The chain does not send it a second time.
    expect(ringSubscribes(child)).toHaveLength(1);
    expect(subscribes(child)).toEqual(['a@100', 'n@undefined']);
  });

  it('a cursor-less resubscribe of a session never subscribed fires at once; a stored cursor still queues', async () => {
    const child = await connect([A, B], (client) => {
      client.subscribe(A, () => {}, { afterSeq: 100 });
      client.subscribe(B, () => {}, { afterSeq: 200 });
    });
    fake.client.resubscribe(B);                                        // queued with its stored cursor: no-op
    expect(subscribes(child)).toEqual(['a@100']);
    // A listener whose agent-side subscribe was never issued, no cursor known.
    fake.client.subscribers.set(N, new Set([() => {}]));
    fake.client.resubscribe(N);
    expect(ringSubscribes(child)).toEqual([{ session_id: N, replay: 300 }]);
    feed(child, { id: lastSubscribeId(child, A), result: { ok: true, replay_count: 0 } });
    await settle();
    expect(subscribes(child)).toEqual(['a@100', 'n@undefined', 'b@200']);
  });
});

describe('a cursor-less resubscribe of a session already subscribed on this connection (S1 final review)', () => {
  it('after the chain fired it (in flight, then answered): nothing goes out again', async () => {
    const child = await connect([A], (client) => { client.subscribe(A, () => {}, { afterSeq: 100 }); });
    expect(subscribes(child)).toEqual(['a@100']);
    fake.client.setAfterSeq(A, 103);
    fake.client.resubscribe(A);                                        // resumeSession's noop path, A#1 in flight
    feed(child, { event: 'replay_begin', session_id: A, count: 3 },
      { event: 'replay_end', session_id: A },
      { id: lastSubscribeId(child, A), result: { ok: true, replay_count: 3 } });
    await settle();
    fake.client.resubscribe(A);                                        // …or after its answer
    await settle();
    expect(subscribes(child)).toEqual(['a@100']);
    // An explicit cursor is still honoured.
    fake.client.resubscribe(A, { afterSeq: 50 });
    expect(subscribes(child)).toEqual(['a@100', 'a@50']);
  });

  it('asked while a subscribe that then FAILS (session not created yet) is in flight: it is re-issued', async () => {
    const child = await connect([A], (client) => { client.subscribe(A, () => {}, { afterSeq: 100 }); });
    fake.client.resubscribe(A);
    expect(subscribes(child)).toEqual(['a@100']);
    feed(child, { id: lastSubscribeId(child, A), error: { code: -32000, message: 'session not found' } });
    await settle();
    expect(subscribes(child)).toEqual(['a@100', 'a@100']);
    feed(child, { id: lastSubscribeId(child, A), result: { ok: true, replay_count: 0 } });
    await settle();
    expect(subscribes(child)).toEqual(['a@100', 'a@100']);
  });
});

describe('hub boot: the connected hook reconciles every agent-known session', () => {
  const tool = (sid: string, seq: number) => ({
    event: 'tool_use', session_id: sid, seq, ts: (T0 + seq) / 1000, id: `t${seq}`, name: 'Read', input: { file_path: '/x' },
  });

  it('a seq-epoch reset inside the chain replays from 0 even when live new-epoch events arrive first', async () => {
    const E = 'e'.repeat(32);
    const F = 'f'.repeat(32);
    db.insert(schema.agentSessions).values({ id: E, vpsId: VPS, cwd: '/tmp', status: 'active', kind: 'claude', lastSeenSeq: 4000 })
      .onConflictDoNothing().run();
    db.insert(schema.agentSessions).values({ id: F, vpsId: VPS, cwd: '/tmp', status: 'active', kind: 'claude', lastSeenSeq: 200 })
      .onConflictDoNothing().run();
    const { reconcileVpsAgentState, peekStream } = await import('@/lib/server/agent/sessionOps');
    const child = await connect([E, F], (client) => { void reconcileVpsAgentState(VPS, client.hello.sessions); }, '0.103.2');
    expect(subscribes(child)).toEqual(['e@4000']);
    // The recreated log ends at 5; the agent releases E's held live events right behind the answer.
    feed(child,
      { id: lastSubscribeId(child, E), result: { ok: true, replay_count: 0, current_seq: 5, earliest_seq: 1 } },
      { event: 'status', session_id: E, status: 'active', seq: 6, ts: Date.now() / 1000 },
      { event: 'tool_use', session_id: E, id: 'live-7', name: 'Read', input: {}, seq: 7, ts: Date.now() / 1000 });
    await settle();
    feed(child, { id: lastSubscribeId(child, F), result: { ok: true, replay_count: 0 } });
    await settle();
    expect(subscribes(child)).toEqual(['e@4000', 'f@200', 'e@0']);
    const row = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, E)).get();
    expect(row.lastSeenSeq).toBe(0);
    for (const sid of [E, F]) peekStream(sid)?.detach();
  });

  it('each session is subscribed once, in turn; a rotated log at boot writes ONE replay_gap row', async () => {
    for (const [id, seq] of [[A, 100], [B, 200]] as const) {
      db.insert(schema.agentSessions).values({ id, vpsId: VPS, cwd: '/tmp', status: 'active', kind: 'claude', lastSeenSeq: seq })
        .onConflictDoNothing().run();
    }
    const { reconcileVpsAgentState } = await import('@/lib/server/agent/sessionOps');
    const child = await connect([A, B], (client) => { void reconcileVpsAgentState(VPS, client.hello.sessions); });
    expect(subscribes(child)).toEqual(['a@100']);
    // A's log rotated past its cursor: the burst starts at 150, the answer says so.
    feed(child,
      { event: 'replay_begin', session_id: A, count: 2 }, tool(A, 150), tool(A, 151), { event: 'replay_end', session_id: A },
      { id: lastSubscribeId(child, A), result: { ok: true, replay_count: 2, gap: true, earliest_seq: 150, current_seq: 151 } });
    await settle();
    expect(subscribes(child)).toEqual(['a@100', 'b@200']);
    feed(child, { id: lastSubscribeId(child, B), result: { ok: true, replay_count: 0 } });
    await settle();
    expect(subscribes(child)).toEqual(['a@100', 'b@200']);
    const rowsOf = (sid: string) => db.select().from(schema.sessionMessages)
      .where(eq(schema.sessionMessages.sessionId, sid)).all();
    const gaps = rowsOf(A).filter((r: any) => r.role === 'event' && JSON.parse(r.content).type === 'replay_gap')
      .map((r: any) => JSON.parse(r.content));
    expect(gaps).toEqual([{ type: 'replay_gap', from: 101, to: 149 }]);
    expect(rowsOf(A).filter((r: any) => r.role === 'tool_use').map((r: any) => r.seq)).toEqual([150, 151]);
    const { peekStream } = await import('@/lib/server/agent/sessionOps');
    for (const sid of [A, B]) peekStream(sid)?.detach();
  });
});
