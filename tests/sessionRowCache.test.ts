import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, like, or } from 'drizzle-orm';

// Incremental row caches (C03): the folds behind token totals, recorded turn
// usage and the background-task registry read only rows newer than their
// cached state, validate it on every call, warm cold sessions in slices and
// evict idle entries. Reference = the pre-C03 full scans, verbatim.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({})) }));
vi.mock('@/lib/server/hub/sessionRpc', () => ({ callSessionRpc: vi.fn(async () => ({})) }));
const agentCall = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => ({})));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ call: agentCall, setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {} }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));
// The VPS route re-arms hooks on PATCH only; DELETE never reaches it.
vi.mock('@/lib/server/agent/autoConnect', () => ({ armAgentClientHooks: () => {} }));

type Mod = typeof import('@/lib/server/agent/sessionRowCache');
let db: any;
let schema: any;
let rawSqlite: () => import('better-sqlite3').Database;
let rowCache: Mod;
let sessionTokenUsage: typeof import('@/lib/server/agent/sessionTokenUsage').sessionTokenUsage;
let recordedSessionUsage: typeof import('@/lib/server/agent/sessionUsage').recordedSessionUsage;
let bg: typeof import('@/lib/server/hub/bgTaskState');
let bgTasks: typeof import('@/app/bgTasks');

const VPS = 'rowcache-vps';
let sessionCounter = 0;

function newSession(kind = 'codex', status = 'active'): string {
  const id = (++sessionCounter).toString(16).padStart(32, '0');
  db.insert(schema.agentSessions).values({ id, vpsId: VPS, cwd: '/tmp', name: 'rc', status, kind }).run();
  return id;
}

function insert(sessionId: string, role: string, content: unknown, tsMs?: number): number {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Number(db.insert(schema.sessionMessages)
    .values({ sessionId, role, content: text, ...(tsMs != null ? { tsMs } : {}) }).run().lastInsertRowid);
}

// ── References: the full scans C03 replaced, verbatim (ORDER BY id) ──────────
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

function refTokens(sessionId: string) {
  const m = schema.sessionMessages;
  const rows = db.select({ id: m.id, content: m.content }).from(m).where(and(
    eq(m.sessionId, sessionId), eq(m.role, 'event'),
    or(like(m.content, '%"type":"endpoint_usage"%'), like(m.content, '%"type":"turn_usage"%')),
  )).orderBy(asc(m.id)).all();
  const result: any = {
    revision: 0, inputTokens: null, outputTokens: null, totalTokens: null,
    requests: 0, legacyTurns: 0, missingInput: 0, missingOutput: 0, missingTotal: 0, partial: false,
  };
  const requests = new Set<string>();
  for (const row of rows) {
    let e;
    try { e = JSON.parse(row.content); } catch { continue; }
    if (!e || !['endpoint_usage', 'turn_usage'].includes(e.type)) continue;
    result.revision = row.id;
    let input: number | null, output: number | null, total: number | null;
    if (e.type === 'endpoint_usage') {
      if (typeof e.requestId !== 'string' || requests.has(e.requestId)) continue;
      requests.add(e.requestId);
      result.requests++;
      input = count(e.inputTokens); output = count(e.outputTokens); total = count(e.totalTokens);
      if (e.partial) result.partial = true;
    } else {
      if (e.endpointAccounted) continue;
      result.legacyTurns++;
      result.partial = true;
      const u = e.tree;
      input = count(u?.input_tokens ?? e.inputTokens);
      output = count(u?.output_tokens ?? e.outputTokens);
      if (e.provider === 'claude' && input !== null) {
        input += count(u?.cache_read_tokens ?? e.cacheReadTokens) ?? 0;
        input += count(u?.cache_write_tokens ?? e.cacheWriteTokens) ?? 0;
      }
      if (input === 0 && output === 0) input = output = null;
      total = input !== null && output !== null ? input + output : null;
    }
    if (input === null) result.missingInput++; else result.inputTokens = (result.inputTokens ?? 0) + input;
    if (output === null) result.missingOutput++; else result.outputTokens = (result.outputTokens ?? 0) + output;
    if (total === null) result.missingTotal++; else result.totalTokens = (result.totalTokens ?? 0) + total;
  }
  return result;
}

function refRecorded(sessionId: string) {
  const m = schema.sessionMessages;
  const rows = db.select({ content: m.content }).from(m).where(and(
    eq(m.sessionId, sessionId), eq(m.role, 'event'), like(m.content, '%"type":"turn_usage"%'),
  )).orderBy(asc(m.id)).all();
  const total: any = {
    turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    duration_ms: 0, cost_usd: 0, models: [],
  };
  const models = new Set<string>();
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  for (const row of rows) {
    try {
      const event = JSON.parse(row.content);
      if (event?.type !== 'turn_usage') continue;
      const inclusive = event.tree && typeof event.tree === 'object' ? event.tree : null;
      total.turns += 1;
      total.input_tokens += num(inclusive?.input_tokens ?? event.inputTokens);
      total.output_tokens += num(inclusive?.output_tokens ?? event.outputTokens);
      total.cache_read_tokens += num(inclusive?.cache_read_tokens ?? event.cacheReadTokens);
      total.cache_write_tokens += num(inclusive?.cache_write_tokens ?? event.cacheWriteTokens);
      total.duration_ms += num(event.durationMs);
      total.cost_usd += num(inclusive?.cost_usd ?? event.costUsd);
      if (Array.isArray(inclusive?.models)) {
        for (const model of inclusive.models) if (typeof model === 'string') models.add(model);
      }
    } catch { /* corrupt */ }
  }
  if (!total.turns) return null;
  total.cost_usd = Math.round(total.cost_usd * 1_000_000) / 1_000_000;
  total.models = [...models].sort();
  return total;
}

function refBg(sessionId: string) {
  const m = schema.sessionMessages;
  return db.select({ content: m.content, createdAt: m.createdAt, seq: m.seq, tsMs: m.tsMs }).from(m).where(and(
    eq(m.sessionId, sessionId), eq(m.role, 'event'), like(m.content, '%"bg_task"%'),
  )).orderBy(asc(m.id)).all();
}

// The bg registry readers as they were before the fold kept the REDUCED
// registry (final step review, finding 6): each re-parsed the full rows.
type RefBgRow = { content: string; createdAt: number; seq: number | null; tsMs: number | null };
function refReduceBg(rows: RefBgRow[]) {
  const running = new Map<string, number>();
  const details = new Map<string, any>();
  for (const r of rows) {
    try {
      const ev = JSON.parse(r.content);
      if (ev?.type !== 'bg_task' || !ev.taskId) continue;
      bgTasks.applyBgTaskEvent(details, ev, r.createdAt);
      const task = details.get(ev.taskId)!;
      if (task.status !== 'running') running.delete(ev.taskId);
      else running.set(ev.taskId, task.startedAt);
    } catch { /* skipped */ }
  }
  return { running, details };
}
function refBgDetails(rows: RefBgRow[], nowS: number) {
  const { running, details } = refReduceBg(rows);
  bg.pruneStaleBgTasks(running, nowS);
  const active = new Map<string, any>();
  for (const [taskId, startedAt] of running) {
    const detail = details.get(taskId);
    active.set(taskId, {
      taskId, description: detail?.description ?? null, command: detail?.command ?? null,
      toolUseId: detail?.toolUseId ?? null, taskType: detail?.taskType ?? null, status: 'running', startedAt,
      endedAt: null, outputFile: detail?.outputFile ?? null, summary: null,
      workflowName: detail?.workflowName ?? null, usage: null, lastToolName: null, agents: null,
      ...(detail?.ownedBySubagent ? { ownedBySubagent: true } : {}),
    });
  }
  return bgTasks.bgTasksToArray(active);
}
function refBgBefore(rows: RefBgRow[], boundary: { seq: number | null; tsMs: number | null }) {
  const eligible = new Set<string>();
  for (const row of rows) {
    try {
      const ev = JSON.parse(row.content);
      if (ev?.type !== 'bg_task' || typeof ev.taskId !== 'string') continue;
      let before = false;
      if (boundary.tsMs != null && row.tsMs != null && row.tsMs !== boundary.tsMs) before = row.tsMs < boundary.tsMs;
      else if (boundary.seq != null && row.seq != null) before = row.seq < boundary.seq;
      else if (boundary.tsMs != null) before = row.createdAt < Math.floor(boundary.tsMs / 1000);
      if (before) eligible.add(ev.taskId);
      else eligible.delete(ev.taskId);
    } catch { /* skipped */ }
  }
  return eligible;
}
function refBgHidden(rows: RefBgRow[], alive: ReadonlySet<string>) {
  const owned = new Set<string>();
  const types = new Map<string, string>();
  for (const row of rows) {
    try {
      const ev = JSON.parse(row.content);
      if (ev?.type !== 'bg_task' || typeof ev.taskId !== 'string') continue;
      if (typeof ev.taskType === 'string') types.set(ev.taskId, ev.taskType);
      if (ev.ownedBySubagent === true) owned.add(ev.taskId);
    } catch { /* skipped */ }
  }
  const owners = new Set(['local_agent', 'local_workflow', 'in_process_teammate']);
  return [...alive].some((id) => owners.has(types.get(id) ?? '')) ? owned : new Set<string>();
}
const sorted = (set: Set<string>) => [...set].sort();
// Rows are created NOW (created_at default): a fixed date would prune them all.
const BG_NOW_S = Math.floor(Date.now() / 1000) + 60;

/** Every bg reader against its pre-change full-scan version. */
function checkBg(sessionId: string): void {
  const rows = refBg(sessionId) as RefBgRow[];
  const ref = refReduceBg(rows);
  expect([...bg.runningBgTasksFromDb(sessionId)]).toEqual([...ref.running]);
  expect([...bg.runningBgTasksIfWarm(sessionId)!]).toEqual([...ref.running]);
  for (const id of ['t0', 't1', 't2', 't3', 't4', 'early', 'rewound']) {
    expect(bg.bgTaskRunningInDb(sessionId, id)).toBe(ref.running.has(id));
  }
  expect(bg.runningBgTaskDetailsFromDb(sessionId, BG_NOW_S)).toEqual(refBgDetails(rows, BG_NOW_S));
  expect(bg.runningBgTaskDetailsIfWarm(sessionId, BG_NOW_S)).toEqual(refBgDetails(rows, BG_NOW_S));
  const ids = [...new Set([...ref.details.keys(), 'unknown'])];
  for (const boundary of [{ seq: null, tsMs: null }, { seq: 150, tsMs: null }, { seq: null, tsMs: 1_800_000_001_000 },
    { seq: 200, tsMs: 1_800_000_000_500 }]) {
    const want = refBgBefore(rows, boundary);
    expect(sorted(bg.bgTaskIdsBeforeEventFromDb(sessionId, boundary))).toEqual(sorted(want));
    expect(sorted(bg.bgTaskIdsBeforeEventFromDb(sessionId, boundary, ids)))
      .toEqual(sorted(want).filter((id) => ids.includes(id)));
  }
  for (const alive of [new Set<string>(), new Set(['t0']), new Set(['t1', 't3']), new Set(['t0', 't1', 't2', 't3', 't4'])]) {
    const want = refBgHidden(rows, alive);
    expect(sorted(bg.bgTasksHiddenFromStopHook(sessionId, alive))).toEqual(sorted(want));
    expect(sorted(bg.bgTasksHiddenFromStopHook(sessionId, alive, ids))).toEqual(sorted(want).filter((id) => ids.includes(id)));
  }
  const steps = refBgHidden(rows, new Set(ref.running.keys()));
  expect(bg.bgWorkCount(sessionId, ref.running)).toBe([...ref.running.keys()].filter((id) => !steps.has(id)).length);
}

// ── Random interleavings ────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function insertRandomRow(rnd: () => number, sessionId: string, i: number): void {
  const n = () => (rnd() < 0.15 ? null : Math.floor(rnd() * 500));
  const pick = rnd();
  // Mostly increasing ts, sometimes a "repaired" row dated in the past: ids
  // still increase, so the fold order (id) is unaffected.
  const ts = 1_800_000_000_000 + i * 10 - (rnd() < 0.05 ? 5_000 : 0);
  if (pick < 0.12) insert(sessionId, 'user', `prompt ${i}`, ts);
  else if (pick < 0.2) insert(sessionId, 'assistant', `answer ${i}`, ts);
  else if (pick < 0.27) insert(sessionId, 'tool_use', { id: `tu${i}`, name: 'Bash', input: {} }, ts);
  else if (pick < 0.37) {
    // Quoted JSON inside text is stored ESCAPED: it never matches the LIKE.
    insert(sessionId, 'event', { type: 'thinking', text: `see {"type":"endpoint_usage","requestId":"r1"} "bg_task" ${i}` }, ts);
  } else if (pick < 0.57) {
    insert(sessionId, 'event', {
      type: 'endpoint_usage',
      // A small pool ⇒ many duplicate request ids; sometimes not a string.
      requestId: rnd() < 0.08 ? 42 : `r${Math.floor(rnd() * 8)}`,
      inputTokens: n(), outputTokens: n(), totalTokens: n(), partial: rnd() < 0.2,
    }, ts);
  } else if (pick < 0.77) {
    const zero = rnd() < 0.1;
    insert(sessionId, 'event', {
      type: 'turn_usage', provider: rnd() < 0.5 ? 'claude' : 'codex',
      outputTokens: zero ? 0 : n(), inputTokens: zero ? 0 : n() ?? 0,
      cacheReadTokens: Math.floor(rnd() * 50), cacheWriteTokens: Math.floor(rnd() * 20),
      durationMs: Math.floor(rnd() * 3000), costUsd: rnd() < 0.3 ? null : rnd() / 100,
      ...(rnd() < 0.3 ? { endpointAccounted: true } : {}),
      ...(rnd() < 0.4 ? { tree: {
        input_tokens: n(), output_tokens: n(), cache_read_tokens: n(), cache_write_tokens: n(),
        cost_usd: rnd() / 50, models: [`model-${Math.floor(rnd() * 4)}`],
      } } : {}),
    }, ts);
  } else if (pick < 0.93) {
    const kinds = ['started', 'updated', 'finished'];
    const types = ['local_agent', 'local_bash', 'local_workflow', 'codex_subagent'];
    const rowId = insert(sessionId, 'event', {
      type: 'bg_task', kind: kinds[Math.floor(rnd() * 3)], taskId: `t${Math.floor(rnd() * 5)}`,
      ...(rnd() < 0.5 ? { status: rnd() < 0.5 ? 'running' : 'completed' } : {}),
      // Relaunches (a NEW launcher reopens a finished task), the native
      // terminal verdict, owner types and sub-agent-owned commands.
      ...(rnd() < 0.4 ? { toolUseId: `tu${Math.floor(rnd() * 3)}` } : {}),
      ...(rnd() < 0.2 ? { terminal: rnd() < 0.5 } : {}),
      ...(rnd() < 0.3 ? { taskType: types[Math.floor(rnd() * types.length)] } : {}),
      ...(rnd() < 0.2 ? { ownedBySubagent: true } : {}),
      ...(rnd() < 0.2 ? { description: `d${i}` } : {}),
    }, ts);
    // Sometimes the seq is stamped too (the before-event rule reads it).
    if (rnd() < 0.5) db.update(schema.sessionMessages).set({ seq: i }).where(eq(schema.sessionMessages.id, rowId)).run();
  } else {
    // Corrupt rows that DO match the LIKE: skipped by both folds.
    insert(sessionId, 'event', rnd() < 0.5 ? '{"type":"turn_usage", oops' : '{"type":"endpoint_usage" "bg_task" broken', ts);
  }
}

const KEYS = ['tokens', 'recorded', 'bg'] as const;

function check(key: typeof KEYS[number], sessionId: string): void {
  if (key === 'tokens') expect(sessionTokenUsage(sessionId)).toEqual(refTokens(sessionId));
  else if (key === 'recorded') expect(recordedSessionUsage(sessionId)).toEqual({ usage: refRecorded(sessionId), pending: false });
  else checkBg(sessionId);
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  rawSqlite = dbMod.rawSqlite;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS, name: 'rc', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  rowCache = await import('@/lib/server/agent/sessionRowCache');
  ({ sessionTokenUsage } = await import('@/lib/server/agent/sessionTokenUsage'));
  ({ recordedSessionUsage } = await import('@/lib/server/agent/sessionUsage'));
  bg = await import('@/lib/server/hub/bgTaskState');
  bgTasks = await import('@/app/bgTasks');
});

beforeEach(() => {
  rowCache.invalidateSessionRowCaches();
  agentCall.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('incremental fold == reference full scan', () => {
  it.each(KEYS)('%s: after every insert of a random interleaving (two sessions, dup request ids, endpointAccounted)', (key) => {
    const a = newSession();
    const b = newSession();
    const rnd = mulberry32(KEYS.indexOf(key) + 7);
    for (let i = 0; i < 260; i++) {
      insertRandomRow(rnd, rnd() < 0.75 ? a : b, i);
      check(key, a);
      if (i % 5 === 0) check(key, b);
    }
    check(key, b);
  });

  it('all three folds side by side, through a mid-sequence invalidation (cold re-fold)', () => {
    const a = newSession();
    const rnd = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      insertRandomRow(rnd, a, i);
      if (i === 120) rowCache.invalidateSessionRowCaches(a);
      for (const key of KEYS) check(key, a);
    }
  });

  it('after the first fold a call reads only the rows inserted since (no O(session) scan)', () => {
    const a = newSession();
    const rnd = mulberry32(3);
    for (let i = 0; i < 400; i++) insertRandomRow(rnd, a, i);
    sessionTokenUsage(a);
    const before = rowCache.sessionRowCacheStats().rowsScanned;
    sessionTokenUsage(a);
    expect(rowCache.sessionRowCacheStats().rowsScanned).toBe(before);
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'fresh', inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    insert(a, 'user', 'not matched');
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    expect(rowCache.sessionRowCacheStats().rowsScanned).toBe(before + 1);
  });

  it('returned states never alias the accumulator', () => {
    const a = newSession();
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'x', inputTokens: 10, outputTokens: 1, totalTokens: 11 });
    insert(a, 'event', { type: 'bg_task', kind: 'started', taskId: 't1' });
    insert(a, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: 5, outputTokens: 5, tree: { models: ['m'] } });
    const usage = sessionTokenUsage(a)!;
    usage.inputTokens = 999_999;
    bg.runningBgTasksFromDb(a).clear();
    bg.runningBgTasksIfWarm(a)!.set('ghost', 1);
    const details = bg.runningBgTaskDetailsFromDb(a);
    details[0].status = 'completed';
    details.length = 0;
    bg.bgTaskIdsBeforeEventFromDb(a, { seq: null, tsMs: Date.now() + 1_000 }).add('ghost');
    bg.bgTasksHiddenFromStopHook(a, new Set(['t1'])).add('ghost');
    const recorded = recordedSessionUsage(a).usage!;
    recorded.models.push('mutated');
    recorded.turns = 50;
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    expect([...bg.runningBgTasksFromDb(a).keys()]).toEqual(['t1']);
    checkBg(a);
    expect(recordedSessionUsage(a).usage).toEqual(refRecorded(a));
  });
});

// Final step review, finding 6 (G1): the fold kept the RAW rows and every
// reader re-parsed the session's whole bg history — ~16-30 ms per call on a
// sub-agent-heavy session (9 207 rows), inside event dispatch and GETs. The
// fold now keeps the reduced registry; warm reads are O(running).
describe('bg registry readers once warm (G1)', () => {
  it('10 000 lifecycle rows: every warm read stays far under 1 ms, and matches the full-scan readers', () => {
    const a = newSession('claude', 'background');
    const ins = rawSqlite().prepare(
      'INSERT INTO session_messages (session_id, role, content, seq, ts_ms) VALUES (?, ?, ?, ?, ?)');
    const pad = 'x'.repeat(600);
    let seq = 0;
    rawSqlite().transaction(() => {
      for (let t = 0; t < 4_300; t++) {
        const taskId = `task${t}`;
        const row = (ev: Record<string, unknown>) => {
          seq++;
          ins.run(a, 'event', JSON.stringify({ type: 'bg_task', taskId, description: pad, ...ev }), seq, 1_800_000_000_000 + seq);
        };
        row({ kind: 'started', taskType: t % 7 === 0 ? 'local_agent' : 'local_bash', toolUseId: `tu${t}`,
          ...(t % 5 === 0 ? { ownedBySubagent: true } : {}) });
        if (t % 6 === 0) row({ kind: 'updated', status: 'running' });
        if (t < 4_290) row({ kind: 'finished', status: 'completed' });     // 10 still running
      }
    })();
    expect(seq).toBeGreaterThanOrEqual(9_000);
    bg.runningBgTasksFromDb(a);                                        // the cold fold
    const alive = new Set(['task4290', 'task4291']);
    const candidates = [...bg.runningBgTasksFromDb(a).keys()];
    expect(candidates).toHaveLength(10);
    const readers: Array<[string, () => unknown]> = [
      ['runningBgTasksFromDb', () => bg.runningBgTasksFromDb(a)],
      ['bgTaskRunningInDb', () => bg.bgTaskRunningInDb(a, 'task4295')],
      ['runningBgTaskDetailsIfWarm', () => bg.runningBgTaskDetailsIfWarm(a)],
      ['runningBgTasksIfWarm', () => bg.runningBgTasksIfWarm(a)],
      ['bgTaskIdsBeforeEventFromDb', () => bg.bgTaskIdsBeforeEventFromDb(a, { seq: null, tsMs: 1_900_000_000_000 }, candidates)],
      ['bgTasksHiddenFromStopHook', () => bg.bgTasksHiddenFromStopHook(a, alive, candidates)],
      ['bgWorkCount', () => bg.bgWorkCount(a, bg.runningBgTasksFromDb(a))],
    ];
    for (const [name, read] of readers) {
      const times: number[] = [];
      for (let i = 0; i < 25; i++) {
        const t0 = performance.now();
        read();
        times.push(performance.now() - t0);
      }
      times.sort((x, y) => x - y);
      expect({ name, median: times[12] < 1 }).toEqual({ name, median: true });
    }
    checkBg(a);
  }, 60_000);
});

describe('validation', () => {
  it('a wipe and reinsert under the same SID resets every fold', () => {
    const a = newSession();
    const rnd = mulberry32(11);
    for (let i = 0; i < 80; i++) insertRandomRow(rnd, a, i);
    for (const key of KEYS) check(key, a);
    // The harness pattern of many test files: wipe the rows, reuse the SID.
    db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, a)).run();
    for (let i = 0; i < 30; i++) insertRandomRow(rnd, a, i);
    for (const key of KEYS) check(key, a);
    // Wiped with nothing after: max(id) fell below the cached position.
    db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, a)).run();
    for (const key of KEYS) check(key, a);
    expect(sessionTokenUsage(a)).toMatchObject({ revision: 0, requests: 0, totalTokens: null });
  });

  it('a suffix delete below the last hit is detected by max(id)', () => {
    const a = newSession();
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'keep', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const tail = [insert(a, 'user', 'u1'), insert(a, 'user', 'u2')];
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.id, tail[1])).run();
    const dropped = rowCache.sessionRowCacheStats().dropped;
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    expect(rowCache.sessionRowCacheStats().dropped).toBe(dropped + 1);
  });

  it('rollback keeps the token totals and the bg registry loses the rewound rows', async () => {
    const a = newSession('codex', 'active');
    insert(a, 'event', { type: 'bg_task', kind: 'started', taskId: 'early' }, 1_000);
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'r1', inputTokens: 100, outputTokens: 20, totalTokens: 120 }, 1_100);
    const user = insert(a, 'user', 'rewind me', 2_000);
    insert(a, 'event', { type: 'bg_task', kind: 'started', taskId: 'rewound' }, 3_000);
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'r2', inputTokens: 50, outputTokens: 5, totalTokens: 55 }, 3_100);
    // A late row dated BEFORE the rewind point (hub-originated, repaired): it
    // survives and stays the fold's last hit, so only the route's explicit
    // invalidation can drop the rewound bg row from the cache.
    insert(a, 'event', { type: 'bg_task', kind: 'finished', taskId: 'early' }, 1_500);
    const tokensBefore = sessionTokenUsage(a);
    expect(bg.bgRegistrySnapshotFromDb(a)!.details.map((t) => [t.taskId, t.status]))
      .toEqual([['early', 'completed'], ['rewound', 'running']]);
    checkBg(a);

    const { POST } = await import('@/app/api/sessions/[id]/rollback/route');
    const res = await POST(new Request(`http://localhost/api/sessions/${a}/rollback`, {
      method: 'POST', body: JSON.stringify({ messageId: `m${user}` }),
    }), { params: Promise.resolve({ id: a }) });
    expect(res.status).toBe(200);
    expect(agentCall).toHaveBeenCalledWith('rollback_session', expect.objectContaining({ session_id: a }));

    expect(sessionTokenUsage(a)).toEqual(tokensBefore);
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    expect(bg.bgRegistrySnapshotFromDb(a)!.details.map((t) => [t.taskId, t.status])).toEqual([['early', 'completed']]);
    expect(bg.runningBgTasksFromDb(a).size).toBe(0);
    checkBg(a);
  });
});

describe('deletion paths free the folds (I11)', () => {
  it('deleting a VPS frees the folds of every session its cascade takes', async () => {
    const vpsId = 'rowcache-vps-gone';
    db.insert(schema.vps).values({ id: vpsId, name: 'gone', ip: '127.0.0.2', sshUser: 'root' }).run();
    const goneSession = (): string => {
      const id = (++sessionCounter).toString(16).padStart(32, '0');
      db.insert(schema.agentSessions).values({ id, vpsId, cwd: '/tmp', name: 'gone', status: 'sleeping', kind: 'codex' }).run();
      return id;
    };
    const gone = [goneSession(), goneSession()];
    const kept = newSession();
    for (const sid of [...gone, kept]) {
      insert(sid, 'event', { type: 'endpoint_usage', requestId: 'x', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
      insert(sid, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: 3, outputTokens: 1 });
      insert(sid, 'event', { type: 'bg_task', kind: 'started', taskId: 't' });
      for (const key of KEYS) check(key, sid);
    }
    expect(rowCache.sessionRowCacheStats().entries).toBe(9);

    const { DELETE } = await import('@/app/api/vps/[id]/route');
    const res = await DELETE(new Request(`http://localhost/api/vps/${vpsId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: vpsId }) });
    expect(res.status).toBe(200);
    const m = schema.sessionMessages;
    for (const sid of gone) expect(db.select().from(m).where(eq(m.sessionId, sid)).all()).toEqual([]);
    // Only the surviving session's three folds stay in memory.
    expect(rowCache.sessionRowCacheStats().entries).toBe(3);
    for (const key of KEYS) check(key, kept);
    expect(rowCache.sessionRowCacheStats().entries).toBe(3);
  });
});

describe('cold folds are sliced', () => {
  function sliceOpts(onComplete?: (s: { ids: number[] }) => void) {
    let steps = 0;
    return {
      steps: () => steps,
      opts: {
        likes: ['%"type":"turn_usage"%'],
        init: () => ({ ids: [] as number[] }),
        clone: (s: { ids: number[] }) => ({ ids: [...s.ids] }),
        step: (s: { ids: number[] }, row: { id: number }) => { steps++; s.ids.push(row.id); return true; },
        sliceRows: 7,
        onComplete,
      },
    };
  }

  it('answers complete:false, finishes in ONE background chain, then onComplete equals the full scan', async () => {
    const a = newSession();
    const all: number[] = [];
    const sessionRows: number[] = [];
    for (let i = 0; i < 50; i++) {
      const id = i % 3 === 0
        ? insert(a, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: i, outputTokens: 1 })
        : insert(a, 'user', `u${i}`);
      sessionRows.push(id);
      if (i % 3 === 0) all.push(id);
    }
    const completions: Array<{ ids: number[] }> = [];
    let resolve!: (s: { ids: number[] }) => void;
    const done = new Promise<{ ids: number[] }>((r) => { resolve = r; });
    const { opts, steps } = sliceOpts((s) => { completions.push(s); resolve(s); });

    const slicesBefore = rowCache.sessionRowCacheStats().slices;
    const first = rowCache.foldSessionEventRows('recorded', a, opts);
    expect(first.complete).toBe(false);
    // ONE synchronous slice = the first 7 session rows.
    expect(first.state.ids).toEqual(all.filter((id) => id <= sessionRows[6]));
    expect(steps()).toBe(first.state.ids.length);
    expect(rowCache.sessionRowCacheStats().chains).toBe(1);

    // A second synchronous call while warming advances one more slice and
    // never starts a second chain.
    const second = rowCache.foldSessionEventRows('recorded', a, opts);
    expect(second.complete).toBe(false);
    expect(second.state.ids).toEqual(all.filter((id) => id <= sessionRows[13]));
    expect(rowCache.sessionRowCacheStats().chains).toBe(1);

    const final = await done;
    expect(final.ids).toEqual(all);
    expect(completions).toHaveLength(1);
    expect(rowCache.sessionRowCacheStats().chains).toBe(0);
    expect(rowCache.sessionRowCacheStats().slices - slicesBefore).toBe(Math.ceil(50 / 7));
    const again = rowCache.foldSessionEventRows('recorded', a, opts);
    expect(again).toEqual({ state: { ids: all }, complete: true });
  });

  it('an invalidation stops the background chain', async () => {
    const a = newSession();
    for (let i = 0; i < 30; i++) insert(a, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: i });
    const onComplete = vi.fn();
    const { opts } = sliceOpts(onComplete);
    expect(rowCache.foldSessionEventRows('recorded', a, opts).complete).toBe(false);
    rowCache.invalidateSessionRowCaches(a);
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
    expect(onComplete).not.toHaveBeenCalled();
    expect(rowCache.sessionRowCacheStats()).toMatchObject({ entries: 0, chains: 0 });
  });
});

describe('eviction and module copies', () => {
  it('drops entries untouched for 30 min (one unref sweeper, stopped when empty)', () => {
    vi.useFakeTimers();
    rowCache.invalidateSessionRowCaches();   // the sweeper restarts under fake timers
    const a = newSession();
    const b = newSession();
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'x', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    insert(b, 'event', { type: 'bg_task', kind: 'started', taskId: 't' });
    sessionTokenUsage(a);
    bg.runningBgTasksFromDb(b);
    expect(rowCache.sessionRowCacheStats()).toMatchObject({ entries: 2, sweeping: true });
    vi.advanceTimersByTime(20 * 60_000);
    bg.runningBgTasksFromDb(b);              // touched at 20 min
    vi.advanceTimersByTime(11 * 60_000);     // a: 31 min idle, b: 11
    expect(rowCache.sessionRowCacheStats()).toMatchObject({ entries: 1, sweeping: true });
    vi.advanceTimersByTime(20 * 60_000);     // b: 31 min idle
    expect(rowCache.sessionRowCacheStats()).toMatchObject({ entries: 0, sweeping: false });
    // An evicted entry simply re-folds.
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    expect(rowCache.sessionRowCacheStats()).toMatchObject({ entries: 1, sweeping: true });
  });

  it('a vi.resetModules() twin shares the cache (globalThis.__charonRowCaches)', async () => {
    const a = newSession();
    const rnd = mulberry32(5);
    for (let i = 0; i < 60; i++) insertRandomRow(rnd, a, i);
    const usage = sessionTokenUsage(a);
    const scanned = rowCache.sessionRowCacheStats().rowsScanned;
    vi.resetModules();
    const twinCache: Mod = await import('@/lib/server/agent/sessionRowCache');
    const twin = await import('@/lib/server/agent/sessionTokenUsage');
    expect(twinCache).not.toBe(rowCache);
    expect(twin.sessionTokenUsage(a)).toEqual(usage);
    // Served from the shared entry: nothing re-read.
    expect(twinCache.sessionRowCacheStats().rowsScanned).toBe(scanned);
    twinCache.invalidateSessionRowCaches(a);
    expect(rowCache.sessionRowCacheStats().entries).toBe(0);
  });
});

describe('observability', () => {
  it('every fold (synchronous slice or background continuation) is timed as `fold:<key>`', async () => {
    const lag = await import('@/lib/server/perf/loopLag');
    let t = 0;
    const warn = vi.fn();
    // Each clock read advances 300 ms: every section is slow (ring + warn).
    lag.startLoopLagMonitor({ now: () => (t += 300), warn });
    try {
      const a = newSession();
      insert(a, 'event', { type: 'endpoint_usage', requestId: 'x', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
      sessionTokenUsage(a);
      recordedSessionUsage(a);
      bg.runningBgTasksFromDb(a);
      const b = newSession();
      for (let i = 0; i < 20; i++) insert(b, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: i });
      const done = new Promise<void>((resolve) => {
        rowCache.foldSessionEventRows('recorded', b, {
          likes: ['%"type":"turn_usage"%'], init: () => 0, clone: (n) => n, step: () => true,
          sliceRows: 7, onComplete: () => resolve(),
        });
      });
      await done;
      const labels = lag.loopLagSnapshot().slow.map((s) => s.label);
      expect(labels.filter((l) => l === 'fold:tokens')).toHaveLength(1);
      expect(labels.filter((l) => l === 'fold:bg')).toHaveLength(1);
      // 1 synchronous `recorded` call + the sliced one: first slice + 2 continuations.
      expect(labels.filter((l) => l === 'fold:recorded')).toHaveLength(4);
      expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/^\[perf\] fold:tokens [\d.]+ms$/));
    } finally {
      lag.stopLoopLagMonitor();
    }
  });
});

describe('the context route while the recorded fold warms', () => {
  it('answers recordedPending (never a partial sum), then the value', async () => {
    const a = newSession('codex', 'active');
    const ins = rawSqlite().prepare('INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, ?, ?, ?)');
    const turn = (input: number) => JSON.stringify({ type: 'turn_usage', provider: 'codex', inputTokens: input, outputTokens: 1, durationMs: 10 });
    // Reasoning rows: outside every fold's LIKE, and not FTS-indexed (cheap to wipe).
    const FILLER = JSON.stringify({ type: 'thinking', text: 'filler' });
    rawSqlite().transaction(() => {
      for (let i = 0; i < 20_050; i++) {
        const row = i === 5 ? ['event', turn(100)] : i === 20_040 ? ['event', turn(7)] : ['event', FILLER];
        ins.run(a, row[0], row[1], 1_800_000_000_000 + i);
      }
    })();
    const { GET } = await import('@/app/api/sessions/[id]/context/route');
    const get = async () => (await GET(new Request(`http://localhost/api/sessions/${a}/context`),
      { params: Promise.resolve({ id: a }) })).json();

    const warming = await get();
    expect(warming.recordedPending).toBe(true);
    expect(warming.recorded_usage).toBeNull();

    await vi.waitFor(() => expect(rowCache.sessionRowCacheStats().chains).toBe(0));
    const warm = await get();
    expect(warm.recordedPending).toBeUndefined();
    expect(warm.recorded_usage).toMatchObject({ turns: 2, input_tokens: 107, output_tokens: 2, duration_ms: 20 });
    expect(recordedSessionUsage(a)).toEqual({ usage: refRecorded(a), pending: false });
  }, 30_000);
});

// S1 step review (second round).
describe('the fold scan plan', () => {
  // Under real statistics (prod's stat1+stat4) the planner chose the TABLE's
  // rowid range for some sessions: a cold "20 k-row slice" walked every row
  // of every session below `hi`. The scan is pinned to the session index.
  it('a cold range always plans on idx_…_session_id_id, even under statistics favouring the rowid range', () => {
    const a = newSession();
    insert(a, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: 1, outputTokens: 1 });
    sessionTokenUsage(a);                                            // prepares the 2-LIKE scan
    const scan = (globalThis as any).__charonRowCaches.statements.scans.get(2);
    const h = rawSqlite();
    const plan = (sql: string) => h.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(a, 0, 1e9, '%x%', '%y%')
      .map((r: any) => r.detail).join(' | ');
    h.exec('ANALYZE');
    try {
      // One session holding the whole table: its index looks useless, and a
      // two-sided rowid range looks 64× more selective.
      h.exec("DELETE FROM sqlite_stat1 WHERE tbl = 'session_messages'");
      try { h.exec("DELETE FROM sqlite_stat4 WHERE tbl = 'session_messages'"); } catch { /* not compiled in */ }
      const ins = h.prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('session_messages', ?, ?)");
      for (const [idx, stat] of [
        ['idx_session_messages_session_chrono_id', '1000000 1000000 1 1'],
        ['idx_session_messages_session_ts_id', '1000000 1000000 1 1'],
        ['idx_session_messages_snapshot_lookup', '1000000 1000000 1000000 1000000 1000000 1'],
        ['idx_session_messages_session_seq', '1000000 1000000 1'],
        ['idx_session_messages_session_id_id', '1000000 1000000 1'],
      ]) ins.run(idx, stat);
      h.exec('ANALYZE sqlite_schema');
      expect(plan(scan.source)).toBe(
        'SEARCH session_messages USING INDEX idx_session_messages_session_id_id (session_id=? AND id>? AND id<?)');
      // Negative control: the same scan, unpinned, walks the table's rowid range.
      expect(plan(scan.source.replace(/INDEXED BY \S+/, ''))).toBe(
        'SEARCH session_messages USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)');
    } finally {
      h.exec('DELETE FROM sqlite_stat1');
      try { h.exec('DELETE FROM sqlite_stat4'); } catch { /* not compiled in */ }
      h.exec('ANALYZE sqlite_schema');
    }
  });
});

// §14.91: a sub-agent's own command is a step of the owner running beside it.
// A workflow reports one per tool call: counted, they read "2 running" next to
// a single workflow and bury the history under thousands of steps.
describe('background work vs a sub-agent\'s steps', () => {
  it('the hub count and the composer bar agree: steps fold into a running owner, an orphan stands alone', () => {
    const a = newSession('claude', 'background');
    const ev = (taskId: string, kind: string, extra: Record<string, unknown> = {}) =>
      insert(a, 'event', { type: 'bg_task', kind, taskId, ...extra });
    ev('wf', 'started', { taskType: 'local_workflow', workflowName: 'review' });
    ev('cmd', 'started', { taskType: 'local_bash', description: 'Build the site' });
    ev('s1', 'started', { taskType: 'local_bash', ownedBySubagent: true });
    ev('s1', 'finished', { status: 'completed' });
    ev('s2', 'started', { taskType: 'local_bash', ownedBySubagent: true });
    const items = () => bgTasks.bgWorkItems(bgTasks.reconcileAuthoritativeBgTasks([], bg.runningBgTaskDetailsFromDb(a))
      .map((t) => ({ t, status: t.status }))).map(({ t }) => t.taskId).sort();
    expect(bg.runningBgTasksFromDb(a).size).toBe(3);
    expect(bg.bgWorkCount(a, bg.runningBgTasksFromDb(a))).toBe(2);
    expect(items()).toEqual(['cmd', 'wf']);
    // The rebuilt history: an ended step never joins the finished list.
    const all = new Map<string, any>();
    for (const r of refBg(a) as RefBgRow[]) bgTasks.applyBgTaskEvent(all, JSON.parse(r.content), r.createdAt);
    expect(bgTasks.bgWorkItems(bgTasks.bgTasksToArray(all).map((t) => ({ t, status: t.status })))
      .map(({ t }) => t.taskId).sort()).toEqual(['cmd', 'wf']);
    // The owner ends, its step still runs: nothing else shows it any more.
    ev('wf', 'finished', { status: 'completed' });
    expect(bg.bgWorkCount(a, bg.runningBgTasksFromDb(a))).toBe(2);
    expect(items()).toEqual(['cmd', 's2']);
  });
});

describe('the bg registry: strict and tolerant readers', () => {
  // Load sessionOps up front: a warm completion imports it dynamically, and a
  // test importing it while that first import is still evaluating could get
  // the module half-initialised (vite-node interleaves module evaluation).
  let ops: typeof import('@/lib/server/agent/sessionOps');
  beforeAll(async () => { ops = await import('@/lib/server/agent/sessionOps'); });

  /** A session of three 20 k-row slices and a bit: bg rows near both ends. */
  function bigSession(kind = 'codex'): string {
    const a = newSession(kind, 'active');
    const ins = rawSqlite().prepare('INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, ?, ?, ?)');
    const FILLER = JSON.stringify({ type: 'thinking', text: 'filler' });
    const bg = (taskId: string, kind2: string) => JSON.stringify({
      type: 'bg_task', kind: kind2, taskId, taskType: 'codex_subagent', status: kind2 === 'finished' ? 'completed' : 'running',
    });
    rawSqlite().transaction(() => {
      for (let i = 0; i < 60_050; i++) {
        const content = i === 3 ? bg('early', 'started') : i === 60_045 ? bg('late', 'started') : FILLER;
        ins.run(a, 'event', content, Date.now() - 60_000 + i);
      }
    })();
    return a;
  }

  it('a tolerant read never folds past one slice: null while warming, a strict read completes it at once', async () => {
    const a = bigSession();
    const slices = rowCache.sessionRowCacheStats().slices;
    expect(bg.bgRegistrySnapshotFromDb(a, true)).toBeNull();
    expect(bg.runningBgTaskDetailsIfWarm(a)).toBeNull();             // the window GET omits it
    expect(bg.runningBgTasksIfWarm(a)).toBeNull();                   // the quiet gate counts busy, the list 0
    expect(rowCache.sessionRowCacheStats().slices - slices).toBe(3); // one slice per call
    expect(rowCache.sessionRowCacheStats().chains).toBe(1);
    // A strict reader (a status decision) needs the whole registry now.
    checkBg(a);
    await vi.waitFor(() => expect(rowCache.sessionRowCacheStats().chains).toBe(0), { timeout: 20_000 });
    expect(bg.bgRegistrySnapshotFromDb(a, true)).toEqual(bg.bgRegistrySnapshotFromDb(a));
    expect(bg.runningBgTaskDetailsIfWarm(a)?.map((t) => t.taskId).sort()).toEqual(['early', 'late']);
  }, 30_000);

  // S1 step review 3: the window GET that found it cold must not leave the
  // view on its paginated rebuild for good (§14.91).
  it('a window GET finding it cold says so; the warm ACTIVE set follows as ONE bg_tasks_snapshot frame', async () => {
    const a = bigSession('claude');
    const frames: any[] = [];
    const off = ops.subscribeGlobalSessionEvents((ev: any) => {
      if (ev.sessionId === a && ev.type === 'bg_tasks_snapshot') frames.push(ev);
    });
    try {
      const { GET } = await import('@/app/api/sessions/[id]/route');
      const get = async () => (await GET(new Request(`http://localhost/api/sessions/${a}?open=1`),
        { params: Promise.resolve({ id: a }) })).json();
      const cold = await get();
      expect(cold.backgroundTasks).toBeUndefined();
      expect(cold.backgroundTasksPending).toBe(true);
      await vi.waitFor(() => expect(frames).toHaveLength(1), { timeout: 20_000 });
      expect(frames[0].tasks.map((t: any) => t.taskId).sort()).toEqual(['early', 'late']);
      const warm = await get();
      expect(warm.backgroundTasksPending).toBeUndefined();
      expect(warm.backgroundTasks.map((t: any) => t.taskId).sort()).toEqual(['early', 'late']);
      expect(frames).toHaveLength(1);
    } finally {
      off();
    }
  }, 30_000);

  // Final step review, finding 5: the GET goes out before the view's focus
  // POST, and the warm can complete before that POST lands. Focus-routed, the
  // frame went to the PREVIOUS session's connection filter and was lost.
  it('the warm set reaches a connection whose focus has not switched yet (bg_tasks_snapshot is LOW_VOLUME)', async () => {
    const a = bigSession('claude');
    const { markConnectionLive, registerConnection } = await import('@/lib/server/agent/eventConnections');
    const got: any[] = [];
    const unregister = registerConnection({
      connId: 'bgsnap-before-focus', initialFocus: 'previous-session', initialFocusSeq: 1,
      send: (ev: any) => { if (ev.type === 'bg_tasks_snapshot') got.push(ev); },
    });
    markConnectionLive('bgsnap-before-focus');   // the bus router skips a conn until its route says so (C11)
    try {
      const { GET } = await import('@/app/api/sessions/[id]/route');
      const cold = await (await GET(new Request(`http://localhost/api/sessions/${a}?open=1`),
        { params: Promise.resolve({ id: a }) })).json();
      expect(cold.backgroundTasksPending).toBe(true);
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 20_000 });
      expect(got[0].sessionId).toBe(a);
      expect(got[0].tasks.map((t: any) => t.taskId).sort()).toEqual(['early', 'late']);
    } finally {
      unregister();
    }
  }, 30_000);

  // S1 final review: the frame is one-shot. A view whose SSE was not
  // registered when it went out asks again on its delta poll (`bg=1`).
  it('a delta poll with bg=1 answers the warm ACTIVE set; without it, nothing', async () => {
    const a = bigSession('claude');
    const { GET } = await import('@/app/api/sessions/[id]/route');
    const get = async (qs: string) => (await GET(new Request(`http://localhost/api/sessions/${a}?${qs}`),
      { params: Promise.resolve({ id: a }) })).json();
    const cold = await get('open=1');
    expect(cold.backgroundTasksPending).toBe(true);
    const since = cold.maxMessageId;
    await vi.waitFor(() => expect(rowCache.sessionRowCacheStats().chains).toBe(0), { timeout: 20_000 });
    const plain = await get(`since=${since}&open=1`);
    expect(plain.backgroundTasks).toBeUndefined();
    expect(plain.backgroundTasksPending).toBeUndefined();
    const asked = await get(`since=${since}&open=1&bg=1`);
    expect(asked.messages).toEqual([]);
    expect(asked.backgroundTasks.map((t: any) => t.taskId).sort()).toEqual(['early', 'late']);
    expect(asked.backgroundTasksPending).toBeUndefined();
  }, 30_000);

  // S1 step review 3: the auto-update quiet gate stopped at the first warming
  // registry, so each cold session cost one more 15-min tick.
  it('the quiet gate warms EVERY cold registry of the VPS in one pass: busy once, then quiet', async () => {
    const QUIET = 'rowcache-quiet-vps';
    db.insert(schema.vps).values({ id: QUIET, name: 'quiet', ip: '127.0.0.2', sshUser: 'root' }).onConflictDoNothing().run();
    const hourAgo = Math.floor(Date.now() / 1000) - 3_600;            // outside the 30-min activity window
    const ins = rawSqlite().prepare(
      'INSERT INTO session_messages (session_id, role, content, created_at, ts_ms) VALUES (?, ?, ?, ?, ?)');
    const FILLER = JSON.stringify({ type: 'thinking', text: 'filler' });
    const finished = (kind2: string) => JSON.stringify({ type: 'bg_task', kind: kind2, taskId: 'done', status: 'completed' });
    const ids = [0, 1, 2].map(() => {
      const id = (++sessionCounter).toString(16).padStart(32, '0');
      db.insert(schema.agentSessions).values({ id, vpsId: QUIET, cwd: '/tmp', name: 'q', status: 'active', kind: 'codex' }).run();
      rawSqlite().transaction(() => {
        for (let i = 0; i < 20_050; i++) {
          ins.run(id, 'event', i === 1 ? finished('started') : i === 20_049 ? finished('finished') : FILLER, hourAgo, hourAgo * 1000 + i);
        }
      })();
      return id;
    });
    const { isVpsBusy } = await import('@/lib/server/hub/sdkWatch');
    expect(isVpsBusy(QUIET)).toBe(true);                               // warming = busy…
    expect(rowCache.sessionRowCacheStats().chains).toBe(ids.length);  // …and every cold registry warms now
    await vi.waitFor(() => expect(rowCache.sessionRowCacheStats().chains).toBe(0), { timeout: 20_000 });
    expect(isVpsBusy(QUIET)).toBe(false);                              // the next tick updates
  }, 30_000);

  // S1 final review: `ready` evaluated the strict "tasks before this event"
  // reader BEFORE checking that anything runs — a full cold fold (after any
  // 30-min eviction) whose answer could not matter.
  it('a `ready` with no running task never folds a cold registry', () => {
    const a = bigSession();
    const stream: any = ops.getOrCreateStream(a);
    stream.bgRunning = new Map();                                     // the stream knows nothing runs
    const slices = rowCache.sessionRowCacheStats().slices;
    stream._onAgentEvent({ event: 'ready', session_id: a, seq: 70_000, ts: Date.now() / 1000 });
    expect(rowCache.sessionRowCacheStats().slices - slices).toBe(0);
    expect(rowCache.sessionRowCacheStats().chains).toBe(0);
    stream.detach();
  });

  it('a codex stream whose attach found the registry cold seeds its checks once it is warm', async () => {
    const a = bigSession();
    const stream: any = ops.getOrCreateStream(a);
    stream.ensureAttached();
    expect(stream.codexBgSeedPending).toBe(true);                    // not folded inside the (re)connect handler
    expect(stream.codexBgChecks.size).toBe(0);
    await vi.waitFor(() => expect(stream.codexBgChecks.size).toBe(2), { timeout: 20_000 });
    expect([...stream.codexBgChecks.keys()].sort()).toEqual(['early', 'late']);
    expect(stream.codexBgSeedPending).toBe(false);
    stream.detach();
  }, 30_000);
});
