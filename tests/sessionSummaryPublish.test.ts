// C13 — `session_summary` PUBLICATION: once per tick and only on change; push
// trails summary (I17: `flushSummaryNow` before `sendPushToAll` for a stop, a
// background finish and a permission); every hub-originated status writer
// publishes through `setSessionStatusLocal` (R1 §3 S1–S7 + startNewSession);
// reconcile heals writes behind the bus; lifecycle snapshots at
// `currentRev()` reflect every frame ≤ it (I1); archive ⇒ null, unarchive ⇒
// summary; every action route's `sync.rev` ≥ its summary frame; VPS writers
// V1/V2/V6 publish the stored runtime. Real handlers, hermetic DB.
import { seedProviderAccounts } from './helpers/providerAccounts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { summaryKey } from '@/lib/sessionSummary';
import { AgentRpcError } from '@/lib/server/agent/types';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({ userId: 'u' })) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
const push = vi.hoisted(() => ({ sendPushToAll: vi.fn(async (_p: any) => {}) }));
vi.mock('@/lib/server/hub/webPush', () => push);
const telegram = vi.hoisted(() => ({
  sendPlainToTelegram: vi.fn(async (..._a: any[]) => {}),
  sendPermissionToTelegram: vi.fn(async (..._a: any[]) => {}),
}));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: telegram.sendPermissionToTelegram,
  sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: vi.fn(() => {}),
  sendPlainToTelegram: telegram.sendPlainToTelegram,
}));
const agent = vi.hoisted(() => ({
  call: vi.fn(async (..._args: any[]): Promise<any> => ({ ok: true })),
  status: 'connected' as string,
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {},
    call: agent.call,
    get status() { return agent.status; },
    hello: null,
  }),
  getAgentClient: () => ({ onStatus: () => () => {}, get status() { return agent.status; }, hello: null }),
  dropAgentClient: async () => {},
}));
const ssh = vi.hoisted(() => ({ exec: vi.fn(async (..._a: any[]): Promise<any> => ({ ok: true, code: 0, stdout: '', stderr: '' })) }));
vi.mock('@/lib/server/hub/sshExec', () => ({
  sshExec: ssh.exec,
  shQuote: (s: string) => `'${s}'`,
}));
// Spy on the bus's synchronous flush WITHOUT changing it (push-order checks).
vi.mock('@/lib/server/sync/syncBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/sync/syncBus')>();
  return { ...actual, flushSummaryNow: vi.fn(actual.flushSummaryNow) };
});

const VPS_ID = 'pubvps';
const A = 'a2'.repeat(16);
const B = 'b2'.repeat(16);

let db: any;
let schema: any;
let ops: typeof import('@/lib/server/agent/sessionOps');
let sums: typeof import('@/lib/server/sync/sessionSummaries');
let bus: typeof import('@/lib/server/sync/syncBus');
type F = { rev: number; type: string; sessionId: string | null; ev: any };
let frames: F[] = [];
let off: (() => void) | null = null;

const tick = () => new Promise<void>((r) => setImmediate(r));
const summaries = (id: string) => frames.filter((f) => f.type === 'session_summary' && f.sessionId === id);
const lastSummary = (id: string) => summaries(id).at(-1)?.ev.summary;
const statusFrames = (id: string) => frames.filter((f) => f.type === 'status' && f.sessionId === id).map((f) => f.ev.status);
const row = (id: string) => db.select().from(schema.agentSessions).all().find((r: any) => r.id === id);

function insertSession(id: string, extra: Record<string, unknown> = {}) {
  db.insert(schema.agentSessions).values({
    id, vpsId: VPS_ID, cwd: '/tmp/pub', name: id.slice(0, 4), status: 'active', ...extra,
  }).run();
}
function clearStreams() {
  for (const s of ops.listStreams()) s.detach();
  (globalThis as any)._sessionStreams?.clear();
}
function stream(id: string, status = 'active'): any {
  const s = ops.getOrCreateStream(id)! as any;
  s.status = status;
  return s;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) => new Request('http://hub.test/api', {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
});

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'pub-vps', ip: '127.0.0.1', sshUser: 'root', agentStatus: 'ok' })
    .onConflictDoNothing().run();
  seedProviderAccounts(db, schema);
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ops = await import('@/lib/server/agent/sessionOps');
  sums = await import('@/lib/server/sync/sessionSummaries');
  bus = await import('@/lib/server/sync/syncBus');
});

beforeEach(async () => {
  clearStreams();
  db.delete(schema.sessionMessages).run();
  db.delete(schema.sessionPendingPermissions).run();
  db.delete(schema.sessionPendingQuestions).run();
  db.delete(schema.agentSessions).run();
  agent.call.mockReset();
  agent.call.mockResolvedValue({ ok: true });
  agent.status = 'connected';
  push.sendPushToAll.mockClear();
  telegram.sendPlainToTelegram.mockClear();
  (bus.flushSummaryNow as any).mockClear();
  ssh.exec.mockReset();
  insertSession(A);
  insertSession(B);
  // A clean slate: both summaries known (as after a list GET), no frames.
  await tick();
  sums.resetSessionSummariesForTests();
  sums.reconcileAllSummaries();
  frames = [];
  off = bus.subscribeFrames((f, ev) => { frames.push({ rev: f.rev, type: f.type, sessionId: f.sessionId, ev }); });
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await tick();
  off?.();
  off = null;
  clearStreams();
});

describe('one frame per tick, only on change', () => {
  it('a status flip and an unread clear in the same tick publish ONE summary', async () => {
    db.update(schema.agentSessions).set({ unreadStop: 1 }).run();
    sums.reconcileAllSummaries();
    frames = [];
    const s = stream(A);
    s._onAgentEvent({ event: 'status', session_id: A, status: 'thinking' });
    // Two summary triggers on the wire (status, session_unread)…
    expect(frames.map((f) => f.type)).toEqual(expect.arrayContaining(['status', 'session_unread']));
    expect(summaries(A)).toHaveLength(0);
    await tick();
    // …one summary carrying both facts.
    expect(summaries(A)).toHaveLength(1);
    expect(lastSummary(A)).toMatchObject({ id: A, liveStatus: 'thinking', unreadStop: 0, attention: null });
    // Published after the frames that caused it.
    const statusRev = frames.find((f) => f.type === 'status')!.rev;
    expect(summaries(A)[0].rev).toBeGreaterThan(statusRev);
  });

  it('an unchanged key publishes nothing (volatile fields included)', async () => {
    bus.markSummaryDirty(A);
    await tick();
    expect(summaries(A)).toHaveLength(0);
    db.update(schema.agentSessions).set({ lastSeenSeq: 42, lastUsedAt: 123 }).run();
    bus.markSummaryDirty(A);
    await tick();
    expect(summaries(A)).toHaveLength(0);
    db.update(schema.agentSessions).set({ color: '#0f0' }).where(eq(schema.agentSessions.id, A)).run();
    bus.markSummaryDirty(A);
    await tick();
    expect(summaries(A)).toHaveLength(1);
    expect(lastSummary(A).color).toBe('#0f0');
  });

  it('a vps_status re-evaluates every session of that VPS', async () => {
    db.update(schema.vps).set({ agentVersion: '99.0.0' }).run();
    db.update(schema.agentSessions).set({ handle: 'h-a' }).where(eq(schema.agentSessions.id, A)).run();
    ops.emitGlobalVpsStatus(VPS_ID, 'ok', { agentVersion: '99.0.0' });
    await tick();
    // A became addressable (handle + recent agent + live status); B did not change.
    expect(lastSummary(A)).toMatchObject({ handle: 'h-a', addressable: true });
    expect(summaries(B)).toHaveLength(0);
  });
});

describe('push trails summary (I17)', () => {
  const flushOrder = (id: string) => (bus.flushSummaryNow as any).mock.calls
    .map((c: any[], i: number) => (c[0] === id ? (bus.flushSummaryNow as any).mock.invocationCallOrder[i] : null))
    .filter((n: number | null) => n != null) as number[];

  it('stop: the summary is flushed before the push', async () => {
    const s = stream(A, 'thinking');
    s._onAgentEvent({ event: 'assistant_text', session_id: A, delta: 'done', seq: 1 });
    s._onAgentEvent({ event: 'stop', session_id: A, subtype: 'end_turn', seq: 2 });
    expect(push.sendPushToAll).toHaveBeenCalledTimes(1);
    const pushAt = push.sendPushToAll.mock.invocationCallOrder[0];
    expect(flushOrder(A).some((n) => n < pushAt)).toBe(true);
    // …and the Telegram message after both.
    expect(telegram.sendPlainToTelegram.mock.invocationCallOrder[0]).toBeGreaterThan(pushAt);
  });

  it('background finish (fake timers): flush before the deferred push', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const s = stream(A, 'thinking');
    const bg = (seq: number, kind: string) => ({
      event: 'bg_task', session_id: A, seq, kind, task_id: 't1', ts: Date.now() / 1000,
    });
    s._onAgentEvent(bg(1, 'started'));
    s._onAgentEvent({ event: 'stop', session_id: A, subtype: 'end_turn', seq: 2 });
    s._onAgentEvent({ event: 'status', session_id: A, status: 'active', seq: 3 });
    push.sendPushToAll.mockClear();
    (bus.flushSummaryNow as any).mockClear();
    s._onAgentEvent(bg(4, 'finished'));
    vi.advanceTimersByTime(10_000);
    const finish = push.sendPushToAll.mock.calls.findIndex((c: any[]) => c[0].body === 'background tasks finished');
    expect(finish).toBeGreaterThanOrEqual(0);
    const pushAt = push.sendPushToAll.mock.invocationCallOrder[finish];
    expect(flushOrder(A).some((n) => n < pushAt)).toBe(true);
  });

  it('permission request: the summary frame carrying the gate precedes the push', () => {
    const s = stream(A, 'thinking');
    let framesAtPush = -1;
    push.sendPushToAll.mockImplementationOnce(async () => { framesAtPush = frames.length; });
    s._onAgentEvent({ event: 'permission_request', session_id: A, id: 'perm-1', tool: 'Bash', input: { command: 'rm -rf /tmp/x' }, seq: 1 });
    expect(push.sendPushToAll).toHaveBeenCalledTimes(1);
    const before = frames.slice(0, framesAtPush).filter((f) => f.type === 'session_summary' && f.sessionId === A);
    expect(before).toHaveLength(1);
    expect(before[0].ev.summary).toMatchObject({ attention: 'blocked', pendingBlocking: 1 });
    expect(before[0].ev.summary.gates[0]).toMatchObject({ id: 'perm-1', kind: 'permission', title: 'Bash' });
    expect(before[0].ev.summary.gates[0].preview).toContain('rm -rf /tmp/x');
  });
});

describe('silent status writers now publish (R1 §3)', () => {
  it('S1 autoConnect: a failed boot resume of an unreachable agent ⇒ sleeping everywhere', async () => {
    agent.status = 'disconnected';
    agent.call.mockRejectedValue(new Error('agent not connected'));
    const s = stream(A, 'active');
    db.update(schema.agentSessions).set({ status: 'sleeping' }).where(eq(schema.agentSessions.id, B)).run();
    const prev = process.env.CHARON_DISABLE_AUTOCONNECT;
    delete process.env.CHARON_DISABLE_AUTOCONNECT;
    (globalThis as any)._agentBooted = false;
    const { autoConnectAgentsIfNeeded } = await import('@/lib/server/agent/autoConnect');
    try {
      autoConnectAgentsIfNeeded();
      for (let i = 0; i < 20 && row(A).status !== 'sleeping'; i++) await tick();
    } finally {
      if (prev !== undefined) process.env.CHARON_DISABLE_AUTOCONNECT = prev;
      (globalThis as any).__charonSweeper?.timer && clearInterval((globalThis as any).__charonSweeper.timer);
    }
    expect(row(A).status).toBe('sleeping');
    expect(s.status).toBe('sleeping');
    expect(statusFrames(A)).toContain('sleeping');
    await tick();
    expect(lastSummary(A)).toMatchObject({ liveStatus: 'sleeping', status: 'sleeping' });
  });

  it('S2 reconcile: a failed resume of a DB-running session updates memory, DB and tabs', async () => {
    const s = stream(A, 'active');
    agent.call.mockRejectedValue(new Error('cwd gone'));
    await ops.reconcileVpsAgentState(VPS_ID, []);
    for (let i = 0; i < 20 && s.status !== 'sleeping'; i++) await tick();
    expect(s.status).toBe('sleeping');
    expect(row(A).status).toBe('sleeping');
    expect(statusFrames(A)).toContain('sleeping');
    await tick();
    expect(lastSummary(A)).toMatchObject({ liveStatus: 'sleeping' });
  });

  it('S8 reconcile: a background session the agent calls idle is published as background', async () => {
    db.update(schema.agentSessions).set({ status: 'background' }).where(eq(schema.agentSessions.id, A)).run();
    const s = stream(A, 'background');
    s._onAgentEvent({ event: 'bg_task', session_id: A, seq: 1, kind: 'started', task_id: 't9', ts: Date.now() / 1000 });
    s.status = 'active';   // a stale in-memory status
    await ops.reconcileVpsAgentState(VPS_ID, [{ session_id: A, status: 'active' } as any]);
    expect(s.status).toBe('background');
    expect(statusFrames(A)).toContain('background');
  });

  it('S3 forceStop: an RPC failure still publishes the sleeping the DB holds', async () => {
    const s = stream(A, 'thinking');
    agent.call.mockRejectedValue(new Error('timeout on force_stop'));
    await expect(ops.forceStopSession(A)).rejects.toThrow(/force_stop/);
    expect(row(A).status).toBe('sleeping');
    expect(s.status).toBe('sleeping');
    expect(statusFrames(A)).toEqual(['sleeping']);
    // No stream and no agent: the DB intent is published too.
    clearStreams();
    frames = [];
    await ops.forceStopSession(B);
    expect(statusFrames(B)).toEqual(['sleeping']);
  });

  it('S4 sendUserMessage: a resume failure writes sleeping to memory, DB and tabs', async () => {
    const s = stream(A, 'active');
    agent.call.mockImplementation(async (method: string) => {
      if (method === 'send_input') throw new Error('session not running (status=sleeping)');
      throw new Error('resume refused');
    });
    await expect(s.sendUserMessage('hi')).rejects.toThrow();
    expect(s.status).toBe('sleeping');
    expect(row(A).status).toBe('sleeping');
    expect(statusFrames(A).at(-1)).toBe('sleeping');
  });

  it('the window GET serves the stream\'s known pending-apply flags; a live starting clears them', async () => {
    const s = stream(A, 'active');
    const { GET } = await import('@/app/api/sessions/[id]/route');
    const get = async () => (await (await GET(new Request(`http://hub.test/api/sessions/${A}`), params(A))).json());
    expect((await get()).pendingApply).toBeUndefined();          // unknown since boot
    s._onAgentEvent({ event: 'effort_changed', session_id: A, effort: 'high', applied_at_next_start: true, seq: 1 });
    expect((await get()).pendingApply).toEqual({ effort: true });
    s._onAgentEvent({ event: 'status', session_id: A, status: 'starting', seq: 2 });
    expect((await get()).pendingApply).toEqual({ model: false, effort: false });
  });

  it('S4 sendUserMessage: resume OK + the retried send_input failing never writes sleeping', async () => {
    const s = stream(A, 'active');
    let sends = 0;
    agent.call.mockImplementation(async (method: string) => {
      if (method === 'send_input') {
        sends++;
        throw new Error(sends === 1 ? 'session not running (status=sleeping)' : 'connection reset');
      }
      if (method === 'resume_session') return { ok: true, status: 'active' };
      return { ok: true };
    });
    await expect(s.sendUserMessage('hi')).rejects.toThrow(/connection reset/);
    expect(sends).toBe(2);
    expect(row(A).status).not.toBe('sleeping');
    expect(s.status).not.toBe('sleeping');
    expect(statusFrames(A)).not.toContain('sleeping');
  });

  it('S4 sendUserMessage: a non-resumable failure reverts the optimistic thinking', async () => {
    const s = stream(A, 'active');
    agent.call.mockRejectedValue(new Error('agent unreachable'));
    await expect(s.sendUserMessage('hi')).rejects.toThrow(/unreachable/);
    expect(statusFrames(A)).toEqual(['thinking', 'active']);
    expect(s.status).toBe('active');
    expect(row(A).status).toBe('active');
    // A second ambiguous timeout too.
    frames = [];
    agent.call.mockRejectedValue(new Error('timeout on send_input'));
    await expect(s.sendUserMessage('again')).rejects.toThrow(/timeout/);
    expect(statusFrames(A)).toEqual(['thinking', 'active']);
  });

  it('S9 restartSession: a sleep the agent never echoed + a failed resume still publishes sleeping', async () => {
    const s = stream(A, 'active');
    agent.call.mockImplementation(async (method: string) => {
      if (method === 'sleep_session') throw new AgentRpcError(-32000, 'session not found');
      throw new Error('vps unreachable');
    });
    await expect(ops.restartSession(A)).rejects.toThrow();
    expect(row(A)).toMatchObject({ status: 'sleeping', sleepRequested: 0 });
    expect(s.status).toBe('sleeping');
    expect(statusFrames(A)).toContain('sleeping');
    await tick();
    expect(lastSummary(A)).toMatchObject({ liveStatus: 'sleeping' });
  });

  it('startNewSession: a failed start_session publishes `error`', async () => {
    agent.call.mockImplementation(async (method: string) => {
      if (method === 'start_session') throw new Error('cannot start');
      return { ok: true, profiles: [] };
    });
    await expect(ops.startNewSession({ vpsId: VPS_ID, cwd: '/tmp/new', kind: 'claude' } as any)).rejects.toThrow();
    const created = db.select().from(schema.agentSessions).all().find((r: any) => r.id !== A && r.id !== B);
    expect(created.status).toBe('error');
    expect(statusFrames(created.id)).toContain('error');
    await tick();
    expect(lastSummary(created.id)).toMatchObject({ status: 'error', liveStatus: 'error' });
  });
});

describe('reconcile and lifecycle snapshots', () => {
  it('reconcile publishes a diff for a row mutated behind the bus and null for a deleted one', () => {
    db.update(schema.agentSessions).set({ name: 'renamed behind the bus' })
      .where(eq(schema.agentSessions.id, A)).run();
    db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, B)).run();
    const all = sums.reconcileAllSummaries();
    expect(all.map((s) => s.id)).toEqual([A]);
    expect(summaries(A)).toHaveLength(1);
    expect(lastSummary(A).name).toBe('renamed behind the bus');
    expect(summaries(B)).toHaveLength(1);
    expect(lastSummary(B)).toBeNull();
    // Idempotent: a second reconcile publishes nothing.
    frames = [];
    sums.reconcileAllSummaries();
    expect(frames.filter((f) => f.type === 'session_summary')).toHaveLength(0);
  });

  it('a snapshot at currentRev() reflects every frame ≤ it, for each lifecycle helper (I1)', async () => {
    const check = () => {
      bus.flushSummaries();
      const rev = bus.currentRev().rev;
      for (const id of [A, B]) {
        const last = frames.filter((f) => f.type === 'session_summary' && f.sessionId === id && f.rev <= rev).at(-1);
        const fresh = sums.buildSessionSummary(id);
        if (!last) continue;
        if (fresh == null) expect(last.ev.summary).toBeNull();
        else expect(summaryKey(last.ev.summary)).toBe(summaryKey(fresh));
      }
    };
    stream(A, 'active');
    ops.setSessionStatusLocal(A, 'thinking', { persist: false });
    check();
    await ops.sleepSession(A);
    check();
    ops.setSessionStatusLocal(B, 'error');
    check();
    await ops.deleteSession(B);
    check();
    expect(lastSummary(B)).toBeNull();
  });

  it('deleteSession republishes the siblings its path pack moved (I9)', async () => {
    const C = 'c2'.repeat(16);
    db.update(schema.agentSessions).set({ cwd: '/p1', position: 0 }).where(eq(schema.agentSessions.id, A)).run();
    db.update(schema.agentSessions).set({ cwd: '/p2', position: 1 }).where(eq(schema.agentSessions.id, B)).run();
    insertSession(C, { cwd: '/p1', position: 2 });
    sums.reconcileAllSummaries();
    frames = [];
    await ops.deleteSession(A);
    await tick();
    expect(row(C).position).toBe(0);
    expect(lastSummary(C)).toMatchObject({ position: 0 });
    // Nothing left for a reconcile to heal.
    frames = [];
    sums.reconcileAllSummaries();
    expect(summaries(C)).toHaveLength(0);
  });

  it('summary caches: the first prompt is cached bounded; a deleted session\'s texts are dropped', async () => {
    db.insert(schema.sessionMessages).values({ sessionId: A, role: 'user', content: 'x'.repeat(50_000) }).run();
    db.insert(schema.sessionPendingPermissions).values({ id: 'perm-cache', sessionId: A, toolName: 'Bash', toolInput: '{}' }).run();
    sums.resetSessionSummariesForTests();
    sums.reconcileAllSummaries();
    const S = (globalThis as any).__charonSummaries;
    expect(S.firstUserMsg.get(A)).toHaveLength(180);
    expect([...S.gateText.values()].some((t: any) => t.sessionId === A)).toBe(true);
    await ops.deleteSession(A);
    await tick();
    expect(S.firstUserMsg.has(A)).toBe(false);
    expect([...S.gateText.values()].some((t: any) => t.sessionId === A)).toBe(false);
  });

  it('deleteSession publishes ONE null summary', async () => {
    await ops.deleteSession(A);
    await tick();
    expect(summaries(A).map((f) => f.ev.summary)).toEqual([null]);
  });

  it('archive ⇒ null, unarchive ⇒ the summary again', async () => {
    const route = await import('@/app/api/sessions/[id]/archive/route');
    stream(A, 'active');
    const r1 = await (await route.POST(req('POST'), params(A))).json();
    expect(r1).toMatchObject({ ok: true, archived: true });
    expect(lastSummary(A)).toBeNull();
    expect(statusFrames(A)).toContain('sleeping');
    const r2 = await (await route.DELETE(req('DELETE'), params(A))).json();
    expect(r2).toMatchObject({ ok: true, archived: false });
    expect(lastSummary(A)).toMatchObject({ id: A, archived: 0, liveStatus: 'sleeping' });
    expect(summaries(A).at(-1)!.rev).toBeLessThanOrEqual(r2.sync.rev);
  });
});

describe('PATCH cwd: the kill echo is not a deletion (S7)', () => {
  it('ONE killed echo of the hub\'s own kill becomes sleeping; the next killed is real', async () => {
    const s = stream(A, 'active');
    s._onAgentEvent({ event: 'bg_task', session_id: A, seq: 1, kind: 'started', task_id: 'tk', ts: Date.now() / 1000 });
    s._onAgentEvent({ event: 'tool_progress', session_id: A, tool_use_id: 'tu-run', delta: 'line 1\n' } as any);
    expect(s.getStreamingToolOutput()).toHaveLength(1);
    agent.call.mockImplementation(async (method: string) => {
      // The agent echoes its own kill before answering the RPC.
      if (method === 'kill_session') s._onAgentEvent({ event: 'status', session_id: A, status: 'killed' });
      return { ok: true };
    });
    const route = await import('@/app/api/sessions/[id]/route');
    const res = await (await route.PATCH(req('PATCH', { cwd: '/tmp/elsewhere' }), params(A))).json();
    expect(res.cwd).toBe('/tmp/elsewhere');
    expect(statusFrames(A)).not.toContain('killed');
    expect(s.status).toBe('sleeping');
    expect(row(A).status).toBe('sleeping');
    expect(s.cwd).toBe('/tmp/elsewhere');
    // The killed instance's tool output is gone (W2 integration: C12 × C13).
    expect(s.getStreamingToolOutput()).toEqual([]);
    // No bg burial: the task row stays as it was (no synthetic terminal row).
    const buried = db.select().from(schema.sessionMessages).all()
      .filter((m: any) => m.role === 'event' && /"kind":"(stale|killed|expired)"/.test(m.content));
    expect(buried).toHaveLength(0);
    expect(lastSummary(A)).toMatchObject({ cwd: '/tmp/elsewhere', liveStatus: 'sleeping' });
    expect(summaries(A).at(-1)!.rev).toBeLessThanOrEqual(res.sync.rev);
    // The flag is consumed: a later real `killed` is the deletion signal again.
    s._onAgentEvent({ event: 'status', session_id: A, status: 'killed' });
    expect(statusFrames(A)).toContain('killed');
  });

  it('a turn-end status crossing the kill does not consume the flag; no echo ⇒ the flag is cleared', async () => {
    const s = stream(A, 'thinking');
    agent.call.mockImplementation(async (method: string) => {
      if (method === 'kill_session') {
        s._onAgentEvent({ event: 'status', session_id: A, status: 'active' });   // already on the wire
        s._onAgentEvent({ event: 'status', session_id: A, status: 'killed' });   // the echo
      }
      return { ok: true };
    });
    const route = await import('@/app/api/sessions/[id]/route');
    await (await route.PATCH(req('PATCH', { cwd: '/tmp/race' }), params(A))).json();
    expect(statusFrames(A)).not.toContain('killed');
    expect(s.status).toBe('sleeping');
    // A kill the agent did not echo (unknown session): the flag waits, and the
    // new instance's live `starting` clears it.
    agent.call.mockResolvedValue({ ok: true });
    await (await route.PATCH(req('PATCH', { cwd: '/tmp/race2' }), params(A))).json();
    expect(s.expectKilledEcho).toBe(true);
    s._onAgentEvent({ event: 'status', session_id: A, status: 'starting' });
    expect(s.expectKilledEcho).toBe(false);
  });

  it('an echo HELD by a subscribe replay lands after the PATCH answered: still sleeping, never a durable killed', async () => {
    const s = stream(A, 'active');
    agent.call.mockResolvedValue({ ok: true });                  // the answer overtakes the held echo
    const route = await import('@/app/api/sessions/[id]/route');
    await (await route.PATCH(req('PATCH', { cwd: '/tmp/held' }), params(A))).json();
    expect(row(A).status).toBe('sleeping');
    s._onAgentEvent({ event: 'status', session_id: A, status: 'killed' });   // released hold
    expect(statusFrames(A)).not.toContain('killed');
    expect(s.status).toBe('sleeping');
    expect(row(A).status).toBe('sleeping');
    expect(s.expectKilledEcho).toBe(false);
  });

  it('an unexpected live killed on a row that still exists is persisted as sleeping, never killed', () => {
    const s = stream(A, 'active');
    s._onAgentEvent({ event: 'status', session_id: A, status: 'killed' });
    expect(statusFrames(A)).toContain('killed');                  // the transient signal still goes out
    expect(row(A).status).toBe('sleeping');
  });

  it('the killed-echo flag expires: a kill echo long after the PATCH is a real killed again', () => {
    const s = stream(A, 'active');
    s.armKilledEcho(Date.now() - 6 * 60_000);
    s._onAgentEvent({ event: 'status', session_id: A, status: 'killed' });
    expect(statusFrames(A)).toContain('killed');
    expect(s.expectKilledEcho).toBe(false);
  });

  it('PATCH name updates the hydrated stream (push labels) and publishes', async () => {
    const s = stream(A, 'active');
    const route = await import('@/app/api/sessions/[id]/route');
    const res = await (await route.PATCH(req('PATCH', { name: 'Renamed', color: '#123456' }), params(A))).json();
    expect(s.name).toBe('Renamed');
    expect(lastSummary(A)).toMatchObject({ name: 'Renamed', color: '#123456' });
    expect(summaries(A).at(-1)!.rev).toBeLessThanOrEqual(res.sync.rev);
  });
});

describe('action routes: summary frame rev ≤ response sync.rev', () => {
  async function expectCovered(id: string, res: Response, match?: Record<string, unknown> | null) {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.sync).toEqual({ epoch: bus.epoch(), rev: expect.any(Number) });
    const mine = summaries(id);
    expect(mine.length).toBeGreaterThan(0);
    // The frame carrying the action is already on the bus when the response is built.
    const covered = mine.filter((f) => f.rev <= body.sync.rev);
    expect(covered.length).toBe(mine.length);
    if (match === null) expect(covered.at(-1)!.ev.summary).toBeNull();
    else if (match) expect(covered.at(-1)!.ev.summary).toMatchObject(match);
    return body;
  }

  it('sleep', async () => {
    stream(A, 'active');
    const r = await import('@/app/api/sessions/[id]/sleep/route');
    await expectCovered(A, await r.POST(req('POST'), params(A)), { liveStatus: 'sleeping' });
  });

  it('resume', async () => {
    db.update(schema.agentSessions).set({ status: 'sleeping' }).where(eq(schema.agentSessions.id, A)).run();
    stream(A, 'sleeping');
    sums.reconcileAllSummaries();
    frames = [];
    agent.call.mockImplementation(async (method: string) => (method === 'resume_session' ? { ok: true, status: 'active' } : { ok: true, profiles: [] }));
    const r = await import('@/app/api/sessions/[id]/resume/route');
    await expectCovered(A, await r.POST(req('POST'), params(A)), { liveStatus: 'active' });
  });

  it('force-stop', async () => {
    stream(A, 'thinking');
    const r = await import('@/app/api/sessions/[id]/force-stop/route');
    await expectCovered(A, await r.POST(req('POST'), params(A)), { liveStatus: 'sleeping' });
  });

  it('permission', async () => {
    const s = stream(A, 'thinking');
    s._onAgentEvent({ event: 'permission_request', session_id: A, id: 'perm-r', tool: 'Bash', input: {}, seq: 1 });
    await tick();
    frames = [];
    agent.call.mockResolvedValue({ ok: true, resolved: true });
    const r = await import('@/app/api/sessions/[id]/permission/route');
    await expectCovered(A, await r.POST(req('POST', { id: 'perm-r', allow: true }), params(A)), { pendingBlocking: 0, gates: [] });
  });

  it('input', async () => {
    stream(A, 'active');
    agent.call.mockImplementation(async (method: string) => (method === 'send_input' ? { ok: true } : { ok: true }));
    const r = await import('@/app/api/sessions/[id]/input/route');
    const body = await expectCovered(A, await r.POST(req('POST', { content: 'hello', clientMessageId: 'cm-sync-1' }), params(A)),
      { liveStatus: 'thinking' });
    expect(body).toMatchObject({ ok: true, clientMessageId: 'cm-sync-1' });
  });

  it('PATCH and DELETE', async () => {
    const r = await import('@/app/api/sessions/[id]/route');
    await expectCovered(A, await r.PATCH(req('PATCH', { color: '#abcdef' }), params(A)), { color: '#abcdef' });
    await expectCovered(A, await r.DELETE(req('DELETE'), params(A)), null);
  });

  it('reorder', async () => {
    const r = await import('@/app/api/sessions/reorder/route');
    const body = await expectCovered(A, await r.POST(req('POST', { vpsId: VPS_ID, ids: [B, A] })), { position: 1 });
    // Every summary the reorder published (the whole VPS was re-evaluated).
    for (const f of frames.filter((x) => x.type === 'session_summary')) expect(f.rev).toBeLessThanOrEqual(body.sync.rev);
  });

  it('bulk-delete', async () => {
    db.update(schema.agentSessions).set({ status: 'sleeping' }).run();
    const r = await import('@/app/api/sessions/bulk-delete/route');
    const body = await expectCovered(A, await r.POST(req('POST', { ids: [A, B] })), null);
    expect(body.deleted.sort()).toEqual([A, B].sort());
    expect(summaries(B).at(-1)!.ev.summary).toBeNull();
  });

  it('rollback publishes transcript_reset and the new status', async () => {
    const msg = db.insert(schema.sessionMessages).values({ sessionId: A, role: 'user', content: 'first' }).returning().get();
    db.insert(schema.sessionMessages).values({ sessionId: A, role: 'assistant', content: 'answer' }).run();
    sums.buildSessionSummary(A);   // caches the first prompt
    agent.call.mockResolvedValue({ claude_session_id: 'fork-1', strategy: 'fork' });
    const r = await import('@/app/api/sessions/[id]/rollback/route');
    const body = await expectCovered(A, await r.POST(req('POST', { messageId: `m${msg.id}` }), params(A)));
    expect(frames.find((f) => f.type === 'transcript_reset' && f.sessionId === A)?.ev).toMatchObject({ reason: 'rollback' });
    expect(lastSummary(A).firstUserMessage).toBeNull();
    expect(lastSummary(A).liveStatus).toBe(row(A).status);
    expect(body.ok).toBe(true);
  });

  // W2 review: the remaining §3.5 action routes (the guarantee was untested).
  it('restart', async () => {
    stream(A, 'active');
    agent.call.mockImplementation(async (method: string) => (method === 'resume_session' ? { ok: true, status: 'active' } : { ok: true, profiles: [] }));
    const r = await import('@/app/api/sessions/[id]/restart/route');
    await expectCovered(A, await r.POST(req('POST'), params(A)), { liveStatus: 'active' });
    expect(statusFrames(A)).toContain('sleeping');
  });

  it('question', async () => {
    const s = stream(A, 'thinking');
    s._onAgentEvent({ event: 'user_question', session_id: A, id: 'q-r', questions: [{ question: 'Which?', options: [{ label: 'One' }] }], seq: 1 });
    await tick();
    expect(lastSummary(A)).toMatchObject({ pendingBlocking: 1 });
    frames = [];
    agent.call.mockResolvedValue({ ok: true, resolved: true });
    const r = await import('@/app/api/sessions/[id]/question/route');
    await expectCovered(A, await r.POST(req('POST', { id: 'q-r', answers: { 'Which?': 'One' } }), params(A)),
      { pendingBlocking: 0, gates: [] });
  });

  it('exit-plan', async () => {
    stream(A, 'thinking');
    db.insert(schema.sessionPendingQuestions).values({
      id: 'x-r', sessionId: A, kind: 'exit_plan', status: 'pending', payload: JSON.stringify({ plan: 'p' }),
    }).run();
    sums.reconcileAllSummaries();
    await tick();
    expect(lastSummary(A)).toMatchObject({ pendingBlocking: 1 });
    frames = [];
    agent.call.mockResolvedValue({ ok: true, resolved: true });
    const r = await import('@/app/api/sessions/[id]/exit-plan/route');
    await expectCovered(A, await r.POST(req('POST', { id: 'x-r', decision: 'approve' }), params(A)),
      { pendingBlocking: 0, gates: [] });
  });

  it('mode', async () => {
    const s = stream(A, 'active');
    agent.call.mockImplementation(async (method: string, p: any) => {
      if (method === 'set_permission_mode') s._onAgentEvent({ event: 'mode_changed', session_id: A, mode: p.mode });
      return { ok: true };
    });
    const r = await import('@/app/api/sessions/[id]/mode/route');
    await expectCovered(A, await r.POST(req('POST', { mode: 'bypass' }), params(A)), { permissionMode: 'bypass' });
  });

  it('model', async () => {
    const s = stream(A, 'active');
    agent.call.mockImplementation(async (method: string, p: any) => {
      if (method === 'set_model') s._onAgentEvent({ event: 'model_changed', session_id: A, model: p.model, fallback_model: null });
      return { ok: true };
    });
    const r = await import('@/app/api/sessions/[id]/model/route');
    await expectCovered(A, await r.POST(req('POST', { model: 'claude-sync-test' }), params(A)), { model: 'claude-sync-test' });
  });

  it('effort', async () => {
    const s = stream(A, 'active');
    agent.call.mockImplementation(async (method: string, p: any) => {
      if (method === 'set_effort') s._onAgentEvent({ event: 'effort_changed', session_id: A, effort: p.effort, applied_at_next_start: true });
      return { ok: true };
    });
    const r = await import('@/app/api/sessions/[id]/effort/route');
    await expectCovered(A, await r.POST(req('POST', { effort: 'high' }), params(A)), { effort: 'high' });
  });

  it('GET /api/tabs and GET /api/settings carry sync = currentRev()', async () => {
    const tabs = await import('@/app/api/tabs/route');
    const tb = await (await tabs.GET()).json();
    expect(tb.sync).toEqual(bus.currentRev());
    const settings = await import('@/app/api/settings/route');
    const st = await (await settings.GET()).json();
    expect(st.sync).toEqual(bus.currentRev());
  });
});

describe('VPS writers publish the stored runtime (§14.52)', () => {
  const vpsFrames = () => frames.filter((f) => f.type === 'vps_status' && f.sessionId === VPS_ID).map((f) => f.ev);

  it('the helper carries the REAL agentStatus and every runtime column', () => {
    db.update(schema.vps).set({ agentStatus: 'error', agentLastError: 'ssh-auth: denied', codexLoggedIn: 1 }).run();
    ops.emitGlobalVpsRuntimeFromDb(VPS_ID);
    expect(vpsFrames().at(-1)).toMatchObject({ agentStatus: 'error', agentLastError: 'ssh-auth: denied', codexLoggedIn: 1 });
    db.update(schema.vps).set({ agentStatus: 'ok', agentLastError: null, codexLoggedIn: null }).run();
  });

  it('V2: the Claude login check publishes what it stored', async () => {
    ssh.exec.mockResolvedValue({ ok: true, code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' });
    const { refreshClaudeLoginStatus } = await import('@/lib/server/agent/claudeLoginCheck');
    const v = db.select().from(schema.vps).all()[0];
    const r = await refreshClaudeLoginStatus(v);
    expect(r.ok).toBe(true);
    expect(vpsFrames().at(-1)).toMatchObject({ agentStatus: 'ok', claudeLoggedIn: 1 });
  });

  it('V6: a default-profile login change publishes the stored agentStatus, not a literal ok', async () => {
    db.update(schema.vps).set({ agentStatus: 'missing' }).run();
    agent.call.mockResolvedValue({ profiles: [{ ok: true, provider: 'codex', account_profile: 'default', logged_in: true, account_key: 'K1', generation: 'g1' }] });
    const { readProfileStatus } = await import('@/lib/server/agent/accountProfiles');
    await readProfileStatus(VPS_ID, 'codex', 'default', true);
    expect(vpsFrames().at(-1)).toMatchObject({ agentStatus: 'missing', codexLoggedIn: 1 });
    db.update(schema.vps).set({ agentStatus: 'ok' }).run();
  });
});
