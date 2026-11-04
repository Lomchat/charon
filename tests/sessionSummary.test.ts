// C13 — the session summary BUILDER (lib/server/sync/sessionSummaries.ts):
// the list row + gates + attention, derived server-side by ONE predicate.
// R5 §5.1 scenario matrix A–K ⇒ `attention`; gates (titles, preview, async,
// delivering, oldest first); archived/deleted ⇒ null; the gate preview is
// computed ONCE per gate from a bounded prefix (a 2 MB Write input is never
// parsed). Real builder against the hermetic DB; agent/push/Telegram mocked.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({ userId: 'u' })) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: vi.fn(async () => {}) }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: vi.fn(async () => {}),
  sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: vi.fn(() => {}),
  sendPlainToTelegram: vi.fn(async () => {}),
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {},
    call: async () => ({ ok: true }), status: 'connected',
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'sumvps';
const A = 'a1'.repeat(16);
const B = 'b1'.repeat(16);

let db: any;
let schema: any;
let ops: typeof import('@/lib/server/agent/sessionOps');
let sums: typeof import('@/lib/server/sync/sessionSummaries');
let summaryKey: typeof import('@/lib/sessionSummary').summaryKey;

function insertSession(id: string, extra: Record<string, unknown> = {}) {
  db.insert(schema.agentSessions).values({
    id, vpsId: VPS_ID, cwd: '/tmp/sum', name: id.slice(0, 4), status: 'active', ...extra,
  }).run();
}
function perm(id: string, sessionId: string, extra: Record<string, unknown> = {}) {
  db.insert(schema.sessionPendingPermissions).values({
    id, sessionId, toolName: 'Bash', toolInput: JSON.stringify({ command: 'ls -la' }), status: 'pending', ...extra,
  }).run();
}
function question(id: string, sessionId: string, kind: 'question' | 'async_question' | 'exit_plan' = 'question',
  extra: Record<string, unknown> = {}) {
  db.insert(schema.sessionPendingQuestions).values({
    id, sessionId, kind, status: 'pending',
    payload: kind === 'exit_plan' ? JSON.stringify({ plan: 'the plan' })
      : JSON.stringify([{ question: 'Which colour?', options: [{ label: 'Orange' }] }]),
    ...extra,
  }).run();
}
function liveStream(id: string, status: string) {
  const s = ops.getOrCreateStream(id)!;
  s.status = status as any;
  return s;
}
function clearStreams() {
  for (const s of ops.listStreams()) s.detach();
  (globalThis as any)._sessionStreams?.clear();
}
const attention = (id: string) => sums.buildSessionSummary(id)?.attention;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'sum-vps', ip: '127.0.0.1', sshUser: 'root' })
    .onConflictDoNothing().run();
  ops = await import('@/lib/server/agent/sessionOps');
  sums = await import('@/lib/server/sync/sessionSummaries');
  ({ summaryKey } = await import('@/lib/sessionSummary'));
});

beforeEach(() => {
  clearStreams();
  sums.resetSessionSummariesForTests();
  db.delete(schema.sessionMessages).run();
  db.delete(schema.sessionPendingPermissions).run();
  db.delete(schema.sessionPendingQuestions).run();
  db.delete(schema.agentSessions).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearStreams();
});

describe('attention derivation — R5 §5.1 scenario matrix', () => {
  it('A: a blocking permission mid-turn (thinking) is `blocked`, not "working"', () => {
    insertSession(A);
    liveStream(A, 'thinking');
    perm('p1', A);
    expect(attention(A)).toBe('blocked');
    // A blocking question and a plan review block too.
    db.delete(schema.sessionPendingPermissions).run();
    question('q1', A, 'question');
    expect(attention(A)).toBe('blocked');
    db.delete(schema.sessionPendingQuestions).run();
    question('x1', A, 'exit_plan');
    expect(attention(A)).toBe('blocked');
  });

  it('B: an async question on an idle session is `question` (never blocked)', () => {
    insertSession(A);
    question('aq', A, 'async_question');
    const s = sums.buildSessionSummary(A)!;
    expect(s.attention).toBe('question');
    expect(s.pendingBlocking).toBe(0);
    expect(s.pendingAsync).toBe(1);
    expect(s.pendingPermissions).toBe(1);
  });

  it('C: an async question on a paused session stays `question`', () => {
    insertSession(A, { status: 'sleeping' });
    question('aq', A, 'async_question');
    expect(attention(A)).toBe('question');
  });

  it('D: finished, unread and active is `unread`', () => {
    insertSession(A, { unreadStop: 1 });
    expect(attention(A)).toBe('unread');
  });

  it('E: no stream hydrated (fresh boot / SSR) still derives from the DB status', () => {
    insertSession(A, { unreadStop: 1, status: 'active' });
    insertSession(B, { status: 'thinking' });
    perm('p1', B);
    const list = sums.buildSessionSummaries();
    const byId = new Map(list.map((s) => [s.id, s]));
    expect(byId.get(A)!.liveStatus).toBe('active');
    expect(byId.get(A)!.attention).toBe('unread');
    expect(byId.get(B)!.attention).toBe('blocked');
  });

  it('F: a resolved/expired gate is no attention (no ghost)', () => {
    insertSession(A);
    perm('p-old', A, { status: 'expired' });
    question('q-old', A, 'question', { status: 'answered' });
    const s = sums.buildSessionSummary(A)!;
    expect(s.gates).toEqual([]);
    expect(s.attention).toBeNull();
  });

  it('G: a blocking gate on a sleeping or errored session is dead, not `blocked`', () => {
    insertSession(A, { status: 'sleeping' });
    perm('p1', A);
    expect(attention(A)).toBeNull();
    clearStreams();
    db.update(schema.agentSessions).set({ status: 'error' }).run();
    expect(attention(A)).toBeNull();
  });

  it('H: the live stream status wins over a lagging DB row', () => {
    insertSession(A, { unreadStop: 1, status: 'active' });
    liveStream(A, 'thinking');
    const s = sums.buildSessionSummary(A)!;
    expect(s.status).toBe('active');
    expect(s.liveStatus).toBe('thinking');
    // A working session is never "unread".
    expect(s.attention).toBeNull();
  });

  it('I/J: unread does not depend on who is looking (viewedHere is client-side only)', () => {
    insertSession(A, { unreadStop: 1 });
    liveStream(A, 'active');
    expect(attention(A)).toBe('unread');
  });

  it('K: a just-finished session carries its last activity', () => {
    insertSession(A, { unreadStop: 1 });
    const now = Date.now();
    db.insert(schema.sessionMessages).values({ sessionId: A, role: 'user', content: 'hello there', tsMs: now - 5000 }).run();
    db.insert(schema.sessionMessages).values({ sessionId: A, role: 'assistant', content: 'done', tsMs: now }).run();
    const s = sums.buildSessionSummary(A)!;
    expect(s.lastActivityMs).toBe(now);
    expect(s.firstUserMessage).toBe('hello there');
    expect(s.attention).toBe('unread');
  });

  it('precedence: blocked > question > unread', () => {
    insertSession(A, { unreadStop: 1 });
    question('aq', A, 'async_question');
    expect(attention(A)).toBe('question');
    perm('p1', A);
    expect(attention(A)).toBe('blocked');
  });
});

describe('summary shape', () => {
  it('is a superset of the list row: same fields as annotateSessionRows', async () => {
    insertSession(A, { color: '#f00' });
    const { annotateSessionRows } = await import('@/lib/server/hub/sessionList');
    const row = db.select().from(schema.agentSessions).all()[0];
    const [item] = annotateSessionRows([row]);
    const s = sums.buildSessionSummary(A)!;
    for (const [k, v] of Object.entries(item)) {
      if (v === undefined) continue;
      expect((s as any)[k], k).toEqual(v);
    }
    expect(s.gates).toEqual([]);
    expect(s.attention).toBeNull();
    expect(JSON.parse(JSON.stringify(s)).providerConfig).toBeUndefined();
  });

  it('lists every pending gate oldest first with its title and kind', () => {
    insertSession(A);
    perm('p1', A, { createdAt: 100, expiresAt: 700 });
    // `delivering` = a send in flight now, never the stored reservation alone.
    question('aq', A, 'async_question', { createdAt: 50, answers: '{"a":"b"}' });
    question('aq-res', A, 'async_question', { createdAt: 40, answers: '{"a":"b"}' });
    (globalThis as any).__charon_asyncQuestionsDelivering = new Set(['aq']);
    question('x1', A, 'exit_plan', { createdAt: 150 });
    question('q1', A, 'question', { createdAt: 120 });
    const s = sums.buildSessionSummary(A)!;
    (globalThis as any).__charon_asyncQuestionsDelivering = new Set();
    expect(s.gates.map((g) => g.id)).toEqual(['aq-res', 'aq', 'p1', 'q1', 'x1']);
    expect(s.gates).toEqual([
      { id: 'aq-res', kind: 'question', blocking: false, createdAt: 40, expiresAt: null, title: 'Which colour?' },
      { id: 'aq', kind: 'question', blocking: false, createdAt: 50, expiresAt: null, title: 'Which colour?', delivering: true },
      { id: 'p1', kind: 'permission', blocking: true, createdAt: 100, expiresAt: 700, title: 'Bash',
        preview: JSON.stringify({ command: 'ls -la' }, null, 2) },
      { id: 'q1', kind: 'question', blocking: true, createdAt: 120, expiresAt: null, title: 'Which colour?' },
      { id: 'x1', kind: 'exit_plan', blocking: true, createdAt: 150, expiresAt: null, title: 'plan' },
    ]);
    expect(s.pendingBlocking).toBe(3);
    expect(s.pendingAsync).toBe(2);
  });

  it('a question title is cut at 120 chars', () => {
    insertSession(A);
    question('q1', A, 'question', { payload: JSON.stringify([{ question: 'x'.repeat(500) }]) });
    expect(sums.buildSessionSummary(A)!.gates[0].title).toBe('x'.repeat(120));
  });

  it('archived and deleted sessions have no summary; the full build skips archived rows', () => {
    insertSession(A, { archived: 1 });
    insertSession(B);
    expect(sums.buildSessionSummary(A)).toBeNull();
    expect(sums.buildSessionSummary('nope'.repeat(8))).toBeNull();
    expect(sums.buildSessionSummaries().map((s) => s.id)).toEqual([B]);
  });

  it('summaryKey ignores volatile fields only', () => {
    insertSession(A);
    const s = sums.buildSessionSummary(A)!;
    expect(summaryKey({ ...s, lastSeenSeq: 999, lastActivityMs: 1, lastUsedAt: 5 })).toBe(summaryKey(s));
    expect(summaryKey({ ...s, liveStatus: 'thinking' })).not.toBe(summaryKey(s));
  });
});

describe('gate preview: once per gate, bounded', () => {
  it('parses a small input once, however many rebuilds', () => {
    insertSession(A);
    const input = JSON.stringify({ command: 'echo marker-small-input' });
    perm('p1', A, { toolInput: input });
    const spy = vi.spyOn(JSON, 'parse');
    for (let i = 0; i < 5; i++) sums.buildSessionSummary(A);
    sums.buildSessionSummaries();
    const parses = spy.mock.calls.filter(([arg]) => typeof arg === 'string' && arg.includes('marker-small-input'));
    expect(parses).toHaveLength(1);
    expect(sums.buildSessionSummary(A)!.gates[0].preview).toBe(JSON.stringify(JSON.parse(input), null, 2));
  });

  it('a 2 MB Write input is previewed from a raw prefix and never parsed', () => {
    insertSession(A);
    const big = JSON.stringify({ file_path: '/tmp/x', content: 'MARKER'.repeat(350_000) });
    expect(big.length).toBeGreaterThan(2_000_000);
    perm('p-big', A, { toolName: 'Write', toolInput: big });
    const spy = vi.spyOn(JSON, 'parse');
    const s = sums.buildSessionSummary(A)!;
    sums.buildSessionSummary(A);
    const g = s.gates[0];
    expect(g.title).toBe('Write');
    expect(g.preview).toBe(big.slice(0, 600));
    const longest = Math.max(0, ...spy.mock.calls.map(([arg]) => (typeof arg === 'string' ? arg.length : 0)));
    expect(longest).toBeLessThanOrEqual(sums.GATE_PREVIEW_PARSE_MAX + 1);
  });

  it('the cached text is dropped once the gate resolves', () => {
    insertSession(A);
    perm('p1', A, { toolInput: JSON.stringify({ command: 'first-marker' }) });
    sums.buildSessionSummary(A);
    db.update(schema.sessionPendingPermissions).set({ status: 'allowed' }).run();
    expect(sums.buildSessionSummary(A)!.gates).toEqual([]);
    // Same id reused (a test-only shape): recomputed from the new row, not the cache.
    db.update(schema.sessionPendingPermissions)
      .set({ status: 'pending', toolInput: JSON.stringify({ command: 'second-marker' }) }).run();
    expect(sums.buildSessionSummary(A)!.gates[0].preview).toContain('second-marker');
  });
});

describe('first user message cache', () => {
  it('is read once, cached, and dropped on demand (rollback)', () => {
    insertSession(A);
    expect(sums.buildSessionSummary(A)!.firstUserMessage).toBeNull();
    db.insert(schema.sessionMessages).values({ sessionId: A, role: 'user', content: 'first prompt' }).run();
    expect(sums.buildSessionSummary(A)!.firstUserMessage).toBe('first prompt');
    db.delete(schema.sessionMessages).run();
    db.insert(schema.sessionMessages).values({ sessionId: A, role: 'user', content: 'other prompt' }).run();
    // Cached once non-null…
    expect(sums.buildSessionSummary(A)!.firstUserMessage).toBe('first prompt');
    sums.forgetFirstUserMessage(A);
    expect(sums.buildSessionSummary(A)!.firstUserMessage).toBe('other prompt');
  });

  it('is cut at 180 chars like the list row', () => {
    insertSession(A);
    db.insert(schema.sessionMessages).values({ sessionId: A, role: 'user', content: 'p'.repeat(400) }).run();
    expect(sums.buildSessionSummary(A)!.firstUserMessage).toBe('p'.repeat(180));
  });
});
