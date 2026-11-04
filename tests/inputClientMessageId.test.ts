import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Browser `clientMessageId` (sync refonte C08): the composer's UUID is the
// agent's input idempotency key AND rides `user_echo` with the user row id,
// so an optimistic bubble reconciles by identity. A retried POST with the
// same id re-sends `send_input` (the agent dedups it) without a second row or
// echo, and answers the same `rowId`. The input route validates the id and
// announces `tabs_changed` only when pinning really changed a tab. A
// scheduled resume names its user row on the echo and clears the
// pending-assistant pointer with its insert.

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

const VPS_ID = 'inputvps';
const SID = '9'.repeat(32);          // registered stream (route + scheduler)

let db: any;
let schema: any;
let getOrCreateStream: any;
let subscribeGlobalSessionEvents: any;
let POST: any;

function userRows() {
  return db.select().from(schema.sessionMessages).all()
    .filter((r: any) => r.sessionId === SID && r.role === 'user')
    .sort((a: any, b: any) => a.id - b.id);
}

function sendInputCalls() {
  return agentCall.mock.calls.filter(([method]) => method === 'send_input').map(([, params]) => params);
}

/** Frames this session published on the global bus, from now on. */
function busFrames() {
  const seen: any[] = [];
  const off = subscribeGlobalSessionEvents((f: any) => { seen.push(f); });
  return { seen, off };
}

function post(body: unknown) {
  return POST(new Request(`http://localhost/api/sessions/${SID}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: SID }) });
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  db.insert(schema.agentSessions).values({ id: SID, vpsId: VPS_ID, cwd: '/tmp', status: 'active' }).onConflictDoNothing().run();
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ({ getOrCreateStream, subscribeGlobalSessionEvents } = await import('@/lib/server/agent/sessionOps'));
  ({ POST } = await import('@/app/api/sessions/[id]/input/route'));
});

beforeEach(() => {
  agentCall.mockReset();
  agentCall.mockImplementation(async () => ({ ok: true }));
});

afterEach(() => {
  vi.useRealTimers();
  db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
  db.delete(schema.sessionScheduledResumes).run();
  db.delete(schema.tabs).run();
  db.update(schema.agentSessions).set({ pendingAssistantMessageId: null, status: 'active' }).run();
});

describe('sendUserMessage with a clientMessageId', () => {
  it('twice with the same id ⇒ one user row, one echo, two send_input with that id, the same rowId', async () => {
    const s = getOrCreateStream(SID);
    const { seen, off } = busFrames();
    const first = await s.sendUserMessage('hello', undefined, { clientMessageId: 'cm-1' });
    const again = await s.sendUserMessage('hello', undefined, { clientMessageId: 'cm-1' });
    off();
    const rows = userRows();
    expect(rows).toHaveLength(1);
    expect(first).toEqual({ rowId: rows[0].id });
    expect(again).toEqual({ rowId: rows[0].id });
    expect(sendInputCalls().map((p: any) => p.client_message_id)).toEqual(['cm-1', 'cm-1']);
    const echoes = seen.filter((f) => f.type === 'user_echo');
    expect(echoes).toEqual([{
      type: 'user_echo', content: 'hello', createdAt: expect.any(Number),
      clientMessageId: 'cm-1', rowId: rows[0].id, sessionId: SID,
    }]);
    // The repeat is no new turn: no second optimistic `thinking`.
    expect(seen.filter((f) => f.type === 'status' && f.status === 'thinking')).toHaveLength(1);
  });

  it('without an id: a fresh UUID is the agent key and rides the echo', async () => {
    const s = getOrCreateStream(SID);
    const { seen, off } = busFrames();
    const { rowId } = await s.sendUserMessage('no id given');
    off();
    const [call] = sendInputCalls();
    expect(call.client_message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.find((f) => f.type === 'user_echo')).toMatchObject({ clientMessageId: call.client_message_id, rowId });
    expect(userRows().map((r: any) => r.id)).toEqual([rowId]);
  });

  it('the remembered ids are bounded (oldest evicted first)', async () => {
    const s = getOrCreateStream(SID);
    for (let i = 0; i < 205; i++) await s.sendUserMessage(`m${i}`, undefined, { clientMessageId: `id-${i}` });
    expect(s.recentClientMessages.size).toBe(200);
    expect(s.recentClientMessages.has('id-4')).toBe(false);
    expect(s.recentClientMessages.has('id-5')).toBe(true);
  });

  it('a persist:false caller (async answers) gets no row and writes none', async () => {
    const s = getOrCreateStream(SID);
    const r = await s.sendUserMessage('answers', undefined, { persist: false, broadcastUser: false, clientMessageId: 'async-question:q' });
    expect(r).toEqual({ rowId: null });
    expect(userRows()).toEqual([]);
  });
});

describe('POST /input', () => {
  it('returns {ok, rowId, clientMessageId, sync}; a retried POST with the same id writes nothing new', async () => {
    const res = await post({ content: 'from the composer', clientMessageId: 'browser-uuid-1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = userRows();
    const sync = { epoch: expect.any(Number), rev: expect.any(Number) };
    expect(body).toEqual({ ok: true, rowId: rows[0].id, clientMessageId: 'browser-uuid-1', sync });
    const retry = await (await post({ content: 'from the composer', clientMessageId: 'browser-uuid-1' })).json();
    expect(retry).toEqual({ ...body, sync });
    expect(retry.sync.rev).toBeGreaterThanOrEqual(body.sync.rev);
    expect(userRows()).toHaveLength(1);
    expect(sendInputCalls().map((p: any) => p.client_message_id)).toEqual(['browser-uuid-1', 'browser-uuid-1']);
  });

  it('generates the id when absent and returns it', async () => {
    const body = await (await post({ content: 'old bundle' })).json();
    expect(body.ok).toBe(true);
    expect(body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sendInputCalls()[0].client_message_id).toBe(body.clientMessageId);
    expect(body.rowId).toBe(userRows()[0].id);
  });

  it.each([
    ['too long', 'x'.repeat(65)],
    ['bad characters', 'id with spaces'],
    ['not a string', 42],
    ['empty', ''],
  ])('rejects a %s clientMessageId with 400 and sends nothing', async (_label, clientMessageId) => {
    const res = await post({ content: 'hi', clientMessageId });
    expect(res.status).toBe(400);
    expect(sendInputCalls()).toEqual([]);
    expect(userRows()).toEqual([]);
  });

  it('accepts exactly 64 chars of [A-Za-z0-9-]', async () => {
    const id = 'A-z0'.repeat(16);
    const res = await post({ content: 'hi', clientMessageId: id });
    expect(res.status).toBe(200);
    expect((await res.json()).clientMessageId).toBe(id);
  });

  it('announces tabs_changed only when pinning changed a tab', async () => {
    const { openTab } = await import('@/lib/server/hub/tabs');
    const { pinTabForRef } = await import('@/lib/server/hub/tabs');
    // No tab for the session: nothing pinned, nothing announced.
    let bus = busFrames();
    await post({ content: 'one', clientMessageId: 'tab-1' });
    bus.off();
    expect(bus.seen.filter((f) => f.type === 'tabs_changed')).toEqual([]);
    // A preview tab: the first send pins it (one announcement), the next does not.
    openTab({ vpsId: VPS_ID, path: '/tmp', kind: 'session', ref: SID });
    bus = busFrames();
    await post({ content: 'two', clientMessageId: 'tab-2' });
    await post({ content: 'three', clientMessageId: 'tab-3' });
    bus.off();
    expect(bus.seen.filter((f) => f.type === 'tabs_changed')).toHaveLength(1);
    expect(pinTabForRef('session', SID)).toBe(false);
  });
});

describe('scheduled resume', () => {
  it('clears the pending-assistant pointer with its user row and names that row on the echo', async () => {
    vi.useFakeTimers({ now: Date.now() });
    const s = getOrCreateStream(SID);
    const answer = Number(db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'assistant', content: 'an answer of the turn before', assistantFinal: 0, tsMs: Date.now() - 10_000,
    }).run().lastInsertRowid);
    db.update(schema.agentSessions).set({ pendingAssistantMessageId: answer }).where(eq(schema.agentSessions.id, SID)).run();
    const source = Number(db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'error', content: '{}', tsMs: Date.now() - 5_000,
    }).run().lastInsertRowid);
    const { createScheduledResume, runScheduledResumesDue } = await import('@/lib/server/agent/scheduledResume');
    const job = createScheduledResume({ sessionId: SID, sourceMessageId: source, resetAt: Date.now() - 1 });
    vi.setSystemTime(Date.now() + 121_000);
    const { seen, off } = busFrames();
    await runScheduledResumesDue();
    off();
    const sent = db.select().from(schema.sessionScheduledResumes).all().find((r: any) => r.id === job.id);
    expect(sent.status).toBe('sent');
    const session = db.select().from(schema.agentSessions).all().find((r: any) => r.id === SID);
    expect(session.pendingAssistantMessageId).toBeNull();
    expect(seen.filter((f) => f.type === 'user_echo')).toEqual([expect.objectContaining({
      rowId: sent.userMessageId, clientMessageId: sent.clientMessageId,
    })]);
    expect(userRows().map((r: any) => r.id)).toEqual([sent.userMessageId]);
    expect(s).toBe(getOrCreateStream(SID));
  });
});
