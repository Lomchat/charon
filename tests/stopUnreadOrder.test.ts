import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Sync refonte C06 (G6, §14.47): in-app green is never later than ANY push.
// A live stop publishes `status:active` and the unread marker BEFORE the
// push/Telegram; the background-finish timer marks unread BEFORE its push;
// `_trackBgTask` publishes the marker it clears (U1); a user send clears it
// (U3). Replayed stops set no status; failed/background paths are unchanged.

const order = vi.hoisted(() => ({ log: [] as string[] }));
const pushMocks = vi.hoisted(() => ({
  sendPushToAll: vi.fn(async (p: any) => { order.log.push(`push:${p.event}`); }),
}));
const telegramMocks = vi.hoisted(() => ({
  sendPlainToTelegram: vi.fn(async (_t: string, _l?: string, event?: string) => { order.log.push(`telegram:${event}`); }),
}));
const clientMocks = vi.hoisted(() => ({ call: vi.fn(async (..._a: any[]): Promise<any> => ({ ok: true })) }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/hub/webPush', () => pushMocks);
vi.mock('@/lib/server/hub/codexBgState', () => ({ readCodexBgState: async () => [] }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: async () => {},
  sendQuestionToTelegram: async () => {},
  markInteractionResolvedInTelegram: async () => {},
  sendPlainToTelegram: telegramMocks.sendPlainToTelegram,
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {},
    call: clientMocks.call,
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'stopordervps';
const SID = '6'.repeat(32);

let db: any;
let schema: any;
let SessionStream: any;
let seq = 0;

function row(): any {
  return db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, SID)).get();
}

function mkStream(status = 'thinking', kind: 'claude' | 'codex' = 'claude') {
  const s = new SessionStream({
    id: SID, vpsId: VPS_ID, name: 'n', status,
    permissionMode: 'normal', nativeSessionId: null, kind,
    lastStopNotifiedSeq: row()?.lastStopNotifiedSeq ?? null,
  }) as any;
  vi.spyOn(s, '_emitBroadcast').mockImplementation(((f: any) => {
    order.log.push(f.type === 'status' ? `status:${f.status}`
      : f.type === 'session_unread' ? `unread:${f.unread}` : f.type);
  }) as any);
  return s;
}

function ev(e: Record<string, unknown>) {
  seq += 1;
  return { session_id: SID, seq, ts: (Date.now() - 60_000 + seq) / 1000, ...e };
}

/** The log restricted to the entries the ordering contract names. */
function contract(): string[] {
  return order.log.filter((x) => /^(stop|status:|unread:|push:|telegram:)/.test(x));
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'v', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  ({ SessionStream } = await import('@/lib/server/agent/sessionOps'));
  // Loaded once up front (sendUserMessage imports it lazily; a first import
  // racing the stop handlers' deferred import hits its TDZ).
  await import('@/lib/server/agent/endpointOps');
});

beforeEach(() => {
  vi.useFakeTimers();
  order.log = [];
  pushMocks.sendPushToAll.mockClear();
  telegramMocks.sendPlainToTelegram.mockClear();
  db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
  db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, SID)).run();
  db.insert(schema.agentSessions).values({
    id: SID, vpsId: VPS_ID, cwd: '/tmp', name: 'n', status: 'thinking', resumePending: 1,
  }).run();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('a live stop: status and unread before any push (G6)', () => {
  it('orders stop → status:active → unread → push → Telegram, and persists them', async () => {
    const s = mkStream('thinking');
    s._onAgentEvent(ev({ event: 'assistant_text', delta: 'Done.' }));
    s._onAgentEvent(ev({ event: 'stop', subtype: 'success' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(contract()).toEqual(['stop', 'status:active', 'unread:true', 'push:session_finished', 'telegram:session_finished']);
    expect(s.status).toBe('active');
    expect(row()).toMatchObject({ status: 'active', resumePending: 0, unreadStop: 1, lastStopNotifiedSeq: seq });
  });

  it('the agent\'s own active right after is an idempotent repeat (no second unread, no push)', async () => {
    const s = mkStream('thinking');
    s._onAgentEvent(ev({ event: 'stop', subtype: 'success' }));
    order.log = [];
    s._onAgentEvent(ev({ event: 'status', status: 'active' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(contract()).toEqual(['status:active']);
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: 'active', unreadStop: 1 });
  });

  it('starting is also a working status the stop settles', () => {
    const s = mkStream('starting');
    s._onAgentEvent(ev({ event: 'stop', subtype: 'success' }));
    expect(contract().slice(0, 2)).toEqual(['stop', 'status:active']);
  });

  it('an already-idle session gets no synthetic status', () => {
    const s = mkStream('active');
    s._onAgentEvent(ev({ event: 'stop', subtype: 'success' }));
    expect(contract().filter((x) => x.startsWith('status:'))).toEqual([]);
    expect(contract()[1]).toBe('unread:true');
  });

  it('a replayed stop sets no status (and pushes nothing)', async () => {
    const s = mkStream('thinking');
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 1 });
    s._onAgentEvent(ev({ event: 'stop', subtype: 'success' }));
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    await vi.advanceTimersByTimeAsync(0);
    expect(contract().filter((x) => x.startsWith('status:'))).toEqual([]);
    expect(pushMocks.sendPushToAll).not.toHaveBeenCalled();
    expect(s.status).toBe('thinking');
    expect(row().status).toBe('thinking');
  });

  it('the failed path is unchanged: failed, not active, then unread and the error push', async () => {
    const s = mkStream('thinking');
    s._onAgentEvent(ev({ event: 'stop', subtype: 'error', is_error: true, api_error_status: 500 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(contract()).toEqual(['stop', 'status:failed', 'unread:true', 'push:session_error', 'telegram:session_error']);
    expect(row().status).toBe('failed');
  });

  it('a crash (fatal error, no stop) marks unread before its push', async () => {
    const s = mkStream('thinking');
    s._onAgentEvent(ev({ event: 'error', msg: 'client transport died', fatal: true }));
    s._onAgentEvent(ev({ event: 'status', status: 'error' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(contract()).toEqual(['unread:true', 'push:session_error', 'telegram:session_error', 'status:error']);
    expect(row()).toMatchObject({ status: 'error', unreadStop: 1 });
  });

  it('the background path is unchanged: background, no unread, the background push', async () => {
    const s = mkStream('thinking');
    s._onAgentEvent(ev({ event: 'bg_task', kind: 'started', task_id: 'bt1', tool_use_id: 'tu' }));
    order.log = [];
    s._onAgentEvent(ev({ event: 'stop', subtype: 'success' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(contract()).toEqual(['stop', 'status:background', 'push:session_background', 'telegram:session_background']);
    expect(row()).toMatchObject({ status: 'background', unreadStop: 0 });
  });
});

describe('background finish: unread before its push (G6)', () => {
  it('orders unread → push → Telegram after the grace', async () => {
    const s = mkStream('thinking');
    s._onAgentEvent(ev({ event: 'bg_task', kind: 'started', task_id: 'bt2', tool_use_id: 'tu' }));
    s._onAgentEvent(ev({ event: 'stop', subtype: 'success' }));
    await vi.advanceTimersByTimeAsync(0);
    order.log = [];
    s._onAgentEvent(ev({ event: 'bg_task', kind: 'finished', task_id: 'bt2', status: 'completed', terminal: true }));
    expect(contract()).toEqual(['status:active']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(contract()).toEqual(['status:active', 'unread:true', 'push:session_finished', 'telegram:session_finished']);
    expect(row()).toMatchObject({ status: 'active', unreadStop: 1 });
  });
});

describe('unread gaps', () => {
  it('U1: a task revealed after the stop clears the marker AND publishes it', () => {
    const s = mkStream('thinking');
    s._onAgentEvent(ev({ event: 'stop', subtype: 'success' }));
    expect(row().unreadStop).toBe(1);
    order.log = [];
    s._onAgentEvent(ev({ event: 'bg_task', kind: 'started', task_id: 'late', tool_use_id: 'tu' }));
    expect(contract()).toEqual(['status:background', 'unread:false']);
    expect(row()).toMatchObject({ status: 'background', unreadStop: 0 });
  });

  it('U3: a user send marks the session read', async () => {
    db.update(schema.agentSessions).set({ unreadStop: 1, status: 'active' }).where(eq(schema.agentSessions.id, SID)).run();
    const { subscribeGlobalSessionEvents } = await import('@/lib/server/agent/sessionOps');
    const seen: any[] = [];
    const off = subscribeGlobalSessionEvents((e: any) => { if (e.sessionId === SID) seen.push(e); });
    try {
      const s = mkStream('active');
      vi.useRealTimers();
      await s.sendUserMessage('next please');
      expect(row().unreadStop).toBe(0);
      expect(seen.filter((e) => e.type === 'session_unread')).toEqual([expect.objectContaining({ unread: false })]);
      expect(order.log).toContain('status:thinking');
    } finally {
      off();
    }
  });
});
