import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// C07 — every removal of a human gate is PUBLISHED (G7): the 30 s sweeper and
// the GET/SSE sweeps (`expired`), a session leaving the live states, archive,
// rollback and delete (`cancelled`), and a respond on an already-resolved gate
// (its real outcome). Async questions are never swept nor cancelled (§14.96).
// Real handlers against the hermetic DB; agent, push and Telegram are mocked.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({ userId: 'u' })) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: vi.fn(async () => {}) }));
const telegram = vi.hoisted(() => ({
  markInteractionResolvedInTelegram: vi.fn((_kind: string, _id: string) => {}),
}));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: vi.fn(async () => {}),
  sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: telegram.markInteractionResolvedInTelegram,
  sendPlainToTelegram: vi.fn(async () => {}),
}));
const agent = vi.hoisted(() => ({ call: vi.fn(async (..._args: any[]): Promise<any> => ({ ok: true })) }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {},
    call: agent.call,
    status: 'connected',
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'gatevps';
const A = 'a7'.repeat(16);
const B = 'b7'.repeat(16);

let db: any;
let schema: any;
let ops: typeof import('@/lib/server/agent/sessionOps');
let frames: any[] = [];
let off: (() => void) | null = null;

const nowS = () => Math.floor(Date.now() / 1000);

function insertSession(id: string, extra: Record<string, unknown> = {}) {
  db.insert(schema.agentSessions).values({
    id, vpsId: VPS_ID, cwd: '/tmp/gates', name: id.slice(0, 4), status: 'active', ...extra,
  }).run();
}

function perm(id: string, sessionId: string, extra: Record<string, unknown> = {}) {
  db.insert(schema.sessionPendingPermissions).values({
    id, sessionId, toolName: 'Bash', toolInput: '{}', status: 'pending', ...extra,
  }).run();
}

function question(
  id: string, sessionId: string, kind: 'question' | 'async_question' | 'exit_plan' = 'question',
  extra: Record<string, unknown> = {},
) {
  db.insert(schema.sessionPendingQuestions).values({
    id, sessionId, kind, status: 'pending',
    payload: kind === 'exit_plan' ? JSON.stringify({ plan: 'the plan' })
      : JSON.stringify([{ question: 'Which colour?', options: [{ label: 'Orange' }] }]),
    ...extra,
  }).run();
}

/** Every gate row as `id → status` (both tables). */
function gateStatus(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.select().from(schema.sessionPendingPermissions).all()) out[r.id] = r.status;
  for (const r of db.select().from(schema.sessionPendingQuestions).all()) out[r.id] = r.status;
  return out;
}

/** The `interaction_resolved` frames published on the bus, in order. */
function resolved() {
  return frames.filter((f) => f.type === 'interaction_resolved')
    .map((f) => ({ sessionId: f.sessionId, kind: f.kind, id: f.id, outcome: f.outcome }));
}

function newStream(id: string) {
  return new ops.SessionStream({
    id, vpsId: VPS_ID, vpsName: 'gate-vps', name: 'gates', status: 'active',
    permissionMode: 'normal', nativeSessionId: null, kind: 'claude', cwd: '/tmp/gates',
  } as any) as any;
}

function clearStreams() {
  for (const s of ops.listStreams()) s.detach();
  (globalThis as any)._sessionStreams?.clear();
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'gate-vps', ip: '127.0.0.1', sshUser: 'root' })
    .onConflictDoNothing().run();
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ops = await import('@/lib/server/agent/sessionOps');
  // Preloaded: a first import racing the stop handlers' deferred import hits its TDZ.
  await import('@/lib/server/agent/endpointOps');
});

beforeEach(() => {
  clearStreams();
  db.delete(schema.sessionMessages).run();
  db.delete(schema.sessionPendingPermissions).run();
  db.delete(schema.sessionPendingQuestions).run();
  db.delete(schema.agentSessions).run();
  insertSession(A);
  insertSession(B);
  agent.call.mockReset();
  agent.call.mockResolvedValue({ ok: true });
  telegram.markInteractionResolvedInTelegram.mockClear();
  frames = [];
  off = ops.subscribeGlobalSessionEvents((ev) => { frames.push(ev); });
});

afterEach(() => {
  off?.();
  off = null;
  clearStreams();
});

describe('expiry sweep (GET/SSE call sites and the 30 s sweeper)', () => {
  it('expires due gates of every kind, returns them and publishes each `expired` once', () => {
    const now = nowS();
    perm('p-due', A, { expiresAt: now - 1 });
    perm('p-later', A, { expiresAt: now + 600 });
    perm('p-no-deadline', A);
    question('q-due', B, 'question', { expiresAt: now - 5 });
    question('x-due', B, 'exit_plan', { expiresAt: now });
    question('aq', B, 'async_question');
    perm('p-answered', B, { status: 'allowed', expiresAt: now - 100 });

    expect(ops.sweepExpiredInteractions()).toBe(3);
    expect(gateStatus()).toEqual({
      'p-due': 'expired', 'p-later': 'pending', 'p-no-deadline': 'pending', 'p-answered': 'allowed',
      'q-due': 'expired', 'x-due': 'expired', aq: 'pending',
    });
    expect(resolved()).toEqual([
      { sessionId: A, kind: 'permission', id: 'p-due', outcome: 'expired' },
      { sessionId: B, kind: 'question', id: 'q-due', outcome: 'expired' },
      { sessionId: B, kind: 'exit_plan', id: 'x-due', outcome: 'expired' },
    ]);
    expect(telegram.markInteractionResolvedInTelegram.mock.calls.map((c) => c[1]).sort())
      .toEqual(['p-due', 'q-due', 'x-due']);

    // Idempotent: the UPDATE only returns rows it changed.
    expect(ops.sweepExpiredInteractions()).toBe(0);
    expect(resolved()).toHaveLength(3);
  });

  it('returns the expired gates from the import-cycle-free DB helper', async () => {
    const { expireStalePendingInteractions } = await import('@/lib/server/agent/pendingInteractions');
    perm('p-due', A, { expiresAt: 100 });
    question('x-due', A, 'exit_plan', { expiresAt: 100 });
    expect(expireStalePendingInteractions(200)).toEqual([
      { kind: 'permission', id: 'p-due', sessionId: A },
      { kind: 'exit_plan', id: 'x-due', sessionId: A },
    ]);
    expect(resolved()).toEqual([]);   // the helper itself publishes nothing
  });

  it('never sweeps an async question, whatever the clock says', () => {
    question('aq', A, 'async_question');
    expect(ops.sweepExpiredInteractions(2_000_000_000)).toBe(0);
    expect(gateStatus()).toEqual({ aq: 'pending' });
    expect(resolved()).toEqual([]);
  });

  it('publishes through a hydrated stream, after the text its lane coalescer still holds', () => {
    const stream: any = ops.getOrCreateStream(A);
    const broadcast = vi.spyOn(stream, '_broadcast');
    stream._onAgentEvent({ event: 'assistant_text', session_id: A, delta: 'Working on it' });
    perm('p-due', A, { expiresAt: nowS() - 1 });

    ops.sweepExpiredInteractions();

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'interaction_resolved', kind: 'permission', id: 'p-due', outcome: 'expired',
    }));
    expect(frames.map((f) => f.type)).toEqual(['assistant_text', 'interaction_resolved']);
  });

  it('the list GET sweeps (publishing) before it counts, and splits blocking from async', async () => {
    const now = nowS();
    perm('p1', A);
    perm('p-due', A, { expiresAt: now - 1 });
    question('q1', A);
    question('x1', A, 'exit_plan');
    question('aq1', A, 'async_question');
    question('aq2', B, 'async_question');
    perm('p-done', B, { status: 'denied' });
    const { GET } = await import('@/app/api/sessions/route');
    const body = await (await GET(new Request('http://localhost/api/sessions'))).json();
    const byId = new Map(body.sessions.map((s: any) => [s.id, s]));
    expect(byId.get(A)).toMatchObject({ pendingBlocking: 3, pendingAsync: 1, pendingPermissions: 4 });
    expect(byId.get(B)).toMatchObject({ pendingBlocking: 0, pendingAsync: 1, pendingPermissions: 1 });
    expect((byId.get(A) as any).providerConfig).toBeUndefined();
    expect(resolved()).toEqual([{ sessionId: A, kind: 'permission', id: 'p-due', outcome: 'expired' }]);
  });

  it('the annotator keeps the list row shape (live status, bg count, addressable)', async () => {
    const { annotateSessionRows } = await import('@/lib/server/hub/sessionList');
    const stream: any = ops.getOrCreateStream(A);
    stream.status = 'thinking';
    const rows = db.select().from(schema.agentSessions).all();
    const out = annotateSessionRows(rows, { vpsRuntime: [] });
    const a = out.find((r) => r.id === A)!;
    expect(a).toMatchObject({
      liveStatus: 'thinking', runningBgTasks: 0, addressable: false,
      pendingPermissions: 0, pendingBlocking: 0, pendingAsync: 0,
      firstUserMessage: null, lastActivityMs: null,
    });
    expect(out.find((r) => r.id === B)!.liveStatus).toBe('active');
  });

  it('the session GET sweeps and flags an async question whose answers are being delivered', async () => {
    const { markAsyncQuestionDelivering } = await import('@/lib/server/agent/asyncQuestionDelivery');
    question('aq-sending', A, 'async_question', { answers: JSON.stringify({ 'Which colour?': 'Orange' }) });
    markAsyncQuestionDelivering('aq-sending', true);
    question('aq-open', A, 'async_question');
    question('q-due', A, 'question', { expiresAt: nowS() - 1 });
    const { GET } = await import('@/app/api/sessions/[id]/route');
    const body = await (await GET(new Request(`http://localhost/api/sessions/${A}`),
      { params: Promise.resolve({ id: A }) })).json();
    const byId = new Map(body.pendingQuestions.map((q: any) => [q.id, q]));
    expect([...byId.keys()].sort()).toEqual(['aq-open', 'aq-sending']);
    expect(byId.get('aq-sending')).toMatchObject({ delivery: 'async', delivering: true });
    expect(byId.get('aq-open')).toMatchObject({ delivery: 'async', delivering: false });
    expect(resolved()).toEqual([{ sessionId: A, kind: 'question', id: 'q-due', outcome: 'expired' }]);
    markAsyncQuestionDelivering('aq-sending', false);
  });

  it('a failed async-answer delivery leaves the question answerable: delivering is the in-flight send only (W2 review)', async () => {
    question('aq-fail', A, 'async_question');
    const stream: any = ops.getOrCreateStream(A);
    let fail: ((e: Error) => void) | null = null;
    const send = vi.spyOn(stream, 'sendUserMessage')
      .mockImplementationOnce(() => new Promise((_r, rej) => { fail = rej; }));
    const { GET } = await import('@/app/api/sessions/[id]/route');
    const sums = await import('@/lib/server/sync/sessionSummaries');
    const getQ = async () => (await (await GET(new Request(`http://localhost/api/sessions/${A}`),
      { params: Promise.resolve({ id: A }) })).json()).pendingQuestions.find((q: any) => q.id === 'aq-fail');
    const answers = { 'Which colour?': 'Orange' };
    const first = stream.respondQuestion('aq-fail', answers);
    for (let i = 0; i < 20 && !fail; i++) await Promise.resolve();
    expect(fail).not.toBeNull();
    expect(await getQ()).toMatchObject({ delivering: true });
    expect(sums.buildSessionSummary(A)!.gates.find((g) => g.id === 'aq-fail')).toMatchObject({ delivering: true });
    fail!(new Error('agent unreachable'));
    await expect(first).rejects.toThrow('agent unreachable');
    // The reservation stays (a retry must send the same content), the form does not lock.
    expect(db.select().from(schema.sessionPendingQuestions).all().find((r: any) => r.id === 'aq-fail').answers)
      .toBe(JSON.stringify(answers));
    expect(await getQ()).toMatchObject({ delivering: false });
    expect(sums.buildSessionSummary(A)!.gates.find((g) => g.id === 'aq-fail')!.delivering).toBeUndefined();
    // Open views are told too (W4 review): the strip's form unlocks live.
    expect(frames.filter((f) => f.type === 'question_delivery').map((f) => [f.id, f.delivering]))
      .toEqual([['aq-fail', true], ['aq-fail', false]]);
    // The retry with the same answers goes through.
    send.mockImplementationOnce(async () => {});
    await stream.respondQuestion('aq-fail', answers);
    expect(gateStatus()['aq-fail']).toBe('answered');
    send.mockRestore();
  });

  // Integration with the sync bus (C11): the connection is not live while its
  // snapshot is read, so the sweep's `expired` frame (published inside that
  // synchronous section, rev ≤ the snapshot) is NOT routed to it — the
  // snapshot already omits the gate. Every other connection gets the frame.
  it('the SSE snapshot sweeps first: no card for an expired gate, its `expired` frame published on the bus', async () => {
    perm('p-live', A);
    perm('p-due', A, { expiresAt: nowS() - 1 });
    const { GET } = await import('@/app/api/events/route');
    const res = await GET(new Request('http://localhost/api/events?conn=conn-sweep-test'));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"type":"heartbeat"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    const events = text.split('\n\n').filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice('data: '.length)));
    const requests = events.filter((e) => e.type === 'permission_request').map((e) => e.id);
    expect(requests).toEqual(['p-live']);
    expect(events.some((e) => e.type === 'interaction_resolved' && e.id === 'p-due')).toBe(false);
    expect(resolved()).toEqual([{ sessionId: A, kind: 'permission', id: 'p-due', outcome: 'expired' }]);
  });
});

describe('a session leaving the live states cancels its blocking gates (published)', () => {
  function seedGates() {
    perm('p1', A);
    question('q1', A);
    question('x1', A, 'exit_plan');
    question('aq', A, 'async_question');
    perm('p-other', B);
    perm('p-done', A, { status: 'allowed' });
  }
  const cancelledA = [
    { sessionId: A, kind: 'permission', id: 'p1', outcome: 'cancelled' },
    { sessionId: A, kind: 'question', id: 'q1', outcome: 'cancelled' },
    { sessionId: A, kind: 'exit_plan', id: 'x1', outcome: 'cancelled' },
  ];

  it.each(['sleeping', 'error', 'killed'])('a LIVE `%s` cancels blocking gates, keeps async questions', (status) => {
    seedGates();
    const s = newStream(A);
    const broadcast = vi.spyOn(s, '_broadcast');
    s._onAgentEvent({ event: 'status', session_id: A, status, seq: 7 });
    expect(gateStatus()).toEqual({
      p1: 'cancelled', q1: 'cancelled', x1: 'cancelled', aq: 'pending', 'p-other': 'pending', 'p-done': 'allowed',
    });
    const respondedAt = db.select().from(schema.sessionPendingPermissions).all()
      .find((r: any) => r.id === 'p1').respondedAt;
    expect(respondedAt).toBeGreaterThan(0);
    expect(resolved()).toEqual(cancelledA);
    // Through the stream (lane-ordered), each Telegram card retired.
    expect(broadcast.mock.calls.filter(([ev]: any[]) => ev.type === 'interaction_resolved')).toHaveLength(3);
    expect(telegram.markInteractionResolvedInTelegram).toHaveBeenCalledWith('exit_plan', 'x1');
  });

  it.each(['active', 'thinking', 'starting'])('a live `%s` cancels nothing', (status) => {
    seedGates();
    newStream(A)._onAgentEvent({ event: 'status', session_id: A, status, seq: 7 });
    expect(gateStatus()).toMatchObject({ p1: 'pending', q1: 'pending', x1: 'pending', aq: 'pending' });
    expect(resolved()).toEqual([]);
  });

  it('a REPLAYED `sleeping` cancels nothing; the live post-replay status does', () => {
    seedGates();
    const s = newStream(A);
    s._onAgentEvent({ event: 'replay_begin', session_id: A, count: 1 });
    s._onAgentEvent({ event: 'status', session_id: A, status: 'sleeping', seq: 7 });
    expect(gateStatus()).toMatchObject({ p1: 'pending', q1: 'pending', x1: 'pending' });
    expect(resolved()).toEqual([]);
    s._onAgentEvent({ event: 'replay_end', session_id: A });
    s._onAgentEvent({ event: 'status', session_id: A, status: 'sleeping' });
    expect(resolved()).toEqual(cancelledA);
  });

  it('sleepSession cancels after its DB write, on the bus when no stream is hydrated', async () => {
    seedGates();
    await ops.sleepSession(A);
    expect(gateStatus()).toMatchObject({ p1: 'cancelled', q1: 'cancelled', x1: 'cancelled', aq: 'pending' });
    expect(frames.filter((f) => f.type === 'status' || f.type === 'interaction_resolved').map((f) => f.type))
      .toEqual(['status', 'interaction_resolved', 'interaction_resolved', 'interaction_resolved']);
    expect(resolved()).toEqual(cancelledA);
    expect(agent.call).toHaveBeenCalledWith('sleep_session', { session_id: A });
  });

  it('forceStopSession cancels only once the forced stop landed', async () => {
    seedGates();
    agent.call.mockRejectedValueOnce(new Error('agent offline'));
    await ops.forceStopSession(A);
    expect(gateStatus()).toMatchObject({ p1: 'pending', q1: 'pending', x1: 'pending' });
    expect(resolved()).toEqual([]);

    await ops.forceStopSession(A);   // no stream: the direct RPC succeeds
    expect(agent.call).toHaveBeenLastCalledWith('force_stop', { session_id: A });
    expect(resolved()).toEqual(cancelledA);
    expect(gateStatus()).toMatchObject({ aq: 'pending', 'p-other': 'pending' });
  });

  it('forceStopSession through a hydrated stream publishes through it', async () => {
    seedGates();
    const stream: any = ops.getOrCreateStream(A);
    const broadcast = vi.spyOn(stream, '_broadcast');
    agent.call.mockRejectedValueOnce(new Error('timeout on force_stop'));
    await expect(ops.forceStopSession(A)).rejects.toThrow('timeout on force_stop');
    expect(resolved()).toEqual([]);
    await ops.forceStopSession(A);
    expect(resolved()).toEqual(cancelledA);
    expect(broadcast.mock.calls.filter(([ev]: any[]) => ev.type === 'interaction_resolved')).toHaveLength(3);
  });
});

describe('hub-side dead-worker transitions cancel the old worker blocking gates (D-13)', () => {
  const rpcErr = (msg: string, code: number) => Object.assign(new Error(msg), { code });

  it('resumeSession: the not-found fallback to start_session cancels them', async () => {
    db.update(schema.agentSessions).set({ status: 'thinking', nativeSessionId: 'native-1' })
      .where(eq(schema.agentSessions.id, A)).run();
    perm('p1', A);
    question('aq', A, 'async_question');
    agent.call.mockImplementation(async (method: string) => {
      if (method === 'resume_session') throw rpcErr('session not found', -32000);
      return { ok: true };
    });
    await ops.resumeSession(A);
    expect(agent.call.mock.calls.map((c: any[]) => c[0])).toEqual(['resume_session', 'start_session']);
    expect(gateStatus()).toMatchObject({ p1: 'cancelled', aq: 'pending' });
    expect(resolved()).toEqual([{ sessionId: A, kind: 'permission', id: 'p1', outcome: 'cancelled' }]);
  });

  it('a reconcile whose resume of an agent-unknown session fails cancels them', async () => {
    perm('p1', A);
    agent.call.mockRejectedValue(new Error('cwd gone'));
    await ops.reconcileVpsAgentState(VPS_ID, []);
    await vi.waitFor(() => expect(gateStatus()).toMatchObject({ p1: 'cancelled' }));
    expect(resolved()).toContainEqual({ sessionId: A, kind: 'permission', id: 'p1', outcome: 'cancelled' });
  });

  it("sendUserMessage: a failed auto-resume after 'not running' cancels them", async () => {
    perm('p1', A);
    agent.call.mockImplementation(async (method: string) => {
      if (method === 'send_input') throw new Error('session not running (status=sleeping)');
      throw new Error('resume exploded');
    });
    const stream: any = ops.getOrCreateStream(A);
    await expect(stream.sendUserMessage('hello')).rejects.toThrow('resume exploded');
    expect(gateStatus()).toMatchObject({ p1: 'cancelled' });
  });
});

describe('removal paths publish `cancelled` for every pending gate they delete', () => {
  function seedGates() {
    perm('p1', A);
    question('q1', A);
    question('x1', A, 'exit_plan');
    question('aq', A, 'async_question');
    perm('p-done', A, { status: 'denied' });
    perm('p-other', B);
  }
  const expected = [
    { sessionId: A, kind: 'permission', id: 'p1', outcome: 'cancelled' },
    { sessionId: A, kind: 'question', id: 'q1', outcome: 'cancelled' },
    { sessionId: A, kind: 'exit_plan', id: 'x1', outcome: 'cancelled' },
    { sessionId: A, kind: 'question', id: 'aq', outcome: 'cancelled' },
  ];

  it('archive', async () => {
    seedGates();
    const { POST } = await import('@/app/api/sessions/[id]/archive/route');
    const res = await POST(new Request(`http://localhost/api/sessions/${A}/archive`, { method: 'POST' }),
      { params: Promise.resolve({ id: A }) });
    expect(res.status).toBe(200);
    expect(gateStatus()).toEqual({ 'p-other': 'pending' });
    expect(resolved()).toEqual(expected);
  });

  it('rollback', async () => {
    seedGates();
    db.insert(schema.sessionMessages).values({ sessionId: A, role: 'user', content: 'rewind me', tsMs: 1_000 }).run();
    const user = db.select().from(schema.sessionMessages).all()[0];
    agent.call.mockResolvedValue({ claude_session_id: 'native-fork', strategy: 'fork' });
    const { POST } = await import('@/app/api/sessions/[id]/rollback/route');
    const res = await POST(new Request(`http://localhost/api/sessions/${A}/rollback`, {
      method: 'POST', body: JSON.stringify({ messageId: `m${user.id}` }),
    }), { params: Promise.resolve({ id: A }) });
    expect(res.status).toBe(200);
    expect(gateStatus()).toEqual({ 'p-other': 'pending' });
    expect(resolved()).toEqual(expected);
  });

  it('a refused rollback deletes and publishes nothing', async () => {
    seedGates();
    db.insert(schema.sessionMessages).values({ sessionId: A, role: 'user', content: 'keep me', tsMs: 1_000 }).run();
    const user = db.select().from(schema.sessionMessages).all()[0];
    agent.call.mockRejectedValue(new Error('rollback refused'));
    const { POST } = await import('@/app/api/sessions/[id]/rollback/route');
    const res = await POST(new Request(`http://localhost/api/sessions/${A}/rollback`, {
      method: 'POST', body: JSON.stringify({ messageId: `m${user.id}` }),
    }), { params: Promise.resolve({ id: A }) });
    expect(res.status).toBe(400);
    expect(gateStatus()).toMatchObject({ p1: 'pending', aq: 'pending' });
    expect(resolved()).toEqual([]);
  });

  it('deleteSession: the transient `killed` first, then one `cancelled` per pending gate', async () => {
    seedGates();
    ops.getOrCreateStream(A);
    expect((await ops.deleteSession(A)).deleted).toBe(true);
    expect(gateStatus()).toEqual({ 'p-other': 'pending' });
    expect(resolved()).toEqual(expected);
    const kinds = frames.filter((f) => f.sessionId === A).map((f) => f.type);
    expect(kinds.slice(0, 1)).toEqual(['status']);
    expect(frames.find((f) => f.type === 'status')).toMatchObject({ sessionId: A, status: 'killed' });
  });
});

describe('responding to a gate', () => {
  it.each([
    ['allowed', 'answered'], ['denied', 'denied'], ['expired', 'expired'], ['cancelled', 'cancelled'],
  ])('a permission already `%s` publishes `%s` (kills the ghost card), then refuses', async (status, outcome) => {
    perm('p-ghost', A, { status });
    const s = newStream(A);
    await expect(s.respondPermission('p-ghost', true)).rejects.toThrow('already expired or been resolved');
    expect(agent.call).not.toHaveBeenCalled();
    expect(gateStatus()).toEqual({ 'p-ghost': status });
    expect(resolved()).toEqual([{ sessionId: A, kind: 'permission', id: 'p-ghost', outcome }]);
    expect(telegram.markInteractionResolvedInTelegram).toHaveBeenCalledWith('permission', 'p-ghost');
  });

  it('a pending permission still resolves after the provider accepted it', async () => {
    perm('p1', A);
    await newStream(A).respondPermission('p1', false);
    expect(gateStatus()).toEqual({ p1: 'denied' });
    expect(resolved()).toEqual([{ sessionId: A, kind: 'permission', id: 'p1', outcome: 'denied' }]);
  });

  it('exit plan: an RPC (transport) failure leaves the row pending and publishes nothing', async () => {
    question('x1', A, 'exit_plan');
    const s = newStream(A);
    agent.call.mockRejectedValueOnce(new Error('agent offline'));
    await expect(s.respondExitPlan('x1', 'approve')).rejects.toThrow('agent offline');
    const row = db.select().from(schema.sessionPendingQuestions).all()[0];
    expect(row).toMatchObject({ status: 'pending', answers: null, respondedAt: null });
    expect(resolved()).toEqual([]);
  });

  it.each([
    ['permission', 'p-dead', (s: any) => s.respondPermission('p-dead', true)],
    ['question', 'q-dead', (s: any) => s.respondQuestion('q-dead', { a: 'b' })],
    ['exit_plan', 'x-dead', (s: any) => s.respondExitPlan('x-dead', 'approve')],
  ] as const)('%s: a provider REFUSAL (`resolved:false`, the gate died with its worker) retires it as `cancelled`, published once', async (kind, id, respond) => {
    const deadline = { expiresAt: nowS() + 600 };
    if (kind === 'permission') perm(id, A, deadline);
    else question(id, A, kind, deadline);
    const s = newStream(A);
    agent.call.mockResolvedValueOnce({ ok: true, resolved: false });
    await expect(respond(s)).rejects.toThrow('already expired or been cancelled');
    expect(gateStatus()).toEqual({ [id]: 'cancelled' });
    expect(resolved()).toEqual([{ sessionId: A, kind, id, outcome: 'cancelled' }]);
    expect(telegram.markInteractionResolvedInTelegram).toHaveBeenCalledWith(kind, id);
    // The sweeper has nothing left to do for it.
    expect(ops.sweepExpiredInteractions(nowS() + 10_000)).toBe(0);
  });

  it('a refusal racing a concurrent answer keeps that answer and announces nothing more', async () => {
    perm('p-raced', A);
    const s = newStream(A);
    agent.call.mockImplementationOnce(async () => {
      // Another device answered while this RPC was in flight.
      db.update(schema.sessionPendingPermissions).set({ status: 'allowed' }).run();
      return { ok: true, resolved: false };
    });
    await expect(s.respondPermission('p-raced', false)).rejects.toThrow('already expired or been cancelled');
    expect(gateStatus()).toEqual({ 'p-raced': 'allowed' });
    expect(resolved()).toEqual([]);
  });

  it.each([
    ['answered', 'answered'], ['cancelled', 'cancelled'], ['expired', 'expired'],
  ])('a blocking question already `%s` publishes `%s` (kills the ghost card), then refuses', async (status, outcome) => {
    question('q-ghost', A, 'question', { status });
    const s = newStream(A);
    await expect(s.respondQuestion('q-ghost', { a: 'b' })).rejects.toThrow('already been resolved');
    expect(agent.call).not.toHaveBeenCalled();
    expect(gateStatus()).toEqual({ 'q-ghost': status });
    expect(resolved()).toEqual([{ sessionId: A, kind: 'question', id: 'q-ghost', outcome }]);
    expect(telegram.markInteractionResolvedInTelegram).toHaveBeenCalledWith('question', 'q-ghost');
  });

  it('exit plan: RPC first, then the DB (scoped to the session), then the frame', async () => {
    question('x1', A, 'exit_plan');
    const s = newStream(A);
    agent.call.mockImplementationOnce(async () => {
      // The provider answers BEFORE anything is written or published.
      expect(gateStatus()).toEqual({ x1: 'pending' });
      expect(resolved()).toEqual([]);
      return { ok: true };
    });
    await s.respondExitPlan('x1', 'reject', 'too broad');
    expect(agent.call).toHaveBeenCalledWith('respond_exit_plan', {
      session_id: A, q_id: 'x1', decision: 'reject', feedback: 'too broad',
    });
    const row = db.select().from(schema.sessionPendingQuestions).all()[0];
    expect(row.status).toBe('answered');
    expect(JSON.parse(row.answers)).toEqual({ decision: 'reject', feedback: 'too broad' });
    expect(resolved()).toEqual([{ sessionId: A, kind: 'exit_plan', id: 'x1', outcome: 'answered' }]);
  });

  it("exit plan: another session's review is never touched; a resolved one publishes its outcome", async () => {
    question('x-other', B, 'exit_plan');
    question('x-done', A, 'exit_plan', { status: 'answered' });
    const s = newStream(A);
    await expect(s.respondExitPlan('x-other', 'approve')).rejects.toThrow('not found');
    await expect(s.respondExitPlan('x-done', 'approve')).rejects.toThrow('already been resolved');
    expect(agent.call).not.toHaveBeenCalled();
    expect(gateStatus()).toEqual({ 'x-other': 'pending', 'x-done': 'answered' });
    expect(resolved()).toEqual([{ sessionId: A, kind: 'exit_plan', id: 'x-done', outcome: 'answered' }]);
  });
});

describe('a restart replay never resurrects a permission gate', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  async function permTelegram() {
    return (await import('@/lib/server/hub/telegram')).sendPermissionToTelegram as unknown as ReturnType<typeof vi.fn>;
  }

  // Remembered "don't ask again" rules never reach the hub any more: the CLI
  // applies them itself (they ride every start as `allowedTools`), so nothing
  // here answers a card on the user's behalf.
  const allowStream = () => newStream(A);

  function replayPermission(s: any, id: string) {
    s._onAgentEvent({ event: 'replay_begin', session_id: A, count: 1 });
    s._onAgentEvent({
      event: 'permission_request', session_id: A, seq: 5, id, tool: 'Bash', input: { command: 'ls' },
      expires_at: nowS() + 600,
    });
    s._onAgentEvent({ event: 'replay_end', session_id: A });
  }

  it.each(['allowed', 'denied', 'expired', 'cancelled', 'pending'])(
    'a restart replay over a gate whose row is `%s`: no answer, no card, no push, no Telegram',
    async (status) => {
      perm('p-auto', A, { status, expiresAt: nowS() + 600 });
      const tg = await permTelegram();
      tg.mockClear();
      const s = allowStream();
      const push = vi.spyOn(s, '_maybePush');
      replayPermission(s, 'p-auto');
      await tick();
      expect(agent.call).not.toHaveBeenCalled();
      expect(frames.filter((f) => f.type === 'permission_request')).toEqual([]);
      expect(push).not.toHaveBeenCalled();
      expect(tg).not.toHaveBeenCalled();
      // Not even re-answered: its resolution was published when it happened.
      expect(resolved()).toEqual([]);
      expect(telegram.markInteractionResolvedInTelegram).not.toHaveBeenCalled();
      expect(gateStatus()).toEqual({ 'p-auto': status });
    },
  );

  it('a live card carries the provider\'s reason and the CLI\'s options: row, frame, Telegram', async () => {
    const tg = await permTelegram();
    tg.mockClear();
    const s = allowStream();
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    ];
    s._onAgentEvent({
      event: 'permission_request', session_id: A, seq: 8, id: 'p-live', tool: 'Bash', input: { command: 'npm test' },
      expires_at: nowS() + 600, reason: 'Needs approval', suggestions,
    });
    await tick();
    expect(agent.call).not.toHaveBeenCalled();
    const row = db.select().from(schema.sessionPendingPermissions).all().find((p: any) => p.id === 'p-live');
    expect(row).toMatchObject({ status: 'pending', reason: 'Needs approval' });
    expect(JSON.parse(row.suggestions)).toEqual(suggestions);
    expect(frames.filter((f) => f.type === 'permission_request')).toEqual([
      expect.objectContaining({ id: 'p-live', reason: 'Needs approval', suggestions }),
    ]);
    expect(tg).toHaveBeenCalledWith(A, 'p-live', 'Bash', { command: 'npm test' }, {
      reason: 'Needs approval', always: 'always allow Bash(npm test:*) — this project',
    });
  });
});

describe('deleting a VPS publishes the removal of its sessions and gates (G7)', () => {
  it('transient `killed` per session, `cancelled` per pending gate, ONE list change; streams detached', async () => {
    const vpsId = 'gatevps-gone';
    db.insert(schema.vps).values({ id: vpsId, name: 'gone', ip: '127.0.0.3', sshUser: 'root' }).run();
    const C = 'c7'.repeat(16);
    const D = 'd7'.repeat(16);
    for (const id of [C, D]) insertSession(id, { vpsId });
    perm('p-c', C);
    question('q-c', C);
    question('aq-d', D, 'async_question');
    perm('p-d-done', D, { status: 'denied' });
    perm('p-a', A);                                   // another VPS: untouched
    ops.getOrCreateStream(C);
    // Unreachable agent: every remote kill fails (the common reason to delete).
    agent.call.mockRejectedValue(new Error('unreachable'));

    const { DELETE } = await import('@/app/api/vps/[id]/route');
    const res = await DELETE(new Request(`http://localhost/api/vps/${vpsId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: vpsId }) });
    expect(res.status).toBe(200);
    expect(agent.call).toHaveBeenCalledWith('kill_session', { session_id: C });

    expect(gateStatus()).toEqual({ 'p-a': 'pending' });
    expect(resolved().sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { sessionId: D, kind: 'question', id: 'aq-d', outcome: 'cancelled' },
      { sessionId: C, kind: 'permission', id: 'p-c', outcome: 'cancelled' },
      { sessionId: C, kind: 'question', id: 'q-c', outcome: 'cancelled' },
    ]);
    const killed = frames.filter((f) => f.type === 'status' && f.status === 'killed').map((f) => f.sessionId);
    expect(killed.sort()).toEqual([C, D].sort());
    // `killed` precedes the gate frames; ONE list change, last.
    const firstResolved = frames.findIndex((f) => f.type === 'interaction_resolved');
    expect(frames.findIndex((f) => f.type === 'status' && f.status === 'killed')).toBeLessThan(firstResolved);
    const listChanges = frames.filter((f) => f.type === 'session_list_changed');
    expect(listChanges).toEqual([expect.objectContaining({ sessionId: vpsId })]);
    expect(frames.indexOf(listChanges[0])).toBeGreaterThan(firstResolved);
    expect(ops.peekStream(C)).toBeNull();
    expect(db.select().from(schema.agentSessions).all().map((r: any) => r.id).sort()).toEqual([A, B].sort());
  });
});

describe('auto-update quiet gate', () => {
  it('ignores async questions, still waits on blocking gates', async () => {
    db.update(schema.agentSessions).set({ status: 'sleeping' }).run();
    const { isVpsBusy } = await import('@/lib/server/hub/sdkWatch');
    question('aq', A, 'async_question');
    expect(isVpsBusy(VPS_ID)).toBe(false);
    question('q1', B);
    expect(isVpsBusy(VPS_ID)).toBe(true);
    db.delete(schema.sessionPendingQuestions).run();
    question('x1', B, 'exit_plan');
    expect(isVpsBusy(VPS_ID)).toBe(true);
  });
});

// Last: it resets the module registry.
describe('periodic sweeper', () => {
  it('publishes expiries every 30 s, ONE timer per process across module copies', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const first = await import('@/lib/server/agent/interactionSweeper');
      first.stopInteractionSweeper();
      const before = vi.getTimerCount();
      first.startInteractionSweeper();
      first.startInteractionSweeper();
      expect(vi.getTimerCount()).toBe(before + 1);

      vi.resetModules();
      const second = await import('@/lib/server/agent/interactionSweeper');
      expect(second).not.toBe(first);
      second.startInteractionSweeper();
      expect(vi.getTimerCount()).toBe(before + 1);

      perm('p-due', A, { expiresAt: nowS() - 1 });
      question('aq', A, 'async_question');
      vi.advanceTimersByTime(second.INTERACTION_SWEEP_MS - 1);
      expect(resolved()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(resolved()).toEqual([{ sessionId: A, kind: 'permission', id: 'p-due', outcome: 'expired' }]);
      vi.advanceTimersByTime(second.INTERACTION_SWEEP_MS * 3);
      expect(resolved()).toHaveLength(1);
      expect(gateStatus()).toEqual({ 'p-due': 'expired', aq: 'pending' });

      second.stopInteractionSweeper();
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('autoConnect boot arms it (even with autoconnect disabled)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const prev = process.env.CHARON_DISABLE_AUTOCONNECT;
    process.env.CHARON_DISABLE_AUTOCONNECT = '1';
    const g = globalThis as any;
    const booted = g._agentBooted;
    try {
      const sweeper = await import('@/lib/server/agent/interactionSweeper');
      sweeper.stopInteractionSweeper();
      g._agentBooted = false;
      const { autoConnectAgentsIfNeeded } = await import('@/lib/server/agent/autoConnect');
      autoConnectAgentsIfNeeded();
      expect(g.__charonSweeper.timer).not.toBeNull();
      sweeper.stopInteractionSweeper();
    } finally {
      g._agentBooted = booted;
      if (prev === undefined) delete process.env.CHARON_DISABLE_AUTOCONNECT;
      else process.env.CHARON_DISABLE_AUTOCONNECT = prev;
      vi.useRealTimers();
    }
  });
});
