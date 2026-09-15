import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'charon-update-')), 'test.db');
const mocks = vi.hoisted(() => ({
  call: vi.fn(), update: vi.fn(), hold: vi.fn(() => vi.fn()), drop: vi.fn(),
  subscribe: vi.fn(), resubscribe: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/claude/bootstrap', () => ({ updateVpsAgent: mocks.update }));
vi.mock('@/lib/server/agent/autoConnect', () => ({ armAgentClientHooks: vi.fn() }));
vi.mock('@/lib/server/claude/webPush', () => ({ sendPushToAll: vi.fn() }));
vi.mock('@/lib/server/claude/telegram', () => ({
  sendPermissionToTelegram: vi.fn(), sendQuestionToTelegram: vi.fn(),
  markInteractionResolvedInTelegram: vi.fn(), sendPlainToTelegram: vi.fn(),
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ call: mocks.call, status: 'connected',
    setAfterSeq: vi.fn(), subscribe: mocks.subscribe, unsubscribe: vi.fn(), resubscribe: mocks.resubscribe }),
  getAgentClient: () => ({ ready: async () => {} }),
  dropAgentClient: mocks.drop,
  holdAgentConnection: mocks.hold,
}));
let db: any, schema: any, ops: typeof import('@/lib/server/agent/sessionOps');
let runUpdate: typeof import('@/lib/server/claude/agentUpdate').runAgentUpdateFlow;
let vps: any, sid: string;
let counter = 0;
const row = () => db.select().from(schema.claudeSessions).all().find((r: any) => r.id === sid);
const logs = () => db.select().from(schema.claudeSessionLogs).all().filter((r: any) => r.sessionId === sid);

beforeAll(async () => {
  schema = await import('@/lib/db'); db = schema.db;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: 'update-vps', name: 'test', ip: '127.0.0.1', sshUser: 'root' }).run();
  vps = db.select().from(schema.vps).get();
  ops = await import('@/lib/server/agent/sessionOps');
  ({ runAgentUpdateFlow: runUpdate } = await import('@/lib/server/claude/agentUpdate'));
});
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  sid = `update-session-${++counter}`;
  db.delete(schema.claudeSessions).run();
  db.insert(schema.claudeSessions).values({ id: sid, vpsId: vps.id, cwd: '/tmp', status: 'active' }).run();
  mocks.update.mockImplementation(async () => ({ ok: true, detail: 'updated' }));
  mocks.call.mockImplementation(async (method: string) => method === 'list_sessions'
    ? [{ session_id: sid, status: 'active' }] : { ok: true, status: 'starting' });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('post-update recovery', () => {
  it('deduplicates overlapping manual/automatic updates and waits for actual readiness', async () => {
    let finishUpdate!: () => void;
    mocks.update.mockImplementation(() => new Promise((resolve) => {
      finishUpdate = () => resolve({ ok: true, detail: 'updated' });
    }));
    const first = runUpdate(vps), second = runUpdate(vps);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(row().resumePending).toBe(1);
    let status = 'starting';
    mocks.call.mockImplementation(async (method: string) => method === 'list_sessions'
      ? [{ session_id: sid, status }] : { ok: true, status: 'starting' });
    finishUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(row().resumePending).toBe(1);
    expect(logs().filter((r: any) => r.event === 'post_update_resume')).toHaveLength(0);
    status = 'active';
    await vi.advanceTimersByTimeAsync(500);
    expect((await first).resumedSessionIds).toEqual([sid]);
    expect(await second).toEqual(await first);
    expect(row().resumePending).toBe(0);
  });

  it('does not call a starting-then-sleeping session successfully resumed', async () => {
    mocks.call.mockImplementation(async (method: string) => method === 'list_sessions'
      ? [{ session_id: sid, status: 'sleeping' }] : { ok: true, status: 'starting' });
    const result = await runUpdate(vps);
    expect(result.resumedSessionIds).toEqual([]);
    expect(result.warnings?.join()).toContain('sleeping');
    expect(row().resumePending).toBe(1);
    expect(logs().some((r: any) => r.event === 'post_update_resume' && r.level === 'info')).toBe(false);
  });

  it('keeps startup failure visible instead of converting error to starting', async () => {
    mocks.call.mockResolvedValue({ ok: true, status: 'error' });
    const result = await runUpdate(vps);
    expect(result.resumedSessionIds).toEqual([]);
    expect(result.warnings?.join()).toContain('error');
    expect(row().resumePending).toBe(1);
  });

  it('recovers sessions even when deployment reports failure after stopping them', async () => {
    mocks.update.mockResolvedValue({ ok: false, detail: 'ping failed' });
    const result = await runUpdate(vps);
    expect(result.ok).toBe(false);
    expect(result.resumedSessionIds).toEqual([sid]);
    expect(mocks.hold.mock.results.at(-1)?.value).toHaveBeenCalled();
  });

  it('honors pause during deployment even after its sleeping acknowledgement', async () => {
    mocks.update.mockImplementation(async () => {
      await ops.sleepSession(sid);
      const stream = ops.peekStream(sid);
      (stream as any)?._onAgentEvent({ event: 'status', session_id: sid, status: 'sleeping' });
      return { ok: true, detail: 'updated' };
    });
    const result = await runUpdate(vps);
    expect(result.resumedSessionIds).toEqual([]);
    expect(mocks.call.mock.calls.some(([method]) => method === 'resume_session')).toBe(false);
  });

  it('preserves pending resume at starting, then clears it on a live active event', async () => {
    db.update(schema.claudeSessions).set({ resumePending: 1 }).run();
    const stream = await ops.resumeSession(sid);
    expect(row().resumePending).toBe(1);
    (stream as any)._onAgentEvent({ event: 'status', session_id: sid, status: 'active' });
    expect(row().resumePending).toBe(0);
  });

  it('keeps the intent when reconnect sees starting and retries an errored startup', async () => {
    db.update(schema.claudeSessions).set({ resumePending: 1, status: 'starting' }).run();
    await ops.reconcileVpsAgentState(vps.id, [{ session_id: sid, status: 'starting' } as any]);
    expect(row().resumePending).toBe(1);
    expect(mocks.call).not.toHaveBeenCalled();
    await ops.reconcileVpsAgentState(vps.id, [{ session_id: sid, status: 'error' } as any]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.call.mock.calls.some(([method]) => method === 'resume_session')).toBe(true);
    expect(row().resumePending).toBe(1);
  });

  it('bounds the readiness wait and preserves recovery intent on timeout', async () => {
    mocks.call.mockImplementation(async (method: string) => method === 'list_sessions'
      ? [{ session_id: sid, status: 'starting' }] : { ok: true, status: 'starting' });
    const pending = runUpdate(vps);
    await vi.advanceTimersByTimeAsync(45_000);
    const result = await pending;
    expect(result.resumedSessionIds).toEqual([]);
    expect(result.warnings?.join()).toContain('startup timed out');
    expect(row().resumePending).toBe(1);
  });
});
