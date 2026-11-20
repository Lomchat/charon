import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// §14.125: what the composer sends during a compaction is persisted and
// echoed at once but reaches the agent only when the compaction ends, in send
// order. The queue is durable: a hub restart releases it after its reconnect,
// and a failed delivery keeps the message (retried) instead of dropping it.

const agentCall = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => ({ ok: true })));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {}, call: agentCall,
  }),
  getAgentClient: () => ({}),
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

const VPS_ID = 'heldvps';
const SID = 'a'.repeat(32);
const RESTARTED = 'b'.repeat(32);

let db: any;
let schema: any;
let getOrCreateStream: any;

const sentIds = () => agentCall.mock.calls
  .filter(([method]) => method === 'send_input').map(([, params]) => params.client_message_id);
const heldColumn = (id: string) => db.select({ v: schema.agentSessions.heldInputsJson })
  .from(schema.agentSessions).where(eq(schema.agentSessions.id, id)).get()?.v ?? null;
const userContents = (id: string) => db.select().from(schema.sessionMessages).all()
  .filter((r: any) => r.sessionId === id && r.role === 'user').sort((a: any, b: any) => a.id - b.id)
  .map((r: any) => r.content);

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ({ getOrCreateStream } = await import('@/lib/server/agent/sessionOps'));
});

beforeEach(() => {
  agentCall.mockReset();
  agentCall.mockImplementation(async () => ({ ok: true }));
});

afterEach(() => {
  db.delete(schema.sessionMessages).run();
  db.delete(schema.agentSessions).run();
});

describe('inputs held by a compaction', () => {
  it('are rows at once, reach the agent only when it ends, in send order', async () => {
    db.insert(schema.agentSessions).values({ id: SID, vpsId: VPS_ID, cwd: '/tmp', status: 'active' }).run();
    const s = getOrCreateStream(SID);
    s._onAgentEvent({ event: 'status', session_id: SID, status: 'thinking', seq: 1 });
    s._onAgentEvent({ event: 'compacting', session_id: SID, active: true });

    const first = await s.sendUserMessage('first', undefined, { clientMessageId: 'h-1' });
    const second = await s.sendUserMessage('second', undefined, { clientMessageId: 'h-2' });
    expect(first.held && second.held).toBe(true);
    // A retried POST of a held input waits like the first one.
    expect(await s.sendUserMessage('first', undefined, { clientMessageId: 'h-1' }))
      .toEqual({ rowId: first.rowId, held: true });
    expect(sentIds()).toEqual([]);
    expect(userContents(SID)).toEqual(['first', 'second']);
    expect(JSON.parse(heldColumn(SID)).map((h: any) => h.clientMessageId)).toEqual(['h-1', 'h-2']);

    s._onAgentEvent({ event: 'compaction', session_id: SID, trigger: 'manual', seq: 2 });
    await vi.waitFor(() => expect(sentIds()).toEqual(['h-1', 'h-2']));
    expect(heldColumn(SID)).toBeNull();
    expect(s.heldInputs()).toEqual([]);
  });

  it('make the compaction\'s stop no finish (no unread marker): their turn comes next', async () => {
    db.insert(schema.agentSessions).values({ id: SID, vpsId: VPS_ID, cwd: '/tmp', status: 'active' }).run();
    const unread = () => db.select({ v: schema.agentSessions.unreadStop })
      .from(schema.agentSessions).where(eq(schema.agentSessions.id, SID)).get()?.v;
    const s = getOrCreateStream(SID);
    const ev = (e: Record<string, unknown>) => s._onAgentEvent({ session_id: SID, ...e });

    // The stop lands while the input still waits (same tick as the boundary).
    ev({ event: 'status', status: 'thinking', seq: 1 });
    ev({ event: 'compacting', active: true });
    await s.sendUserMessage('queued', undefined, { clientMessageId: 'n-1' });
    ev({ event: 'compaction', trigger: 'manual', seq: 2 });
    ev({ event: 'stop', subtype: 'success', peer_request_id: null, seq: 3 });
    expect(unread()).toBe(0);
    await vi.waitFor(() => expect(sentIds()).toEqual(['n-1']));
    // Its own turn's stop is the finish.
    ev({ event: 'status', status: 'thinking', seq: 4 });
    ev({ event: 'stop', subtype: 'success', peer_request_id: null, seq: 5 });
    expect(unread()).toBe(1);

    // The input already went out into the compaction's turn when it stops.
    db.update(schema.agentSessions).set({ unreadStop: 0 }).run();
    ev({ event: 'status', status: 'thinking', seq: 6 });
    ev({ event: 'compacting', active: true });
    await s.sendUserMessage('queued too', undefined, { clientMessageId: 'n-2' });
    ev({ event: 'compaction', trigger: 'manual', seq: 7 });
    await vi.waitFor(() => expect(s.heldInputs()).toEqual([]));
    ev({ event: 'stop', subtype: 'success', peer_request_id: null, seq: 8 });
    expect(unread()).toBe(0);
  });

  it('survive a hub restart and a failed delivery: released after the reconnect, retried, never dropped', async () => {
    db.insert(schema.agentSessions).values({
      id: RESTARTED, vpsId: VPS_ID, cwd: '/tmp', status: 'thinking',
      heldInputsJson: JSON.stringify([{ rowId: 7, clientMessageId: 'r-1', content: 'after the restart' }]),
    }).run();
    const s = getOrCreateStream(RESTARTED);
    expect(s.heldInputs()).toEqual([{ rowId: 7 }]);

    agentCall.mockImplementationOnce(async () => { throw new Error('agent offline'); });
    // The post-replay status of the reconnect: no compaction runs any more.
    s._onAgentEvent({ event: 'status', session_id: RESTARTED, status: 'active', compacting: false, seq: 3 });
    await vi.waitFor(() => expect(s.heldInputs()).toEqual([{ rowId: 7, error: 'agent offline' }]));
    expect(JSON.parse(heldColumn(RESTARTED))).toHaveLength(1);

    s._onAgentEvent({ event: 'status', session_id: RESTARTED, status: 'active', seq: 4 });
    await vi.waitFor(() => expect(sentIds()).toEqual(['r-1', 'r-1']));
    await vi.waitFor(() => expect(heldColumn(RESTARTED)).toBeNull());
  });
});
