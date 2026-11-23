import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// lib/waitingInputs.ts: a message sent mid-turn waits beside the composer
// until the provider reads it, then its row moves to that moment (`ts_ms`) —
// the same place live and after a reload. A turn that ends while one still
// waits is no finish (its own turn is next). The list survives a hub restart.

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

const VPS_ID = 'waitvps';
const SID = 'c'.repeat(32);
const RESTARTED = 'd'.repeat(32);

let db: any;
let schema: any;
let getOrCreateStream: any;

const row = (id: number) => db.select().from(schema.sessionMessages).all().find((r: any) => r.id === id);
const waitingColumn = (id: string) => db.select({ v: schema.agentSessions.waitingInputsJson })
  .from(schema.agentSessions).where(eq(schema.agentSessions.id, id)).get()?.v ?? null;
const unread = (id: string) => db.select({ v: schema.agentSessions.unreadStop })
  .from(schema.agentSessions).where(eq(schema.agentSessions.id, id)).get()?.v;

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
  agentCall.mockImplementation(async (method: string) => (method === 'send_input'
    ? { ok: true, tracked: true, send_now: true } : { ok: true }));
});

afterEach(() => {
  db.delete(schema.sessionMessages).run();
  db.delete(schema.agentSessions).run();
});

describe('inputs the provider has not read yet', () => {
  it('wait out of the conversation, move to where they are read, and keep the turn from finishing', async () => {
    db.insert(schema.agentSessions).values({ id: SID, vpsId: VPS_ID, cwd: '/tmp', status: 'active' }).run();
    const s = getOrCreateStream(SID);
    const ev = (e: Record<string, unknown>) => s._onAgentEvent({ session_id: SID, ...e });
    ev({ event: 'status', status: 'thinking', seq: 1 });

    const sent = await s.sendUserMessage('also do that', undefined, { clientMessageId: 'w-1' });
    expect(s.waitingInputs()).toEqual([expect.objectContaining({ rowId: sent.rowId, clientMessageId: 'w-1', sendNow: true })]);
    expect(JSON.parse(waitingColumn(SID))[0]).toMatchObject({ clientMessageId: 'w-1', tracked: true });

    // The turn ends without reading it: no finish, it opens the next turn.
    ev({ event: 'stop', subtype: 'success', peer_request_id: null, inputs: [], seq: 2, ts: 1_900_000_000 });
    expect(unread(SID)).toBe(0);
    expect(s.waitingInputs()).toHaveLength(1);

    ev({ event: 'status', status: 'thinking', seq: 3 });
    ev({ event: 'inputs_taken', client_message_ids: ['w-1'], seq: 4, ts: 1_900_000_005.25 });
    expect(row(sent.rowId).tsMs).toBe(1_900_000_005_250);
    expect(s.waitingInputs()).toEqual([]);
    expect(waitingColumn(SID)).toBeNull();
    ev({ event: 'stop', subtype: 'success', peer_request_id: null, inputs: ['w-1'], seq: 5 });
    expect(unread(SID)).toBe(1);

    // An agent that does not track it (older runtime): read at its answer.
    agentCall.mockImplementation(async () => ({ ok: true }));
    ev({ event: 'status', status: 'thinking', seq: 6 });
    await s.sendUserMessage('untracked', undefined, { clientMessageId: 'w-2' });
    expect(s.waitingInputs()).toEqual([]);
  });

  it('survive a hub restart: the read that comes after settles them', async () => {
    db.insert(schema.agentSessions).values({
      id: RESTARTED, vpsId: VPS_ID, cwd: '/tmp', status: 'thinking',
      waitingInputsJson: JSON.stringify([{ rowId: 42, clientMessageId: 'r-1', since: 1, tracked: true }]),
    }).run();
    db.insert(schema.sessionMessages).values({ id: 42, sessionId: RESTARTED, role: 'user', content: 'x', tsMs: 1000 }).run();
    const s = getOrCreateStream(RESTARTED);
    expect(s.waitingInputs()).toEqual([{ rowId: 42, clientMessageId: 'r-1', since: 1 }]);
    s._onAgentEvent({ event: 'inputs_taken', session_id: RESTARTED, client_message_ids: ['r-1'], seq: 9, ts: 2 });
    expect(row(42).tsMs).toBe(2000);
    expect(waitingColumn(RESTARTED)).toBeNull();
  });
});
