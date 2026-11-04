import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeSessionTokenUsage } from '@/lib/sessionTokenUsage';

// A private DB dir (removed in afterAll: the cold-fold cases grow it to tens of MB).
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'charon-bg-status-test-'));
process.env.DATABASE_URL = path.join(DB_DIR, 'test.db');

const telegramMocks = vi.hoisted(() => ({
  sendPlainToTelegram: vi.fn(async (_text: string, _linkPath?: string, _event?: string) => {}),
}));
const pushMocks = vi.hoisted(() => ({ sendPushToAll: vi.fn(async (_payload: any) => {}) }));
vi.mock('@/lib/server/hub/webPush', () => pushMocks);
const bgMocks = vi.hoisted(() => ({ read: vi.fn(async (..._args: any[]): Promise<any[]> => []) }));
vi.mock('@/lib/server/hub/codexBgState', () => ({ readCodexBgState: bgMocks.read }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({})) }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: vi.fn(async () => {}),
  sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: vi.fn(async () => {}),
  sendPlainToTelegram: telegramMocks.sendPlainToTelegram,
}));
const clientMocks = vi.hoisted(() => ({
  call: vi.fn(async (..._args: any[]): Promise<any> => ({ status: 'active' })),
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    resubscribe: () => {},
    call: clientMocks.call,
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'bgvps';
const SID = 'c'.repeat(32);

let db: any;
let schema: any;
let SessionStream: any;
let recordedSessionUsage: any;
let sessionTokenUsage: typeof import('@/lib/server/agent/sessionTokenUsage').sessionTokenUsage;
let runningBgTaskDetailsFromDb: any;
let setSetting: any;

function createStream(status: string = 'active', kind: 'claude' | 'codex' | 'cursor' = 'claude') {
  return new SessionStream({
    id: SID, vpsId: VPS_ID, vpsName: 'test-vps', name: 'build',
    status, permissionMode: kind === 'codex' ? 'workspace-write' : 'normal',
    nativeSessionId: null, kind,
    lastStopNotifiedSeq: sessionRow()?.lastStopNotifiedSeq,
  }) as any;
}

function sessionRow(): any {
  return db.select().from(schema.agentSessions).all().find((r: any) => r.id === SID);
}

/** The agent's own event shape for a background task lifecycle frame. */
function bgTask(seq: number, kind: string, taskId: string, status?: string) {
  return {
    event: 'bg_task', session_id: SID, seq, kind, task_id: taskId, ts: Date.now() / 1000,
    ...(status ? { status } : {}),
  };
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });

  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 })
    .onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test-vps', ip: '127.0.0.1', sshUser: 'root' })
    .onConflictDoNothing().run();
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' })
    .onConflictDoNothing().run();

  ({ SessionStream } = await import('@/lib/server/agent/sessionOps'));
  ({ recordedSessionUsage } = await import('@/lib/server/agent/sessionUsage'));
  ({ sessionTokenUsage } = await import('@/lib/server/agent/sessionTokenUsage'));
  ({ runningBgTaskDetailsFromDb } = await import('@/lib/server/hub/bgTaskState'));
  ({ setSetting } = await import('@/lib/server/hub/settings'));
});

beforeEach(() => {
  vi.useFakeTimers();
  telegramMocks.sendPlainToTelegram.mockClear();
  pushMocks.sendPushToAll.mockClear();
  setSetting('notif.global_enabled', 'false');
  bgMocks.read.mockReset().mockResolvedValue([]);
  db.delete(schema.sessionMessages).run();
  db.delete(schema.agentSessions).run();
  db.insert(schema.agentSessions).values({
    id: SID, vpsId: VPS_ID, cwd: '/tmp', name: 'build', status: 'active',
  }).run();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

afterAll(() => {
  // Same best-effort cleanup as tests/setup/hermeticDb.ts (unlinking the open
  // SQLite files is fine on Linux).
  try { fs.rmSync(DB_DIR, { recursive: true, force: true }); } catch {}
});

describe('provider-neutral durable turn usage', () => {
  it('stores only final frames and aggregates Claude tree + Codex turn totals identically', () => {
    const claude = createStream('active', 'claude');
    claude._onAgentEvent({
      event: 'usage', session_id: SID, output_tokens: 9, input_tokens: 10,
      final: false,
    });
    claude._onAgentEvent({
      event: 'usage', session_id: SID, output_tokens: 90, input_tokens: 100,
      cache_read_tokens: 20, final: true, duration_ms: 1000, cost_usd: 0.1,
      tree: {
        input_tokens: 150, output_tokens: 120, cache_read_tokens: 30,
        cache_write_tokens: 5, cost_usd: 0.2, models: ['claude-test'],
      },
    });
    const codex = createStream('active', 'codex');
    codex._onAgentEvent({
      event: 'usage', session_id: SID, output_tokens: 80, input_tokens: 200,
      cache_read_tokens: 40, final: true, duration_ms: 2000,
    });

    const rows = db.select().from(schema.sessionMessages).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((row: any) => JSON.parse(row.content).provider)).toEqual(['claude', 'codex']);
    expect(recordedSessionUsage(SID)).toEqual({ pending: false, usage: {
      turns: 2,
      input_tokens: 350,
      output_tokens: 200,
      cache_read_tokens: 70,
      cache_write_tokens: 5,
      duration_ms: 3000,
      cost_usd: 0.2,
      models: ['claude-test'],
    } });
  });
});

describe('recorded endpoint session tokens', () => {
  function request(stream: any, seq: number, requestId: string, input: number | null, output: number | null, total: number | null) {
    stream._onAgentEvent({ event: 'endpoint_usage', session_id: SID, seq, request_id: requestId,
      input_tokens: input, output_tokens: output, total_tokens: total });
  }

  it('sums every tool round trip, deduplicates replay and excludes the SDK final copy', () => {
    const stream = createStream('thinking', 'codex');
    const broadcast = vi.spyOn(stream, '_broadcast');
    request(stream, 1, 'first', 100, 20, 120);
    request(stream, 2, 'second', 150, 30, 180);
    request(stream, 2, 'second', 150, 30, 180);
    // Even a duplicate with a new seq must not change totals.
    request(stream, 3, 'second', 150, 30, 180);
    stream._onAgentEvent({ event: 'usage', session_id: SID, final: true,
      input_tokens: 150, output_tokens: 30, endpoint_accounted: true });
    const usage = sessionTokenUsage(SID);
    expect(usage).toMatchObject({ inputTokens: 250, outputTokens: 50, totalTokens: 300,
      requests: 2, legacyTurns: 0, missingInput: 0, missingOutput: 0, missingTotal: 0, partial: false });
    // Debounced: nothing yet, then ONE trailing frame with the final totals.
    const tokenFrames = () => broadcast.mock.calls.filter(([event]: any[]) => event.type === 'session_token_usage');
    expect(tokenFrames()).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(tokenFrames()).toHaveLength(1);
    expect(broadcast.mock.calls.some(([event]: any[]) => event.type === 'session_token_usage' && event.usage.totalTokens === 300)).toBe(true);
  });

  it('preserves fal total-only counters, distinguishes zero, and identifies missing history', () => {
    const stream = createStream('thinking', 'codex');
    stream._onAgentEvent({ event: 'usage', session_id: SID, final: true, input_tokens: 0, output_tokens: 0 });
    request(stream, 1, 'fal', null, null, 58);
    expect(sessionTokenUsage(SID)).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: 58,
      requests: 1, legacyTurns: 1, missingInput: 2, missingOutput: 2, missingTotal: 1, partial: true });
    request(stream, 2, 'cached-zero', 0, 0, 0);
    expect(sessionTokenUsage(SID)).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 58 });
    stream._onAgentEvent({ event: 'endpoint_usage', session_id: SID, seq: 3, request_id: 'interrupted',
      input_tokens: 30, output_tokens: null, total_tokens: null, partial: true });
    expect(sessionTokenUsage(SID)).toMatchObject({ inputTokens: 30, outputTokens: 0, totalTokens: 58, requests: 3, partial: true });
  });

  it('includes Claude cached input once and keeps historical totals explicitly partial', () => {
    const stream = createStream('active', 'claude');
    stream._onAgentEvent({ event: 'usage', session_id: SID, final: true, input_tokens: 100, output_tokens: 20,
      tree: { input_tokens: 150, output_tokens: 120, cache_read_tokens: 30, cache_write_tokens: 5 } });
    request(stream, 1, 'request', 200, 10, 210);
    expect(sessionTokenUsage(SID)).toMatchObject({ inputTokens: 385, outputTokens: 130, totalTokens: 515, partial: true });
  });

  it('returns full totals on a small history page and an empty delta, without hydrating the agent', async () => {
    const stream = createStream('thinking', 'codex');
    request(stream, 1, 'old-request', 100, 20, 120);
    db.insert(schema.sessionMessages).values(Array.from({ length: 25 }, (_, i) => ({
      sessionId: SID, role: 'user', content: `message ${i}`,
    }))).run();
    const { GET } = await import('@/app/api/sessions/[id]/route');
    const root = await (await GET(new Request(`http://localhost/api/sessions/${SID}?limit=1`), { params: Promise.resolve({ id: SID }) })).json();
    expect(root.tokenUsage).toMatchObject({ totalTokens: 120, requests: 1 });
    expect(root.hasMore).toBe(true);
    const delta = await (await GET(new Request(`http://localhost/api/sessions/${SID}?since=${root.maxMessageId}`), { params: Promise.resolve({ id: SID }) })).json();
    expect(delta.messages).toEqual([]);
    expect(delta.tokenUsage).toEqual(root.tokenUsage);
    expect(mergeSessionTokenUsage(delta.tokenUsage, { ...root.tokenUsage, revision: 0, totalTokens: 0 })).toBe(delta.tokenUsage);
    expect(mergeSessionTokenUsage(delta.tokenUsage, { ...delta.tokenUsage })).toBe(delta.tokenUsage);
    // null/absent = the hub's fold is still warming: unknown, keep the last value.
    expect(mergeSessionTokenUsage(delta.tokenUsage, null)).toBe(delta.tokenUsage);
    expect(mergeSessionTokenUsage(delta.tokenUsage, undefined)).toBe(delta.tokenUsage);
  });

  it('keeps already consumed tokens when conversation history is rewound', async () => {
    const stream = createStream('active', 'codex');
    db.insert(schema.sessionMessages).values({ sessionId: SID, role: 'user', content: 'rewind me' }).run();
    const user = db.select().from(schema.sessionMessages).all()[0];
    request(stream, 1, 'consumed', 100, 20, 120);
    const before = sessionTokenUsage(SID);
    const { POST } = await import('@/app/api/sessions/[id]/rollback/route');
    const response = await POST(new Request(`http://localhost/api/sessions/${SID}/rollback`, {
      method: 'POST', body: JSON.stringify({ messageId: `m${user.id}` }),
    }), { params: Promise.resolve({ id: SID }) });
    expect(response.status).toBe(200);
    expect(db.select().from(schema.sessionMessages).all().some((m: any) => m.role === 'user')).toBe(false);
    expect(sessionTokenUsage(SID)).toEqual(before);
  });
});

describe('debounced session_token_usage broadcast (incremental fold)', () => {
  const tokenFrames = (spy: any) => spy.mock.calls
    .map(([event]: any[]) => event).filter((event: any) => event.type === 'session_token_usage');
  const usageEvent = (seq: number, requestId: string) => ({ event: 'endpoint_usage', session_id: SID, seq,
    request_id: requestId, input_tokens: 10, output_tokens: 1, total_tokens: 11 });

  it.each([false, true])('10 replayed endpoint_usage events publish ONE frame at replay_end (synthetic: %s)', (synthetic) => {
    const stream = createStream('active', 'codex');
    const broadcast = vi.spyOn(stream, '_broadcast');
    stream._onAgentEvent({ event: 'replay_begin', session_id: SID });
    for (let i = 1; i <= 10; i++) stream._onAgentEvent(usageEvent(i, `r${i}`));
    vi.advanceTimersByTime(1_000);
    expect(tokenFrames(broadcast)).toHaveLength(0);
    // AgentClient synthesizes the marker when a connection drops mid-replay.
    stream._onAgentEvent({ event: 'replay_end', session_id: SID, ...(synthetic ? { synthetic: true } : {}) });
    expect(tokenFrames(broadcast)).toHaveLength(1);
    expect(tokenFrames(broadcast)[0].usage).toMatchObject({ requests: 10, totalTokens: 110 });
    expect(tokenFrames(broadcast)[0].replay).toBeUndefined();
    vi.advanceTimersByTime(1_000);
    stream._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(tokenFrames(broadcast)).toHaveLength(1);
    // The same window replayed again (rows already persisted): one more frame.
    stream._onAgentEvent({ event: 'replay_begin', session_id: SID });
    for (let i = 1; i <= 10; i++) stream._onAgentEvent(usageEvent(i, `r${i}`));
    stream._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(tokenFrames(broadcast)).toHaveLength(2);
    expect(sessionTokenUsage(SID)).toMatchObject({ requests: 10, totalTokens: 110 });
  });

  it('a live burst publishes ONE trailing frame carrying the latest totals', () => {
    const stream = createStream('thinking', 'codex');
    const broadcast = vi.spyOn(stream, '_broadcast');
    for (let i = 1; i <= 5; i++) {
      stream._onAgentEvent(usageEvent(i, `b${i}`));
      vi.advanceTimersByTime(50);
    }
    expect(tokenFrames(broadcast)).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(tokenFrames(broadcast)).toHaveLength(1);
    expect(tokenFrames(broadcast)[0].usage).toMatchObject({ requests: 5, totalTokens: 55 });
    stream._onAgentEvent(usageEvent(6, 'b6'));
    vi.advanceTimersByTime(300);
    expect(tokenFrames(broadcast).map((f: any) => f.usage.requests)).toEqual([5, 6]);
  });

  it('a timer due inside a replay window waits for its replay_end; detach cancels a pending one', () => {
    const stream = createStream('thinking', 'codex');
    const broadcast = vi.spyOn(stream, '_broadcast');
    stream._onAgentEvent(usageEvent(1, 'live'));
    stream._onAgentEvent({ event: 'replay_begin', session_id: SID });
    vi.advanceTimersByTime(300);
    expect(tokenFrames(broadcast)).toHaveLength(0);
    stream._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(tokenFrames(broadcast)).toHaveLength(1);
    stream._onAgentEvent(usageEvent(2, 'cancelled'));
    stream.detach();
    vi.advanceTimersByTime(1_000);
    expect(tokenFrames(broadcast)).toHaveLength(1);
  });

  it('a persisted final turn_usage schedules the frame too; intermediate usage frames do not', () => {
    const stream = createStream('thinking', 'codex');
    const broadcast = vi.spyOn(stream, '_broadcast');
    stream._onAgentEvent({ event: 'usage', session_id: SID, seq: 1, final: false, input_tokens: 1, output_tokens: 1 });
    vi.advanceTimersByTime(300);
    expect(tokenFrames(broadcast)).toHaveLength(0);
    stream._onAgentEvent({ event: 'usage', session_id: SID, seq: 2, final: true, input_tokens: 40, output_tokens: 2 });
    vi.advanceTimersByTime(300);
    expect(tokenFrames(broadcast)).toHaveLength(1);
    expect(tokenFrames(broadcast)[0].usage).toMatchObject({ legacyTurns: 1, totalTokens: 42 });
  });

  it.each([false, true])('a cold token fold answers null, then its completion publishes the totals (hydrated stream: %s)', async (hydrated) => {
    vi.useRealTimers();
    const { rawSqlite } = await import('@/lib/db');
    const { invalidateSessionRowCaches } = await import('@/lib/server/agent/sessionRowCache');
    const { subscribeGlobalSessionEvents, getOrCreateStream } = await import('@/lib/server/agent/sessionOps');
    const ins = rawSqlite().prepare('INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, ?, ?, ?)');
    const usage = (id: string) => JSON.stringify({ type: 'endpoint_usage', requestId: id, inputTokens: 10, outputTokens: 1, totalTokens: 11 });
    // Reasoning rows: outside the token LIKE, and not FTS-indexed (cheap to wipe).
    const FILLER = JSON.stringify({ type: 'thinking', text: 'filler' });
    rawSqlite().transaction(() => {
      for (let i = 0; i < 20_050; i++) {
        const row = i === 3 ? ['event', usage('early')] : i === 20_045 ? ['event', usage('late')] : ['event', FILLER];
        ins.run(SID, row[0], row[1], 1_800_000_000_000 + i);
      }
    })();
    invalidateSessionRowCaches(SID);
    const stream = hydrated ? getOrCreateStream(SID) as any : null;
    const viaStream = stream ? vi.spyOn(stream, '_broadcast') : null;
    const frames: any[] = [];
    const off = subscribeGlobalSessionEvents((ev: any) => {
      if (ev.type === 'session_token_usage' && ev.sessionId === SID) frames.push(ev);
    });
    try {
      const { GET } = await import('@/app/api/sessions/[id]/route');
      const window = await (await GET(new Request(`http://localhost/api/sessions/${SID}?limit=5`),
        { params: Promise.resolve({ id: SID }) })).json();
      expect(window.tokenUsage).toBeNull();
      expect(mergeSessionTokenUsage(null, window.tokenUsage)).toBeNull();
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0].usage).toMatchObject({ requests: 2, totalTokens: 22 });
      if (viaStream) expect(tokenFrames(viaStream)).toHaveLength(1);
      const warm = await (await GET(new Request(`http://localhost/api/sessions/${SID}?limit=5`),
        { params: Promise.resolve({ id: SID }) })).json();
      expect(warm.tokenUsage).toEqual(frames[0].usage);
    } finally {
      off();
      (globalThis as any)._sessionStreams?.delete(SID);
    }
  }, 30_000);

  it('while the token fold warms, neither the live timer nor replay_end publishes; its completion publishes ONE frame', async () => {
    const { rawSqlite } = await import('@/lib/db');
    const { invalidateSessionRowCaches, sessionRowCacheStats } = await import('@/lib/server/agent/sessionRowCache');
    const { TOKEN_FOLD_SLICE_ROWS } = await import('@/lib/server/agent/sessionTokenUsage');
    const { subscribeGlobalSessionEvents } = await import('@/lib/server/agent/sessionOps');
    const ins = rawSqlite().prepare('INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, ?, ?, ?)');
    const early = JSON.stringify({ type: 'endpoint_usage', requestId: 'early', inputTokens: 10, outputTokens: 1, totalTokens: 11 });
    // Reasoning rows: outside the token LIKE, and not FTS-indexed (cheap to wipe).
    const FILLER = JSON.stringify({ type: 'thinking', text: 'filler' });
    // Two synchronous slices (the timer's, then replay_end's) leave a tail for
    // the background chain.
    const ROWS = 2 * TOKEN_FOLD_SLICE_ROWS + 50;
    rawSqlite().transaction(() => {
      for (let i = 0; i < ROWS; i++) ins.run(SID, 'event', i === 3 ? early : FILLER, 1_800_000_000_000 + i);
    })();
    invalidateSessionRowCaches(SID);
    // Only the debounce timer is faked: the chain runs on REAL setImmediate.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stream = createStream('thinking', 'codex');
    const frames: any[] = [];
    const off = subscribeGlobalSessionEvents((ev: any) => {
      if (ev.type === 'session_token_usage' && ev.sessionId === SID) frames.push(ev);
    });
    try {
      stream._onAgentEvent(usageEvent(1, 'live'));
      vi.advanceTimersByTime(300);             // reads the cold fold: one slice, null ⇒ no frame
      expect(frames).toHaveLength(0);
      expect(sessionRowCacheStats().chains).toBe(1);
      stream._onAgentEvent({ event: 'replay_begin', session_id: SID });
      stream._onAgentEvent(usageEvent(2, 'replayed'));
      stream._onAgentEvent({ event: 'replay_end', session_id: SID });   // one more slice, still null
      expect(frames).toHaveLength(0);
      expect(sessionRowCacheStats().chains).toBe(1);

      vi.useRealTimers();
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0].usage).toMatchObject({ requests: 3, totalTokens: 33 });
      expect(sessionTokenUsage(SID)).toEqual(frames[0].usage);
      // Nothing was left dirty: a later replay_end publishes nothing more.
      stream._onAgentEvent({ event: 'replay_end', session_id: SID });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frames).toHaveLength(1);
    } finally {
      off();
    }
  }, 30_000);

  it.each(['delete', 'archive'] as const)('%s frees the session\'s row folds (every key)', async (action) => {
    const { invalidateSessionRowCaches, sessionRowCacheStats } = await import('@/lib/server/agent/sessionRowCache');
    invalidateSessionRowCaches();
    const stream = createStream('active', 'claude');
    stream._onAgentEvent({ event: 'bg_task', session_id: SID, seq: 1, kind: 'started', task_id: 't', ts: Date.now() / 1000 });
    stream._onAgentEvent({ event: 'usage', session_id: SID, seq: 2, final: true, input_tokens: 5, output_tokens: 1 });
    sessionTokenUsage(SID);
    recordedSessionUsage(SID);
    runningBgTaskDetailsFromDb(SID);
    expect(sessionRowCacheStats().entries).toBe(3);
    if (action === 'delete') {
      const { deleteSession } = await import('@/lib/server/agent/sessionOps');
      expect((await deleteSession(SID)).deleted).toBe(true);
    } else {
      const { POST } = await import('@/app/api/sessions/[id]/archive/route');
      const res = await POST(new Request(`http://localhost/api/sessions/${SID}/archive`, { method: 'POST' }),
        { params: Promise.resolve({ id: SID }) });
      expect(res.status).toBe(200);
    }
    expect(sessionRowCacheStats().entries).toBe(0);
  });

  it('a ?before= page is LEAN (page fields only, no session-wide fold) and keeps peer anchors', async () => {
    const stream = createStream('thinking');
    stream._persist('user', 'First human prompt');
    stream._onAgentEvent({ event: 'external_message', session_id: SID, seq: 1,
      origin: 'charon_peer', text: 'Peer request', message_id: 'request-anchor', from: 'requester' });
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, seq: 2, delta: 'Peer answer' });
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 3, peer_request_id: 'request-anchor' });
    stream._persist('user', 'Human follow-up');
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, seq: 4, delta: 'Human answer' });
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 5, peer_request_id: null });
    const { GET } = await import('@/app/api/sessions/[id]/route');
    const { sessionRowCacheStats } = await import('@/lib/server/agent/sessionRowCache');
    const get = async (query: string) => (await GET(new Request(`http://localhost/api/sessions/${SID}${query}`),
      { params: Promise.resolve({ id: SID }) })).json();
    const root = await get('?limit=1');
    expect(root.tokenUsage).toBeDefined();
    const followUp = await get(`?before=${root.oldestChatId}&limit=1`);
    const slices = sessionRowCacheStats().slices;
    const page = await get(`?before=${followUp.oldestChatId}&limit=1`);
    expect(sessionRowCacheStats().slices).toBe(slices);
    // + `sync` (C12): the bus revision the page reflects.
    expect(Object.keys(page).sort()).toEqual(['hasMore', 'messages', 'oldestChatId', 'sync']);
    expect(page.hasMore).toBe(true);
    // The request row belongs to the OLDER page: only the backward walk links it.
    expect(page.messages.some((m: any) => m.role === 'event')).toBe(false);
    expect(page.messages.find((m: any) => m.role === 'assistant')).toMatchObject({
      content: 'Peer answer', peerReplyTo: 'request-anchor',
    });
  });
});

describe('internal peer completion notices', () => {
  function peerInput(stream: any, seq = 1, reply = false) {
    stream._onAgentEvent({ event: 'external_message', session_id: SID, seq,
      origin: reply ? 'charon_peer_reply' : 'charon_peer', text: 'Run the tests',
      from: 'requester', message_id: 'request', expects_reply: !reply });
  }

  it.each(['claude', 'codex', 'cursor'] as const)('keeps %s target stops silent, even before the input event arrives', (kind) => {
    const stream = createStream('thinking', kind);
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 1, peer_request_id: 'request' });
    expect(pushMocks.sendPushToAll).not.toHaveBeenCalled();
    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();
    expect(sessionRow().unreadStop).toBe(0);
    expect(sessionRow().lastStopNotifiedSeq).toBe(1);
  });

  it('recognizes older-agent peer turns from durable input after hub restart', () => {
    peerInput(createStream());
    const revived = createStream('thinking');
    revived._onAgentEvent({ event: 'stop', session_id: SID, seq: 2 });
    expect(pushMocks.sendPushToAll).not.toHaveBeenCalled();
    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();
    expect(sessionRow().unreadStop).toBe(0);
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent({ event: 'stop', session_id: SID, seq: 2 });
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(sessionRow().unreadStop).toBe(0);
  });

  it('still notifies the requester after it receives the correlated reply', () => {
    const stream = createStream('thinking');
    peerInput(stream, 1, true);
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 2 });
    expect(pushMocks.sendPushToAll).toHaveBeenCalledWith(expect.objectContaining({ event: 'session_finished' }));
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(sessionRow().unreadStop).toBe(1);
  });

  it.each(['user', 'explicit normal stop'])('restores normal notices for a later %s', (next) => {
    const stream = createStream('thinking');
    peerInput(stream);
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 2 });
    if (next === 'user') stream._persist('user', 'My next task');
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 3,
      ...(next === 'explicit normal stop' ? { peer_request_id: null } : {}) });
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
  });

  it('keeps internal background completion silent across restart', () => {
    const stream = createStream('thinking');
    peerInput(stream);
    stream._onAgentEvent(bgTask(2, 'started', 'child'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 3, peer_request_id: 'request' });
    const revived = createStream('background');
    expect(revived.hasRunningBgTasks()).toBe(true);
    revived._onAgentEvent(bgTask(4, 'finished', 'child'));
    vi.advanceTimersByTime(6_000);
    expect(revived.status).toBe('active');
    expect(pushMocks.sendPushToAll).not.toHaveBeenCalled();
    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();
    expect(sessionRow().unreadStop).toBe(0);
  });

  it('still reports errors from a peer-driven turn', () => {
    const stream = createStream('thinking');
    peerInput(stream);
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 2,
      peer_request_id: 'request', subtype: 'error' });
    expect(pushMocks.sendPushToAll).toHaveBeenCalledWith(expect.objectContaining({ event: 'session_error' }));
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
  });
});

describe('assistant peer anchors across message pages', () => {
  it.each([
    { reply_to: 'outbound-request' },
    { origin: 'charon_peer_reply' },
    { expects_reply: false },
  ])('keeps internal updates unlinked after a received reply across full history, root and delta: %j', async (metadata) => {
    const stream = createStream('thinking');
    stream._onAgentEvent({ event: 'external_message', session_id: SID, seq: 1,
      origin: 'charon_peer', text: 'Earlier request', message_id: 'earlier-request', expects_reply: true });
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, seq: 2, delta: 'Earlier peer answer' });
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 3, peer_request_id: 'earlier-request' });
    stream._onAgentEvent({ event: 'external_message', session_id: SID, seq: 4,
      origin: 'charon_peer', text: 'DNS configured', message_id: 'received-reply', ...metadata });
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, seq: 5, delta: 'Continuing my own task' });
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 6, peer_request_id: null });
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, seq: 7, delta: 'Internal progress update' });
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 8, peer_request_id: null });

    const { GET } = await import('@/app/api/sessions/[id]/route');
    const get = async (query: string) => (await GET(new Request(`http://localhost/api/sessions/${SID}${query}`),
      { params: Promise.resolve({ id: SID }) })).json();
    const full = await get('');
    expect(full.messages.find((m: any) => m.content === 'Earlier peer answer').peerReplyTo).toBe('earlier-request');
    const updates = full.messages.filter((m: any) => m.role === 'assistant' && m.content !== 'Earlier peer answer');
    expect(updates).toHaveLength(2);
    for (const update of updates) expect(update.peerReplyTo).toBeUndefined();

    const root = await get('?limit=1');
    expect(root.hasMore).toBe(true);
    expect(root.messages.some((m: any) => m.role === 'event' && JSON.parse(m.content).type === 'external_message')).toBe(false);
    expect(root.messages.find((m: any) => m.role === 'assistant').peerReplyTo).toBeUndefined();
    const delta = await get(`?since=${updates[0].id - 1}`);
    for (const update of delta.messages.filter((m: any) => m.role === 'assistant')) {
      expect(update.peerReplyTo).toBeUndefined();
    }

    const { rebuildStateFromMessages } = await import('@/app/sessionRebuild');
    const { peerAssistantReplies } = await import('@/app/peerMessageLinks');
    const rebuilt = rebuildStateFromMessages(full.messages, 'active');
    const links = peerAssistantReplies(rebuilt.messages);
    expect([...links.replyToById.values()]).toEqual(['earlier-request']);
    expect(links.streamingReplyTo).toBeNull();
    expect(peerAssistantReplies(rebuildStateFromMessages(root.messages, 'active').messages).replyToById.size).toBe(0);
  });

  it('returns the original peer input on an assistant-only root window and delta', async () => {
    const stream = createStream('thinking');
    stream._persist('user', 'Earlier human task');
    stream._onAgentEvent({ event: 'external_message', session_id: SID, seq: 1,
      origin: 'charon_peer', text: 'Peer request', message_id: 'request-anchor', from: 'requester' });
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, seq: 2, delta: 'Peer answer' });
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 3, peer_request_id: 'request-anchor' });
    const { GET } = await import('@/app/api/sessions/[id]/route');
    const get = async (query: string) => (await GET(new Request(`http://localhost/api/sessions/${SID}${query}`),
      { params: Promise.resolve({ id: SID }) })).json();
    const root = await get('?limit=1');
    expect(root.hasMore).toBe(true);
    expect(root.messages.some((m: any) => m.role === 'event' && JSON.parse(m.content).type === 'external_message')).toBe(false);
    const answer = root.messages.find((m: any) => m.role === 'assistant');
    expect(answer.peerReplyTo).toBe('request-anchor');
    const delta = await get(`?since=${answer.id - 1}`);
    expect(delta.messages.find((m: any) => m.id === answer.id).peerReplyTo).toBe('request-anchor');
    const { rebuildStateFromMessages } = await import('@/app/sessionRebuild');
    expect(rebuildStateFromMessages(root.messages, 'active').messages.find((m: any) => m.role === 'assistant')?.replyTo)
      .toBe('request-anchor');

    // A later human turn must not inherit the old peer classification.
    stream._persist('user', 'Human follow-up');
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, seq: 4, delta: 'Human answer' });
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 5, peer_request_id: null });
    const human = await get('?limit=1');
    expect(human.messages.find((m: any) => m.role === 'assistant').peerReplyTo).toBeUndefined();
  });
});

describe('a turn that ends with background tasks still running (§14.91)', () => {
  it.each(['claude', 'codex'] as const)('counts only live tasks and deduplicates %s notices across replay/restart', (kind) => {
    setSetting('notif.global_enabled', 'true');
    const stream = createStream('thinking', kind);
    stream._onAgentEvent(bgTask(1, 'started', 'expired'));
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    stream._onAgentEvent(bgTask(2, 'started', 'finished'));
    stream._onAgentEvent(bgTask(3, 'finished', 'finished'));
    stream._onAgentEvent(bgTask(4, 'started', 'live'));
    const stop = { event: 'stop', session_id: SID, subtype: 'end_turn', seq: 5 };
    stream._onAgentEvent(stop);
    stream._onAgentEvent(stop);
    const revived = createStream('background', kind);
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent(stop);
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    revived._onAgentEvent(stop);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(1);
    const body = `${kind === 'codex' ? 'Codex' : 'Claude'} finished its response — 1 background task still running`;
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledWith(
      `✓ test-vps · build\n${body}`, `/?session=${SID}`, 'session_background',
    );
    expect(pushMocks.sendPushToAll).toHaveBeenCalledWith({
      event: 'session_background', title: '✓ test-vps · build', body, tag: `stop-${SID}`,
      sessionId: SID, url: `/?session=${SID}`,
    });
    expect(sessionRow().unreadStop).toBe(0);
  });

  it('notifies a fatal error without needing a stop, and deduplicates a later stop', () => {
    const stream = createStream('thinking');
    stream._onAgentEvent({ event: 'error', session_id: SID, fatal: true, msg: 'SDK crashed', seq: 1 });
    expect(pushMocks.sendPushToAll).toHaveBeenCalledWith(expect.objectContaining({ event: 'session_error' }));
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'error', seq: 2 });
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
  });

  it('does not notify a background stop first seen during replay', () => {
    setSetting('notif.global_enabled', 'true');
    const stream = createStream();
    stream._onAgentEvent({ event: 'replay_begin', session_id: SID });
    stream._onAgentEvent(bgTask(1, 'started', 'child'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 2 });
    stream._onAgentEvent({ event: 'replay_end', session_id: SID });
    vi.advanceTimersByTime(60_000);
    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();
    expect(pushMocks.sendPushToAll).not.toHaveBeenCalled();
  });

  it('persists Stop-hook reconciliation for the bar, reload and quiet gate', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'child'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 2, subtype: 'end_turn' });
    stream._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 3, background_tasks: [] });
    expect(stream.status).toBe('active');
    expect(runningBgTaskDetailsFromDb(SID)).toEqual([]);
    expect(createStream().hasRunningBgTasks()).toBe(false);
    const before = db.select().from(schema.sessionMessages).all().length;
    stream._onAgentEvent({ event: 'replay_begin', session_id: SID });
    stream._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 3, background_tasks: [] });
    stream._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(db.select().from(schema.sessionMessages).all()).toHaveLength(before);
  });

  it("keeps a sub-agent's own command the Stop hook cannot see, while its owner runs", () => {
    const stream = createStream();
    const started = (seq: number, taskId: string, extra: Record<string, unknown>) => ({
      ...bgTask(seq, 'started', taskId), ...extra,
    });
    stream._onAgentEvent(started(1, 'wf', { task_type: 'local_workflow' }));
    stream._onAgentEvent(started(2, 'fuzz', { task_type: 'local_bash', owned_by_subagent: true }));
    stream._onAgentEvent(started(3, 'legacy', { task_type: 'local_bash' }));
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 4, subtype: 'end_turn' });
    // The hook lists the workflow, never the command one of its agents runs.
    stream._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 5, background_tasks: ['wf'] });
    expect(runningBgTaskDetailsFromDb(SID).map((t: any) => t.taskId).sort()).toEqual(['fuzz', 'wf']);
    expect(stream.runningBgTaskCount()).toBe(2);

    // Owner gone: the next hook's silence means what it says again.
    stream._onAgentEvent(bgTask(6, 'finished', 'wf'));
    expect(stream.status).toBe('background');
    stream._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 7, background_tasks: [] });
    expect(runningBgTaskDetailsFromDb(SID)).toEqual([]);
    expect(stream.status).toBe('active');
  });

  it.each(['turn_end', 'ready'])('replaying %s without a prior receipt preserves newer persisted tasks', (event) => {
    const stream = createStream();
    const old = { event, session_id: SID, seq: 2, background_tasks: [] };
    stream._onAgentEvent(old); // Nothing to bury, hence no identity receipt.
    stream._onAgentEvent(bgTask(3, 'started', 'new-child'));
    const before = db.select().from(schema.sessionMessages).all().length;
    const revived = createStream('background');
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent(old);
    revived._onAgentEvent(bgTask(3, 'started', 'new-child'));
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(runningBgTaskDetailsFromDb(SID).map((t: any) => t.taskId)).toEqual(['new-child']);
    expect(revived.hasRunningBgTasks()).toBe(true);
    expect(revived.status).toBe('background');
    expect(db.select().from(schema.sessionMessages).all()).toHaveLength(before);
  });

  it('a replayed Stop hook still closes older absent tasks while preserving later ones', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'old-child'));
    stream._onAgentEvent(bgTask(3, 'started', 'new-child'));
    const revived = createStream('background');
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 2, background_tasks: [] });
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(runningBgTaskDetailsFromDb(SID).map((t: any) => t.taskId)).toEqual(['new-child']);
    expect([...revived.bgRunning.keys()]).toEqual(['new-child']);
  });

  it('uses event time across sequence resets and protects a reused task from old hooks', () => {
    const stream = createStream();
    const now = Date.now() / 1000;
    stream._onAgentEvent({ ...bgTask(100, 'started', 'reused'), ts: now - 20 });
    stream._onAgentEvent({ ...bgTask(101, 'finished', 'reused'), ts: now - 10 });
    stream._onAgentEvent({ ...bgTask(1, 'updated', 'reused', 'running'), terminal: false, ts: now });
    const revived = createStream('background');
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 102, ts: now - 5, background_tasks: [] });
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(revived.hasRunningBgTasks()).toBe(true);
    // A newer hook in the new sequence epoch can close it normally.
    revived._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 2, ts: now + 1, background_tasks: [] });
    expect(createStream().hasRunningBgTasks()).toBe(false);
  });

  it('does not let an undated legacy replay close hydrated tasks', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'child'));
    const revived = createStream('background');
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent({ event: 'turn_end', session_id: SID, background_tasks: [] });
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(revived.hasRunningBgTasks()).toBe(true);
    revived._onAgentEvent({ event: 'turn_end', session_id: SID, background_tasks: [] });
    expect(revived.hasRunningBgTasks()).toBe(false);
  });

  it.each(['turn_end', 'ready'])('keeps a task visible when the %s receipt cannot be persisted', (event) => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'child'));
    const persist = vi.spyOn(stream, '_persist').mockReturnValue(false);
    const broadcast = vi.spyOn(stream, '_broadcast');
    stream._onAgentEvent({ event, session_id: SID, seq: 2, background_tasks: [] });
    expect(stream.hasRunningBgTasks()).toBe(true);
    expect(broadcast.mock.calls.some(([ev]: any[]) => ev.type === 'bg_task' && ev.kind === 'finished')).toBe(false);
    persist.mockRestore();
    stream._onAgentEvent({ event, session_id: SID, seq: 2, background_tasks: [] });
    expect(createStream().hasRunningBgTasks()).toBe(false);
  });

  it('repairs a Codex child from native completion and ignores late metadata', async () => {
    const stream = createStream('active', 'codex');
    stream.nativeSessionId = 'parent';
    stream._onAgentEvent({ ...bgTask(1, 'started', 'child'), task_type: 'codex_subagent', ts: 100 });
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 2, subtype: 'end_turn' });
    stream.attach();
    bgMocks.read.mockResolvedValue([{ taskId: 'child', status: 'completed', at: Date.now() / 1000 + 1 }]);
    await stream._reconcileCodexBgTasks();
    expect(stream.status).toBe('active');
    expect(runningBgTaskDetailsFromDb(SID)).toEqual([]);
    stream._onAgentEvent({ ...bgTask(3, 'updated', 'child'), task_type: 'codex_subagent' });
    expect(stream.hasRunningBgTasks()).toBe(false);
    expect(createStream('active', 'codex').hasRunningBgTasks()).toBe(false);
    stream.detach();
  });

  it('keeps native running/unknown tasks and ignores an observation superseded by activity', async () => {
    const stream = createStream('active', 'codex');
    stream.nativeSessionId = 'parent';
    stream._onAgentEvent({ ...bgTask(1, 'started', 'child'), task_type: 'codex_subagent' });
    stream.attach();
    await stream._reconcileCodexBgTasks();
    expect(stream.hasRunningBgTasks()).toBe(true);
    let resolve!: (rows: any[]) => void;
    bgMocks.read.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const read = stream._reconcileCodexBgTasks();
    stream._onAgentEvent({ ...bgTask(2, 'updated', 'child'), task_type: 'codex_subagent' });
    resolve([{ taskId: 'child', status: 'completed', at: Date.now() / 1000 + 1 }]);
    await read;
    expect(stream.hasRunningBgTasks()).toBe(true);
    stream.detach();
  });
  it('adopts a background task discovered just after the provider stop', () => {
    const stream = createStream();
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 1 });
    expect(stream.status).toBe('active');
    stream._onAgentEvent(bgTask(2, 'started', 'codex-terminal:pty-1'));
    expect(stream.status).toBe('background');
    expect(sessionRow().status).toBe('background');
    expect(sessionRow().unreadStop).toBe(0);
  });

  it('goes background instead of done, and stays there under the daemon idle frame', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'launched it', seq: 2 });
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 3 });

    expect(stream.status).toBe('background');
    expect(sessionRow().status).toBe('background');
    // Announce the response while preserving the background status/marker.
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledWith(
      '✓ test-vps · build\nClaude finished its response — 1 background task still running',
      `/?session=${SID}`, 'session_background',
    );
    // Browser filtering is now per subscription, inside webPush.
    expect(pushMocks.sendPushToAll).toHaveBeenCalledWith(expect.objectContaining({ event: 'session_background' }));
    expect(sessionRow().unreadStop).toBe(0);

    // The daemon goes idle the moment the turn ends and knows nothing about
    // the task it left running: its `active` must not repaint the session.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 4 });
    expect(stream.status).toBe('background');
    expect(sessionRow().status).toBe('background');
  });

  it('announces the response, then completion once the last task ends', () => {
    setSetting('notif.global_enabled', 'true');
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent(bgTask(2, 'started', 'task-b'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 3 });
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 4 });

    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendPlainToTelegram.mock.calls[0][0])
      .toContain('2 background tasks still running');
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(1);
    expect(pushMocks.sendPushToAll.mock.calls[0][0].body)
      .toBe('Claude finished its response — 2 background tasks still running');
    // One of two: still background, no additional notice.
    stream._onAgentEvent(bgTask(5, 'finished', 'task-a'));
    expect(stream.status).toBe('background');
    vi.advanceTimersByTime(60_000);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);

    stream._onAgentEvent(bgTask(6, 'finished', 'task-b'));
    expect(stream.status).toBe('active');
    expect(sessionRow().status).toBe('active');
    // …but the notification waits out the grace, in case the model takes the
    // session back for a follow-up turn.
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(2);
    expect(telegramMocks.sendPlainToTelegram.mock.calls[1][0])
      .toContain('background tasks finished');
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(2);
    expect(pushMocks.sendPushToAll.mock.calls[1][0].body).toBe('background tasks finished');
    expect(sessionRow().unreadStop).toBe(1);
  });

  it('drops the deferred notice when a follow-up turn claims the session', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    stream._onAgentEvent(bgTask(3, 'finished', 'task-a'));
    // The finished task re-invoked the model (§14.54) before the grace ran out.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'thinking', seq: 4 });
    vi.advanceTimersByTime(60_000);

    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(stream.status).toBe('thinking');

    // That turn's own stop is a normal finish and notifies normally.
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'all done', seq: 5 });
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 6 });
    // Nothing is running now, so the daemon's idle frame is adopted as usual.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 7 });
    expect(stream.status).toBe('active');
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(2);
    expect(telegramMocks.sendPlainToTelegram.mock.calls[1][0])
      .toContain('Claude finished its response');
  });

  it('a task reported as completed via `updated` counts as finished', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    expect(stream.status).toBe('background');
    stream._onAgentEvent(bgTask(3, 'updated', 'task-a', 'completed'));
    expect(stream.status).toBe('active');
  });

  it('mirrors the running count to every tab on change only (sidebar card)', () => {
    const stream = createStream();
    const broadcast = vi.spyOn(stream, '_broadcast');
    const counts = () => broadcast.mock.calls
      .map(([ev]: any[]) => ev)
      .filter((ev: any) => ev.type === 'session_bg_tasks')
      .map((ev: any) => ev.running);
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent(bgTask(2, 'started', 'task-b'));
    stream._onAgentEvent(bgTask(3, 'updated', 'task-b', 'running'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 4 });
    expect(stream.runningBgTaskCount()).toBe(2);
    stream._onAgentEvent(bgTask(5, 'finished', 'task-a'));
    // The Stop hook's list and a pause both close tasks outside `bg_task`.
    stream._onAgentEvent(bgTask(6, 'started', 'task-c'));
    stream._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 7, background_tasks: ['task-c'] });
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'sleeping', seq: 8 });
    expect(counts()).toEqual([1, 2, 1, 2, 1, 0]);
    expect(stream.runningBgTaskCount()).toBe(0);
  });

  it('a normal turn with no background work is unaffected', () => {
    const stream = createStream();
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'done', seq: 1 });
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    expect(stream.status).toBe('active');
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendPlainToTelegram.mock.calls[0][0])
      .toContain('Claude finished its response');
    expect(sessionRow().unreadStop).toBe(1);
  });

  it('a sleeping session buries its background tasks instead of resurrecting them', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    expect(stream.status).toBe('background');

    // The CLI process is what runs those children: pausing it kills them.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'sleeping', seq: 3 });
    expect(stream.hasRunningBgTasks()).toBe(false);

    // A fresh stream (hub restart / resume) rebuilds the registry from the
    // rows: it must NOT come back believing the task is still running.
    const revived = createStream('active');
    expect(revived.hasRunningBgTasks()).toBe(false);
    revived._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 4 });
    expect(revived.status).toBe('active');
  });

  it('a restarted CLI (`ready`) buries the tasks the dead one left running', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    expect(stream.status).toBe('background');

    // The daemon was restarted under the session (crash, OOM, systemctl): it
    // rebuilds the session with a BRAND-NEW ClaudeSDKClient and announces it
    // with `ready`. The old CLI's children died with it — nothing will ever
    // report that task finished.
    stream._onAgentEvent({ event: 'ready', session_id: SID, seq: 3 });
    expect(stream.hasRunningBgTasks()).toBe(false);

    // …so the fresh client's idle frame is adopted: the session is `active`
    // ("ready" in the sidebar) AND nothing claims to still be working.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 4 });
    expect(stream.status).toBe('active');
    expect(sessionRow().status).toBe('active');

    // Durable: the burial is persisted as terminal rows, so neither a hub
    // restart nor sdkWatch's quiet gate sees a phantom running task.
    expect(createStream('active').hasRunningBgTasks()).toBe(false);
  });

  it('a replayed `ready` buries what preceded it, never what came after', () => {
    const stream = createStream();
    // The restart that matters usually drops the SSH connection too, so the
    // whole sequence arrives inside the reconnect replay.
    stream._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'ready', session_id: SID, seq: 2 });
    stream._onAgentEvent(bgTask(3, 'started', 'task-b'));
    stream._onAgentEvent({ event: 'replay_end', session_id: SID });

    expect(stream.hasRunningBgTasks()).toBe(true);
    expect([...stream.bgRunning.keys()]).toEqual(['task-b']);
    // task-a is buried in the ROWS, so nothing resurrects it later.
    expect(createStream('background').hasRunningBgTasks()).toBe(true);

    // `ready` persists no row, so it has no identity gate: replaying the same
    // range again must not bury the task the ready itself started.
    const revived = createStream('background');
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
    revived._onAgentEvent(bgTask(1, 'started', 'task-a'));
    revived._onAgentEvent({ event: 'ready', session_id: SID, seq: 2 });
    revived._onAgentEvent(bgTask(3, 'started', 'task-b'));
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(revived.hasRunningBgTasks()).toBe(true);
    expect([...revived.bgRunning.keys()]).toEqual(['task-b']);
  });

  it('rebuilds a still-running task from the persisted rows after a hub restart', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    expect(stream.hasRunningBgTasks()).toBe(true);

    const revived = createStream('background');
    expect(revived.hasRunningBgTasks()).toBe(true);
    revived._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 2 });
    expect(revived.status).toBe('background');
  });

  it('projects a running task even after it falls beyond the 200-message chat window', () => {
    const stream = createStream();
    stream._onAgentEvent({
      ...bgTask(1, 'started', 'task-beyond-window'),
      description: 'wait for the long benchmark',
      task_type: 'local_bash',
    });
    db.insert(schema.sessionMessages).values(Array.from({ length: 201 }, (_, i) => ({
      sessionId: SID,
      role: 'user',
      content: `later message ${i}`,
      createdAt: Math.floor(Date.now() / 1000) + i + 1,
    }))).run();

    expect(runningBgTaskDetailsFromDb(SID)).toEqual([
      expect.objectContaining({
        taskId: 'task-beyond-window',
        description: 'wait for the long benchmark',
        taskType: 'local_bash',
        status: 'running',
      }),
    ]);
  });

  // Last on purpose: resumeSession registers its stream in the module map.
  it("a noop resume (every hub restart) does not repaint running work as done", async () => {
    const { resumeSession } = await import('@/lib/server/agent/sessionOps');
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'watcher'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    // Even a row an older hub already repainted green heals on the next one.
    db.update(schema.agentSessions).set({ status: 'active' }).run();
    clientMocks.call.mockResolvedValueOnce({ ok: true, status: 'active', noop: true });
    const resumed = await resumeSession(SID);
    expect(resumed.status).toBe('background');
    expect(sessionRow().status).toBe('background');

    // A real restart killed the old CLI's tasks: its answer is adopted.
    clientMocks.call.mockResolvedValueOnce({ ok: true, status: 'starting' });
    expect((await resumeSession(SID)).status).toBe('starting');
  });
});
