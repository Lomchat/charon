import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Replay identity by indexed point lookups (CLAUDE.md §14.31, sync refonte
// C01): no session-wide read at replay_begin, ts-matched identity, the
// replay-only delta guard, the live flush of a replay-started buffer, and the
// AgentClient's synthetic `replay_end`. Same harness as replayExactness: a real
// migrated SQLite DB, the SessionStream driven through `_onAgentEvent`, DB
// failures injected by patching `db.insert`.

// The DB is the private throwaway one of tests/setup/hermeticDb.ts (one per
// file, removed after the run).

const pool = vi.hoisted(() => {
  // ONE stable client object: attach() compares client identity.
  const client = {
    setAfterSeq: () => {},
    subscribe: (..._args: any[]) => {},
    unsubscribe: () => {},
    resubscribe: (..._args: any[]) => {},
    call: async (..._args: any[]): Promise<any> => ({ ok: true, status: 'active' }),
  };
  return { client };
});
const bgMocks = vi.hoisted(() => ({ read: async (..._args: any[]): Promise<any[]> => [] }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => pool.client,
  getAgentClient: () => pool.client,
  dropAgentClient: async () => {},
}));
vi.mock('@/lib/server/hub/codexBgState', () => ({ readCodexBgState: (...a: any[]) => bgMocks.read(...a) }));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: async () => {} }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: async () => {},
  sendQuestionToTelegram: async () => {},
  markInteractionResolvedInTelegram: async () => {},
  sendPlainToTelegram: async () => {},
}));

const VPS_ID = 'identvps';
const SID = 'd'.repeat(32);
const FORK_SID = 'e'.repeat(32);
const BIG_SID = 'f'.repeat(32);
const RESUME_SID = '9'.repeat(32);
const T0 = 1_760_000_000_000;

let db: any;
let schema: any;
let sqlite: any;
let SessionStream: any;
let resumeSession: any;
let stats: { pointLookups: number; legacyLoads: number };
let AgentClient: any;
const preparedSql: string[] = [];
let failNextInserts = 0;
let failNextMessageUpdates = 0;

function mkStream(opts: { id?: string; kind?: string; lastSeenSeq?: number | null; effectiveModel?: string | null } = {}) {
  return new SessionStream({
    id: opts.id ?? SID, vpsId: VPS_ID, name: null,
    status: 'active', permissionMode: 'normal', nativeSessionId: null,
    kind: opts.kind ?? 'claude', lastSeenSeq: opts.lastSeenSeq ?? null,
    effectiveModel: opts.effectiveModel ?? null,
  }) as any;
}

function rows(sid = SID, role?: string) {
  const all = db.select().from(schema.sessionMessages).all().filter((r: any) => r.sessionId === sid);
  return role ? all.filter((r: any) => r.role === role) : all;
}

/** Agent event with the agent's own `ts` (unix SECONDS, float). */
function ev(sid: string, event: string, seq: number | null, tsMs: number | null, extra: Record<string, unknown> = {}) {
  return {
    event, session_id: sid,
    ...(seq != null ? { seq } : {}),
    ...(tsMs != null ? { ts: tsMs / 1000 } : {}),
    ...extra,
  };
}

function replay(s: any, sid: string, evs: any[]) {
  s._onAgentEvent({ event: 'replay_begin', session_id: sid, count: evs.length });
  for (const e of evs) s._onAgentEvent(e);
  s._onAgentEvent({ event: 'replay_end', session_id: sid });
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  sqlite = dbMod.rawSqlite();
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  for (const id of [SID, FORK_SID, BIG_SID, RESUME_SID]) {
    db.insert(schema.agentSessions).values({ id, vpsId: VPS_ID, cwd: '/tmp', status: 'active' }).onConflictDoNothing().run();
  }
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();

  // Capture every statement prepared on the shared handle (replayIdentity
  // prepares lazily, on its first lookup — always after this spy).
  const realPrepare = sqlite.prepare.bind(sqlite);
  vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
    preparedSql.push(source);
    return realPrepare(source);
  }) as any);

  const realInsert = db.insert.bind(db);
  vi.spyOn(db, 'insert').mockImplementation(((table: any) => {
    if (failNextInserts > 0) {
      failNextInserts--;
      const boom = () => { throw new Error('injected DB failure'); };
      return { values: () => ({ run: boom, onConflictDoNothing: () => ({ run: boom }) }) };
    }
    return realInsert(table);
  }) as any);
  const realUpdate = db.update.bind(db);
  vi.spyOn(db, 'update').mockImplementation(((table: any) => {
    if (failNextMessageUpdates > 0 && table === schema.sessionMessages) {
      failNextMessageUpdates--;
      const boom = () => { throw new Error('injected DB failure'); };
      return { set: () => ({ where: () => ({ run: boom }) }) };
    }
    return realUpdate(table);
  }) as any);

  ({ SessionStream, resumeSession } = await import('@/lib/server/agent/sessionOps'));
  ({ replayIdentityStats: stats } = await import('@/lib/server/agent/replayIdentity'));
  ({ AgentClient } = await import('@/lib/server/agent/AgentClient'));
});

afterEach(() => {
  failNextInserts = 0;
  failNextMessageUpdates = 0;
  for (const id of [SID, FORK_SID]) {
    db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, id)).run();
  }
  db.delete(schema.sessionPendingQuestions).run();
  db.update(schema.agentSessions).set({ lastSeenSeq: null, pendingAssistantMessageId: null, effectiveModel: null }).run();
});

function countRows(sid: string): number {
  return (sqlite.prepare('SELECT count(*) AS c FROM session_messages WHERE session_id = ?').get(sid) as { c: number }).c;
}

describe('indexed replay identity', () => {
  // Explicit timeout: most of the time is the 50 k-row setup (FTS triggers).
  it('replay_begin on 50 k stamped rows reads nothing session-wide; lookups use the seq index', { timeout: 30_000 }, () => {
    const insert = sqlite.prepare(
      'INSERT INTO session_messages (session_id, role, content, seq, ts_ms) VALUES (?, ?, ?, ?, ?)');
    sqlite.transaction(() => {
      for (let i = 1; i <= 50_000; i++) {
        insert.run(BIG_SID, 'event', JSON.stringify({ type: 'thinking', text: `t${i}` }), i, T0 + i);
      }
    })();
    const before = { ...stats };
    const s = mkStream({ id: BIG_SID });
    // Every statement replay_begin prepares OR executes, whatever its shape:
    // drizzle, a raw prepare, or a statement cached by an earlier call (spied
    // on the shared Statement prototype, which every statement inherits).
    const stmtProto = Object.getPrototypeOf(sqlite.prepare('SELECT 1'));
    const preparedBefore = preparedSql.length;
    const executed: string[] = [];
    const execSpies = (['all', 'get', 'iterate', 'run'] as const).map((m) => {
      const real = stmtProto[m];
      return vi.spyOn(stmtProto, m).mockImplementation(function (this: any, ...args: any[]) {
        executed.push(this.source);
        return real.apply(this, args);
      } as any);
    });
    try {
      s._onAgentEvent({ event: 'replay_begin', session_id: BIG_SID, count: 3 });
    } finally {
      for (const spy of execSpies) spy.mockRestore();
    }
    expect(stats.legacyLoads).toBe(before.legacyLoads);
    expect(stats.pointLookups).toBe(before.pointLookups);
    // Nothing touches the transcript table (the old 2.9 M-entry Set build).
    expect(executed.length).toBeGreaterThan(0); // the spy sees the pending-id reads
    const touched = [...preparedSql.slice(preparedBefore), ...executed]
      .filter((q) => /session_messages/.test(q));
    expect(touched).toEqual([]);

    // Already-persisted events are skipped by a point lookup each.
    s._onAgentEvent(ev(BIG_SID, 'thinking', 49_999, T0 + 49_999, { text: 't49999' }));
    s._onAgentEvent(ev(BIG_SID, 'thinking', 50_000, T0 + 50_000, { text: 't50000' }));
    s._onAgentEvent({ event: 'replay_end', session_id: BIG_SID });
    expect(countRows(BIG_SID)).toBe(50_000);
    expect(stats.pointLookups).toBe(before.pointLookups + 2);
    expect(stats.legacyLoads).toBe(before.legacyLoads);

    // Every identity statement is an index SEARCH, never a scan or a sort.
    const identitySql = [...new Set(preparedSql.filter((q) =>
      /session_messages/.test(q) && /(@sid|seq IS NOT NULL LIMIT 1|seq IS NULL)/.test(q)))];
    expect(identitySql.length).toBeGreaterThanOrEqual(2);
    for (const q of identitySql) {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${q}`)
        .all(...(q.includes('@sid') ? [{ sid: BIG_SID, seq: 1, ts: null }] : [BIG_SID]))
        .map((r: any) => r.detail).join(' | ');
      expect(plan, q).toMatch(/idx_session_messages_session_seq/);
      expect(plan, q).not.toMatch(/TEMP B-TREE|SCAN session_messages/);
    }
    sqlite.prepare('DELETE FROM session_messages WHERE session_id = ?').run(BIG_SID);
  });

  it('loads the legacy Sets lazily: first seq-less event / first replayed tool row of a fork-shaped session', () => {
    // Fork copy: every row has seq NULL.
    db.insert(schema.sessionMessages).values([
      { sessionId: FORK_SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 'old-t', name: 'Bash', input: {} }), tsMs: T0 },
      { sessionId: FORK_SID, role: 'tool_result', content: JSON.stringify({ type: 'tool_result', tool_use_id: 'old-t', content: 'x' }), tsMs: T0 },
      { sessionId: FORK_SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'old thought' }), tsMs: T0 },
    ]).run();
    const s = mkStream({ id: FORK_SID });
    const base = stats.legacyLoads;
    s._onAgentEvent({ event: 'replay_begin', session_id: FORK_SID, count: 9 });
    s._onAgentEvent(ev(FORK_SID, 'status', 1, T0 + 1, { status: 'thinking' }));
    expect(stats.legacyLoads).toBe(base);
    // First replayed tool row → the one load of this window.
    s._onAgentEvent(ev(FORK_SID, 'tool_use', 2, T0 + 2, { id: 'new-t', name: 'Bash', input: {} }));
    expect(stats.legacyLoads).toBe(base + 1);
    s._onAgentEvent(ev(FORK_SID, 'tool_result', 3, T0 + 3, { tool_use_id: 'new-t', content: 'y', is_error: false }));
    // A copied tool id is still recognised by the legacy Set.
    s._onAgentEvent(ev(FORK_SID, 'tool_use', 4, T0 + 4, { id: 'old-t', name: 'Bash', input: {} }));
    s._onAgentEvent({ event: 'replay_end', session_id: FORK_SID });
    expect(stats.legacyLoads).toBe(base + 1);
    expect(rows(FORK_SID, 'tool_use').map((r: any) => JSON.parse(r.content).id)).toEqual(['old-t', 'new-t']);

    // New window: a seq-less event is what loads it (again: Sets live per window).
    s._onAgentEvent({ event: 'replay_begin', session_id: FORK_SID, count: 2 });
    expect(stats.legacyLoads).toBe(base + 1);
    s._onAgentEvent({ event: 'thinking', session_id: FORK_SID, text: 'old thought' });
    expect(stats.legacyLoads).toBe(base + 2);
    s._onAgentEvent({ event: 'thinking', session_id: FORK_SID, text: 'new thought' });
    s._onAgentEvent({ event: 'replay_end', session_id: FORK_SID });
    expect(stats.legacyLoads).toBe(base + 2);
    const thoughts = rows(FORK_SID, 'event').map((r: any) => JSON.parse(r.content).text);
    expect(thoughts).toEqual(['old thought', 'new thought']);
  });

  it('a stamped session never loads the legacy Sets for a replayed new tool row', () => {
    db.insert(schema.sessionMessages).values([
      // Seq-NULL rows that are not tool rows (hub-written) do not count.
      { sessionId: SID, role: 'user', content: 'go', tsMs: T0 },
      { sessionId: SID, role: 'tool_use', seq: 1, tsMs: T0 + 1,
        content: JSON.stringify({ type: 'tool_use', id: 't1', name: 'Bash', input: {} }) },
    ]).run();
    const s = mkStream({ lastSeenSeq: 1 });
    const base = stats.legacyLoads;
    const window = [
      ev(SID, 'tool_use', 2, T0 + 2, { id: 't2', name: 'Bash', input: {} }),
      ev(SID, 'tool_result', 3, T0 + 3, { tool_use_id: 't2', content: 'ok', is_error: false }),
    ];
    replay(s, SID, window);
    replay(s, SID, window);
    expect(stats.legacyLoads).toBe(base);
    expect(rows(SID, 'tool_use').map((r: any) => JSON.parse(r.content).id)).toEqual(['t1', 't2']);
    expect(rows(SID, 'tool_result')).toHaveLength(1);
  });

  it('two back-to-back replays of the same single tool_use write one row (memo per dispatch)', () => {
    const s = mkStream({ lastSeenSeq: 49 });
    const toolUse = ev(SID, 'tool_use', 50, T0 + 50, { id: 't50', name: 'Read', input: {} });
    replay(s, SID, [toolUse]);
    replay(s, SID, [toolUse]);
    replay(mkStream({ lastSeenSeq: 49 }), SID, [toolUse]);
    expect(rows(SID, 'tool_use')).toHaveLength(1);
    // Even delivered twice inside ONE window: the second dispatch asks the DB
    // again instead of reusing the first dispatch's "miss" (plan_update has
    // no legacy content fallback that could hide a stale memo).
    const plan = ev(SID, 'plan_update', 51, T0 + 51, { id: 'p51', steps: [{ step: 'a', status: 'pending' }] });
    replay(s, SID, [plan, plan]);
    expect(rows(SID, 'event').filter((r: any) => JSON.parse(r.content).type === 'plan_update')).toHaveLength(1);
  });

  it('an old row with the same seq but another ts does not gate a new event; a NULL ts_ms matches on seq', () => {
    // Old epoch: the agent recreated its log, seq restarted at 1.
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_use', seq: 5, tsMs: T0 - 3_600_000,
      content: JSON.stringify({ type: 'tool_use', id: 'old', name: 'Bash', input: {} }),
    }).run();
    const s = mkStream();
    replay(s, SID, [ev(SID, 'tool_use', 5, T0, { id: 'new', name: 'Bash', input: {} })]);
    expect(rows(SID, 'tool_use').map((r: any) => JSON.parse(r.content).id)).toEqual(['old', 'new']);
    // Replaying the new event again IS gated (same seq, same ts).
    replay(s, SID, [ev(SID, 'tool_use', 5, T0, { id: 'new', name: 'Bash', input: {} })]);
    expect(rows(SID, 'tool_use')).toHaveLength(2);
    // A row without ts_ms, and an event without ts, match on seq alone.
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_result', seq: 6, tsMs: null,
      content: JSON.stringify({ type: 'tool_result', tool_use_id: 'new', content: 'ok' }),
    }).run();
    replay(s, SID, [ev(SID, 'tool_result', 6, T0 + 6, { tool_use_id: 'new', content: 'ok', is_error: false })]);
    replay(s, SID, [ev(SID, 'tool_use', 5, null, { id: 'new', name: 'Bash', input: {} })]);
    expect(rows(SID, 'tool_result')).toHaveLength(1);
    expect(rows(SID, 'tool_use')).toHaveLength(2);
  });
});

describe('assistant buffers across replays', () => {
  const deltas = [
    ev(SID, 'assistant_text', 20, T0 + 20, { delta: 'Hello ' }),
    ev(SID, 'assistant_text', 21, T0 + 21, { delta: 'world' }),
  ];

  it('attach + resubscribe double replay of deltas keeps ONE copy of the text', () => {
    const s = mkStream({ lastSeenSeq: 19 });
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    replay(s, SID, deltas);
    replay(s, SID, deltas);
    s._onAgentEvent(ev(SID, 'stop', 22, T0 + 22, { subtype: 'end_turn' }));
    const assistants = rows(SID, 'assistant');
    expect(assistants.map((r: any) => r.content)).toEqual(['Hello world']);
    expect(assistants[0].seq).toBe(20);
    s._flushAssistantBroadcast();
    const text = emitted.mock.calls.map(([e]: any[]) => e)
      .filter((e: any) => e.type === 'assistant_text').map((e: any) => e.delta).join('');
    expect(text).toBe('Hello world');
  });

  it('a double replay whose boundary is inside the window keeps one row', () => {
    const s = mkStream({ lastSeenSeq: 19 });
    const window = [...deltas, ev(SID, 'tool_use', 22, T0 + 22, { id: 't22', name: 'Read', input: {} })];
    replay(s, SID, window);
    replay(s, SID, window);
    expect(rows(SID, 'assistant').map((r: any) => r.content)).toEqual(['Hello world']);
    expect(rows(SID, 'tool_use')).toHaveLength(1);
  });

  it('a replay-started accumulation flushed LIVE extends its SIGTERM partial instead of duplicating it', () => {
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'assistant', content: 'Hello ', seq: 20, tsMs: T0 + 20, assistantFinal: 0,
    }).run();
    const s = mkStream({ lastSeenSeq: 19 });
    replay(s, SID, deltas);
    // The boundary arrives after replay_end, live.
    s._onAgentEvent(ev(SID, 'tool_use', 22, T0 + 22, { id: 't22', name: 'Read', input: {} }));
    const assistants = rows(SID, 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ content: 'Hello world', seq: 20 });
    expect(rows(SID, 'tool_use')).toHaveLength(1);
  });

  it('a replay-opened buffer continued by LIVE deltas extends its SIGTERM partial', () => {
    // The usual hub restart: the cursor sits below the partial, the replay
    // re-delivers its first delta, the agent keeps streaming the same answer.
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'assistant', content: 'Hello ', seq: 20, tsMs: T0 + 20, assistantFinal: 0,
    }).run();
    const s = mkStream({ lastSeenSeq: 19 });
    replay(s, SID, [deltas[0]]);
    s._onAgentEvent(deltas[1]);
    expect(s.pendingAssistantFromReplay).toBe(true);
    s._onAgentEvent(ev(SID, 'tool_use', 22, T0 + 22, { id: 't22', name: 'Read', input: {} }));
    expect(rows(SID, 'assistant').map((r: any) => [r.content, r.seq])).toEqual([['Hello world', 20]]);
    expect(rows(SID, 'tool_use')).toHaveLength(1);
  });

  it('a failed extend of a SIGTERM partial restores the buffer and holds the cursor back', () => {
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'assistant', content: 'Hello ', seq: 20, tsMs: T0 + 20, assistantFinal: 0,
    }).run();
    const s = mkStream({ lastSeenSeq: 19 });
    replay(s, SID, deltas);
    failNextMessageUpdates = 1;
    // Live boundary: the identity extend fails → the boundary stops (16.3).
    s._onAgentEvent(ev(SID, 'tool_use', 22, T0 + 22, { id: 't22', name: 'Read', input: {} }));
    expect(failNextMessageUpdates).toBe(0);
    expect(rows(SID, 'assistant').map((r: any) => r.content)).toEqual(['Hello ']);
    expect(rows(SID, 'tool_use')).toHaveLength(0);
    expect(s.currentAssistant).toBe('Hello world');
    expect(s.pendingAssistantFromReplay).toBe(true);
    expect(s._durableCursor()).toBe(19);
    // The next boundary retries through identity (the replay origin came back
    // with the buffer): it extends the partial, never inserts a second row.
    s._onAgentEvent(ev(SID, 'stop', 23, T0 + 23, { subtype: 'end_turn' }));
    const assistants = rows(SID, 'assistant');
    expect(assistants.map((r: any) => [r.content, r.seq])).toEqual([['Hello world', 20]]);
  });

  it('a gated replayed boundary keeps a buffer whose seq only matches an old-epoch row', () => {
    // The flush row of these deltas was never written (failed pre-crash); the
    // tool_use after them was. Seq 20 of the OLD epoch is another answer.
    db.insert(schema.sessionMessages).values([
      { sessionId: SID, role: 'assistant', content: 'Old answer', seq: 20, tsMs: T0 - 3_600_000, assistantFinal: 1 },
      { sessionId: SID, role: 'tool_use', seq: 22, tsMs: T0 + 22,
        content: JSON.stringify({ type: 'tool_use', id: 't22', name: 'Read', input: {} }) },
    ]).run();
    const s = mkStream({ lastSeenSeq: 19 });
    replay(s, SID, [...deltas, ev(SID, 'tool_use', 22, T0 + 22, { id: 't22', name: 'Read', input: {} })]);
    expect(s.currentAssistant).toBe('Hello world');
    s._onAgentEvent(ev(SID, 'stop', 23, T0 + 23, { subtype: 'end_turn' }));
    expect(rows(SID, 'assistant').map((r: any) => [r.content, r.seq, r.tsMs])).toEqual([
      ['Old answer', 20, T0 - 3_600_000],
      ['Hello world', 20, T0 + 20],
    ]);
    expect(rows(SID, 'tool_use')).toHaveLength(1);
  });

  it('an in-window flush in an unstamped session is deduped by content, not by identity', () => {
    // Fork copy: no stamped row, so the flush's seq names nothing; the legacy
    // content check is the only signal and recognises the copied answer.
    db.insert(schema.sessionMessages).values({
      sessionId: FORK_SID, role: 'assistant', content: 'Done.', tsMs: T0, assistantFinal: 1,
    }).run();
    const s = mkStream({ id: FORK_SID, lastSeenSeq: 4 });
    replay(s, FORK_SID, [
      ev(FORK_SID, 'assistant_text', 5, T0 + 5, { delta: 'Done.' }),
      ev(FORK_SID, 'stop', 6, T0 + 6, { subtype: 'end_turn' }),
    ]);
    expect(rows(FORK_SID, 'assistant').map((r: any) => [r.content, r.seq])).toEqual([['Done.', null]]);
  });

  it('a replay-started accumulation without a persisted row is inserted once when flushed live', () => {
    const s = mkStream({ lastSeenSeq: 19 });
    replay(s, SID, deltas);
    s._onAgentEvent(ev(SID, 'stop', 22, T0 + 22, { subtype: 'end_turn' }));
    expect(rows(SID, 'assistant').map((r: any) => r.content)).toEqual(['Hello world']);
  });

  it('a flush row matches on its first delta ts: an old-epoch row with the same seq gates nothing', () => {
    // The agent recreated its log: seq 20 of the old epoch is another answer.
    db.insert(schema.sessionMessages).values([
      { sessionId: SID, role: 'assistant', content: 'Old answer', seq: 20, tsMs: T0 - 3_600_000, assistantFinal: 1 },
      { sessionId: SID, role: 'assistant', content: 'Hello ', seq: 30, tsMs: T0 - 3_500_000, assistantFinal: 1 },
    ]).run();
    const s = mkStream({ lastSeenSeq: 19 });
    replay(s, SID, [...deltas, ev(SID, 'tool_use', 22, T0 + 22, { id: 't22', name: 'Read', input: {} })]);
    // Neither swallowed (not a prefix) nor written into the old row (prefix).
    replay(s, SID, [
      ev(SID, 'assistant_text', 30, T0 + 30, { delta: 'Hello ' }),
      ev(SID, 'assistant_text', 31, T0 + 31, { delta: 'again' }),
      ev(SID, 'tool_use', 32, T0 + 32, { id: 't32', name: 'Read', input: {} }),
    ]);
    expect(rows(SID, 'assistant').map((r: any) => [r.content, r.seq, r.tsMs])).toEqual([
      ['Old answer', 20, T0 - 3_600_000],
      ['Hello ', 30, T0 - 3_500_000],
      ['Hello world', 20, T0 + 20],
      ['Hello again', 30, T0 + 30],
    ]);
  });

  // A session without any stamped row (a fork copy, an import) has no identity
  // to extend: a replay-started buffer flushed LIVE is a plain insert. The
  // content heuristics are for flushes INSIDE a window only.
  for (const [label, text] of [
    ['an identical copied answer', 'Done.'],
    ['a copied answer that is a prefix of it', 'Done. Also fixed X.'],
  ] as const) {
    it(`a replay-started buffer flushed LIVE in an unstamped session is inserted beside ${label}`, () => {
      db.insert(schema.sessionMessages).values({
        sessionId: FORK_SID, role: 'assistant', content: 'Done.', tsMs: T0, assistantFinal: 1,
      }).run();
      const s = mkStream({ id: FORK_SID, lastSeenSeq: 4 });
      replay(s, FORK_SID, [ev(FORK_SID, 'assistant_text', 5, T0 + 5, { delta: text })]);
      const loads = stats.legacyLoads;
      s._onAgentEvent(ev(FORK_SID, 'stop', 6, T0 + 6, { subtype: 'end_turn' }));
      expect(rows(FORK_SID, 'assistant').map((r: any) => [r.content, r.seq])).toEqual([['Done.', null], [text, 5]]);
      expect(stats.legacyLoads).toBe(loads);
    });
  }

  // A mid-turn model switch the hub already applied (effectiveModel hydrated
  // from the DB) replayed from below it: the cursor's 2 s debounce lets a
  // restart land there. The live run flushed at the switch.
  const assistantsWithModel = () => rows(SID, 'assistant').map((r: any) => [r.seq, r.content, r.model]);
  const ab = [
    ev(SID, 'assistant_text', 100, T0 + 100, { delta: 'A' }),
    ev(SID, 'assistant_text', 101, T0 + 101, { delta: 'B' }),
    ev(SID, 'effective_model', 102, T0 + 102, { model: 'M2' }),
  ];

  it('a replayed, already applied model switch keeps the old text apart and its label', () => {
    db.insert(schema.sessionMessages).values([
      { sessionId: SID, role: 'assistant', content: 'AB', model: 'M1', seq: 100, tsMs: T0 + 100, assistantFinal: 0 },
      // SIGTERM partial of the post-switch accumulation.
      { sessionId: SID, role: 'assistant', content: 'CD', model: 'M2', seq: 103, tsMs: T0 + 103, assistantFinal: 0 },
    ]).run();
    const s = mkStream({ lastSeenSeq: 99, effectiveModel: 'M2' });
    replay(s, SID, [
      ...ab,
      ev(SID, 'assistant_text', 103, T0 + 103, { delta: 'C' }),
      ev(SID, 'assistant_text', 104, T0 + 104, { delta: 'D' }),
    ]);
    s._onAgentEvent(ev(SID, 'assistant_text', 105, T0 + 105, { delta: 'E' }));
    s._onAgentEvent(ev(SID, 'tool_use', 106, T0 + 106, { id: 't106', name: 'Read', input: {} }));
    expect(assistantsWithModel()).toEqual([[100, 'AB', 'M1'], [103, 'CDE', 'M2']]);
  });

  it('a replay ending right after an applied switch: the live text opens a new row', () => {
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'assistant', content: 'AB', model: 'M1', seq: 100, tsMs: T0 + 100, assistantFinal: 0,
    }).run();
    const s = mkStream({ lastSeenSeq: 99, effectiveModel: 'M2' });
    replay(s, SID, ab);
    s._onAgentEvent(ev(SID, 'assistant_text', 103, T0 + 103, { delta: 'C' }));
    s._onAgentEvent(ev(SID, 'tool_use', 104, T0 + 104, { id: 't104', name: 'Read', input: {} }));
    expect(assistantsWithModel()).toEqual([[100, 'AB', 'M1'], [103, 'C', 'M2']]);
  });

  it('an unchanged model replayed where the live run did NOT flush keeps the buffer whole', () => {
    // The agent re-announces its model after a restart (its own state starts
    // empty) while the hub already holds it: no flush live, so the row runs on.
    db.insert(schema.sessionMessages).values([
      { sessionId: SID, role: 'assistant', content: 'ABCD', model: 'M2', seq: 100, tsMs: T0 + 100, assistantFinal: 0 },
      { sessionId: SID, role: 'tool_use', seq: 105, tsMs: T0 + 105,
        content: JSON.stringify({ type: 'tool_use', id: 't105', name: 'Read', input: {} }) },
    ]).run();
    const s = mkStream({ lastSeenSeq: 99, effectiveModel: 'M2' });
    replay(s, SID, [
      ...ab,
      ev(SID, 'assistant_text', 103, T0 + 103, { delta: 'C' }),
      ev(SID, 'assistant_text', 104, T0 + 104, { delta: 'D' }),
      ev(SID, 'tool_use', 105, T0 + 105, { id: 't105', name: 'Read', input: {} }),
    ]);
    s._onAgentEvent(ev(SID, 'stop', 106, T0 + 106, { subtype: 'end_turn' }));
    expect(assistantsWithModel()).toEqual([[100, 'ABCD', 'M2']]);
    expect(rows(SID, 'tool_use')).toHaveLength(1);
  });

  it('an unchanged model arriving LIVE does not split a replay-opened SIGTERM partial', () => {
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'assistant', content: 'AB', model: 'M2', seq: 100, tsMs: T0 + 100, assistantFinal: 0,
    }).run();
    const s = mkStream({ lastSeenSeq: 99, effectiveModel: 'M2' });
    replay(s, SID, ab.slice(0, 2));
    s._onAgentEvent(ab[2]);
    s._onAgentEvent(ev(SID, 'assistant_text', 103, T0 + 103, { delta: 'C' }));
    s._onAgentEvent(ev(SID, 'stop', 104, T0 + 104, { subtype: 'end_turn' }));
    expect(assistantsWithModel()).toEqual([[100, 'ABC', 'M2']]);
  });

  it('keeps live deltas whose seq is below an open buffer (a recreated log restarts at 1)', () => {
    const s = mkStream();
    s._onAgentEvent(ev(SID, 'assistant_text', 900, T0, { delta: 'old epoch, ' }));
    s._onAgentEvent(ev(SID, 'assistant_text', 1, T0 + 1, { delta: 'new epoch' }));
    s._onAgentEvent(ev(SID, 'stop', 2, T0 + 2, { subtype: 'end_turn' }));
    expect(rows(SID, 'assistant').map((r: any) => r.content)).toEqual(['old epoch, new epoch']);
  });

  it('a failed flush restores the whole buffer identity, uuid included', () => {
    const s = mkStream();
    s._onAgentEvent(ev(SID, 'assistant_text', 30, T0 + 30, { delta: 'first ', uuid: 'cli-uuid-1' }));
    s._onAgentEvent(ev(SID, 'assistant_text', 31, T0 + 31, { delta: 'part' }));
    failNextInserts = 1;
    s._onAgentEvent(ev(SID, 'tool_use', 32, T0 + 32, { id: 't32', name: 'Read', input: {} }));
    expect(rows(SID, 'assistant')).toHaveLength(0);
    expect(s.pendingAssistantUuid).toBe('cli-uuid-1');
    expect(s.pendingAssistantLastSeq).toBe(31);
    s._onAgentEvent(ev(SID, 'stop', 33, T0 + 33, { subtype: 'end_turn' }));
    const [row] = rows(SID, 'assistant');
    expect(row).toMatchObject({ content: 'first part', seq: 30, tsMs: T0 + 30, cliUuid: 'cli-uuid-1' });
  });
});

describe('replay windows and blocking errors', () => {
  it('a replayed blocking error whose row exists is not recorded twice', () => {
    const fatal = ev(SID, 'error', 40, T0 + 40, { msg: 'client transport died', fatal: true });
    mkStream()._onAgentEvent(fatal);
    expect(rows(SID, 'error')).toHaveLength(1);
    replay(mkStream(), SID, [fatal]);
    expect(rows(SID, 'error')).toHaveLength(1);
  });

  // The fatal error's row fails, the stop's fallback lands: it carries the
  // ERROR's seq/ts, so the restart replay of the error finds it (one card).
  it.each([
    ['codex', { subtype: 'error' }],
    ['claude', { subtype: 'success', is_error: true }],
  ])('%s: a fatal error whose row failed is recorded once, under its own seq, through the stop and a replay', (kind, stopFields) => {
    const fatal = ev(SID, 'error', 30, T0 + 30, { msg: 'client transport died', fatal: true });
    const stop = ev(SID, 'stop', 31, T0 + 31, stopFields);
    const s = mkStream({ kind });
    failNextInserts = 2;                                             // the sdk_error log line, then the error row
    s._onAgentEvent(fatal);
    expect(rows(SID, 'error')).toHaveLength(0);
    s._onAgentEvent(stop);
    expect(rows(SID, 'error').map((r: any) => [r.seq, r.tsMs])).toEqual([[30, T0 + 30]]);
    expect(s._durableCursor()).toBe(29);
    replay(mkStream({ kind, lastSeenSeq: 29 }), SID, [fatal, stop]);
    expect(rows(SID, 'error')).toHaveLength(1);
  });

  it('replay_end is idempotent outside a window', () => {
    const s = mkStream();
    s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
    expect(s.isReplaying).toBe(false);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 1 });
    expect(s.isReplaying).toBe(true);
    s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(s.isReplaying).toBe(false);
  });

  it('a replay_end outside a window only clears: no codex background check is scheduled', () => {
    const s = mkStream({ kind: 'codex' });
    const check = vi.spyOn(s, '_scheduleCodexBgCheck').mockImplementation(() => {});
    s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
    expect(check).not.toHaveBeenCalled();
    replay(s, SID, []);
    expect(check).toHaveBeenCalledTimes(1);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('names the dispatched event in the loop-lag ring', async () => {
    const lag = await import('@/lib/server/perf/loopLag');
    let clock = 0;
    lag.stopLoopLagMonitor();
    lag.startLoopLagMonitor({
      now: () => (clock += 300),
      warn: () => {},
      histogram: { count: 0, max: 0, percentile: () => 0, reset: () => {}, enable: () => {}, disable: () => {} },
    });
    try {
      mkStream()._onAgentEvent(ev(SID, 'turn_error', 41, T0 + 41, { kind: 'overloaded' }));
      expect(lag.loopLagSnapshot().slow.map((x) => x.label)).toContain('agent:turn_error');
    } finally {
      lag.stopLoopLagMonitor();
    }
  });
});

describe('codex background reconcile', () => {
  it('skips the broadcast and keeps the task when the receipt cannot be persisted', async () => {
    db.update(schema.agentSessions).set({ kind: 'codex', nativeSessionId: 'thread-1' })
      .where(eq(schema.agentSessions.id, SID)).run();
    const s = mkStream({ kind: 'codex' });
    s.nativeSessionId = 'thread-1';
    s.attach();
    const now = Math.floor(Date.now() / 1000);
    s.bgRunning = new Map([['agent-1', now]]);
    s.codexBgChecks.set('agent-1', { revision: 0, since: now - 10 });
    bgMocks.read = async () => [{ taskId: 'agent-1', status: 'completed', at: now }];
    const broadcast = vi.spyOn(s, '_broadcast');
    failNextInserts = 1;
    try {
      await s._reconcileCodexBgTasks();
      expect(broadcast.mock.calls.some(([e]: any[]) => e.type === 'bg_task')).toBe(false);
      expect(s.bgRunning.has('agent-1')).toBe(true);
      expect(s.codexBgChecks.has('agent-1')).toBe(true);
      // The next check succeeds and publishes the receipt.
      await s._reconcileCodexBgTasks();
      expect(broadcast.mock.calls.some(([e]: any[]) => e.type === 'bg_task' && e.taskId === 'agent-1')).toBe(true);
      expect(s.bgRunning.has('agent-1')).toBe(false);
    } finally {
      s.detach();
      bgMocks.read = async () => [];
      db.update(schema.agentSessions).set({ kind: 'claude', nativeSessionId: null })
        .where(eq(schema.agentSessions.id, SID)).run();
    }
  });
});

describe('resumeSession subscribes once', () => {
  it('does not resubscribe when attach() just subscribed, and does when it did not', async () => {
    const subscribe = vi.spyOn(pool.client, 'subscribe');
    const resubscribe = vi.spyOn(pool.client, 'resubscribe');
    await resumeSession(RESUME_SID);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(resubscribe).not.toHaveBeenCalled();
    // Already attached to this client: the explicit resubscribe is the one
    // that re-creates a missing agent-side subscription.
    await resumeSession(RESUME_SID);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(resubscribe).toHaveBeenCalledTimes(1);
    expect(resubscribe).toHaveBeenCalledWith(RESUME_SID);
    subscribe.mockRestore();
    resubscribe.mockRestore();
  });
});

describe('AgentClient synthetic replay_end', () => {
  function connectedClient(res: Record<string, unknown> = { ok: true, replay_count: 0 }) {
    const client = new AgentClient({ id: 'v-ident', name: 'test' }, new Promise<void>(() => {}));
    (client as any).call = async () => res;
    (client as any)._scheduleReconnect = () => {};
    client.status = 'connected';
    return client;
  }

  it('a drop mid-replay closes the window: the stream leaves replay mode', () => {
    const client = connectedClient();
    const s = mkStream();
    const seen: any[] = [];
    client.subscribe(SID, (e: any) => { seen.push(e); s._onAgentEvent(e); }, { afterSeq: 10 });
    (client as any)._dispatchMessage({ event: 'replay_begin', session_id: SID, count: 5 });
    (client as any)._dispatchMessage(ev(SID, 'tool_use', 11, T0 + 11, { id: 't11', name: 'Read', input: {} }));
    expect(s.isReplaying).toBe(true);
    (client as any)._handleExit(255);
    expect(s.isReplaying).toBe(false);
    expect(seen.at(-1)).toEqual({ event: 'replay_end', session_id: SID, synthetic: true });
    // Nothing left open: a second drop sends nothing more.
    (client as any)._handleExit(255);
    expect(seen.filter((e) => e.event === 'replay_end')).toHaveLength(1);
  });

  it('closing the client (pool drop) closes open windows too', async () => {
    // A non-empty subscribe answer: only close() can end this window.
    const client = connectedClient({ ok: true, replay_count: 3 });
    const seen: any[] = [];
    client.subscribe(SID, (e: any) => seen.push(e));
    await Promise.resolve(); await Promise.resolve();
    (client as any)._dispatchMessage({ event: 'replay_begin', session_id: SID, count: 5 });
    await Promise.resolve(); await Promise.resolve();
    expect(seen.some((e) => e.event === 'replay_end')).toBe(false);
    const closing = client.close();
    expect(seen.at(-1)).toEqual({ event: 'replay_end', session_id: SID, synthetic: true });
    await closing;
    expect(seen.filter((e) => e.event === 'replay_end')).toHaveLength(1);
  });

  it('an empty resubscribe answering an open window closes it', async () => {
    const client = connectedClient({ ok: true, replay_count: 0, current_seq: 12 });
    const seen: any[] = [];
    client.subscribe(SID, (e: any) => seen.push(e), { afterSeq: 10 });
    await Promise.resolve(); await Promise.resolve();
    expect(seen).toEqual([]); // no window open: nothing synthesized
    (client as any)._dispatchMessage({ event: 'replay_begin', session_id: SID, count: 2 });
    (client as any)._fireSubscribe(SID);
    await Promise.resolve(); await Promise.resolve();
    expect(seen.at(-1)).toEqual({ event: 'replay_end', session_id: SID, synthetic: true });
    expect(seen.filter((e) => e.event === 'replay_end')).toHaveLength(1);
  });

  it('an empty answer leaves alone a window opened AFTER its request was sent', async () => {
    const client = connectedClient({ ok: true, replay_count: 0 });
    const seen: any[] = [];
    client.subscribe(SID, (e: any) => seen.push(e));
    // The answer settles in a microtask, after a later replay began.
    (client as any)._dispatchMessage({ event: 'replay_begin', session_id: SID, count: 2 });
    await Promise.resolve(); await Promise.resolve();
    expect(seen.some((e) => e.event === 'replay_end')).toBe(false);
    expect((client as any).replayOpen.has(SID)).toBe(true);
  });

  it('an empty answer and the NEXT replay_begin in one stdout chunk: the live window stays open', async () => {
    // Real wire path: requests go to a fake child, answers and events come
    // back through _onStdout, a chunk at a time.
    const client = new AgentClient({ id: 'v-ident', name: 'test' }, new Promise<void>(() => {}));
    const written: any[] = [];
    (client as any).child = {
      stdin: { write: (line: string) => { written.push(JSON.parse(line)); return true; }, end: () => {} },
      kill: () => {},
    };
    (client as any)._scheduleReconnect = () => {};
    client.status = 'connected';
    const feed = (...msgs: any[]) =>
      (client as any)._onStdout(Buffer.from(msgs.map((m) => JSON.stringify(m) + '\n').join('')));
    const tick = () => new Promise<void>((r) => setImmediate(r));

    const toolUse = (seq: number) => ev(SID, 'tool_use', seq, T0 + seq, { id: `t${seq}`, name: 'Read', input: {} });
    db.insert(schema.sessionMessages).values([11, 12].map((seq) => ({
      sessionId: SID, role: 'tool_use', seq, tsMs: T0 + seq,
      content: JSON.stringify({ type: 'tool_use', id: `t${seq}`, name: 'Read', input: {} }),
    }))).run();
    const s = mkStream({ lastSeenSeq: 12 });
    const seen: any[] = [];
    client.subscribe(SID, (e: any) => { seen.push(e); s._onAgentEvent(e); }, { afterSeq: 12 });
    client.resubscribe(SID, { afterSeq: 10 });
    const [first, second] = written.filter((w) => w.method === 'subscribe');
    expect(second.params.after_seq).toBe(10);

    feed({ event: 'status', session_id: SID, status: 'active' },
      { id: first.id, result: { ok: true, replay_count: 0, current_seq: 12 } },
      { event: 'replay_begin', session_id: SID, count: 2 },
      toolUse(11));
    await tick();
    expect(s.isReplaying).toBe(true);
    feed(toolUse(12),
      { event: 'replay_end', session_id: SID },
      { event: 'status', session_id: SID, status: 'active' },
      { id: second.id, result: { ok: true, replay_count: 2, current_seq: 12 } });
    await tick();
    expect(s.isReplaying).toBe(false);
    expect(seen.filter((e) => e.event === 'replay_end')).toEqual([{ event: 'replay_end', session_id: SID }]);
    expect(rows(SID, 'tool_use').map((r: any) => [r.seq, JSON.parse(r.content).id])).toEqual([[11, 't11'], [12, 't12']]);
    await client.close();
  });

  it('a normal replay_end closes the window: no synthetic one follows', async () => {
    const client = connectedClient({ ok: true, replay_count: 0 });
    const seen: any[] = [];
    client.subscribe(SID, (e: any) => seen.push(e));
    (client as any)._dispatchMessage({ event: 'replay_begin', session_id: SID, count: 1 });
    (client as any)._dispatchMessage({ event: 'replay_end', session_id: SID });
    (client as any)._fireSubscribe(SID);
    await Promise.resolve(); await Promise.resolve();
    (client as any)._handleExit(255);
    expect(seen.filter((e) => e.event === 'replay_end')).toEqual([{ event: 'replay_end', session_id: SID }]);
  });
});
