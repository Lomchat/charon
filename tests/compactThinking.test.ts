import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_CHARS, DELTA_KINDS, createRunPlanner, isMergeableThinking, mergeableThinkingText, planRuns,
} from '../scripts/lib/thinkingCompaction.mjs';
import {
  BETWEEN_SQL, DELETE_SQL, LATEST_SEQ_SQL, MAX_SEQ_SQL, PAGE_SQL, RefusedError, backupDatabase, checkpointTruncate,
  compactDatabase, main, openOffline, parseArgs, vacuumDatabase,
} from '../scripts/compact-thinking.mjs';

// Offline thinking compaction (CLAUDE.md §14.109, sync refonte C04): merges a
// delta provider's per-token reasoning rows into their first row. Proven here
// on a drizzle-migrated DB: the rendered transcript (real rebuild, full set
// and every window page) is identical before/after, claude sessions and rows
// above the cursor are untouched, runs never cross a row or a seq gap, a
// second run is a no-op, and a codex SessionStream replaying the original
// deltas from BELOW the cursor inserts nothing (C02's positional cover). The
// CLI is driven as the operator runs it (a child `node` process).

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/agent/AgentClientPool', () => {
  const client = {
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {},
    call: async () => ({ ok: true, status: 'active' }),
  };
  return { getAgentClientForVpsId: () => client, getAgentClient: () => client, dropAgentClient: async () => {} };
});
vi.mock('@/lib/server/hub/codexBgState', () => ({ readCodexBgState: async () => [] }));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: async () => {} }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: async () => {},
  sendQuestionToTelegram: async () => {},
  markInteractionResolvedInTelegram: async () => {},
  sendPlainToTelegram: async () => {},
}));

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE_MODULE = path.join(REPO, 'node_modules', 'better-sqlite3');
const SCRIPT = path.join(REPO, 'scripts', 'compact-thinking.mjs');
const VPS_ID = 'compactvps';
// The agent's event clock (unix ms). A row's ts_ms is its event's ts.
const T0 = Date.now() - 3_600_000;
const at = (step: number) => T0 + step * 10;

// ─── Fixture ──────────────────────────────────────────────────────────────

type FixtureRow = {
  role: string; content: string; seq: number | null; ts: number | null;
  wire?: string | null; model?: string | null; final?: number | null; late?: boolean; createdAt?: number;
};
type FixtureSession = { id: string; kind: string; cursor: number | null; rows: FixtureRow[] };

const thinking = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'thinking', text, ...extra });
const th = (seq: number, text: string, ts = at(seq)): FixtureRow => ({ role: 'event', content: thinking(text), seq, ts });
const thN = (text: string, ts: number): FixtureRow => ({ role: 'event', content: thinking(text), seq: null, ts });
const user = (text: string, ts: number): FixtureRow => ({ role: 'user', content: text, seq: null, ts });
const assistant = (seq: number | null, text: string, ts: number): FixtureRow =>
  ({ role: 'assistant', content: text, seq, ts, model: 'gpt-5', final: 1 });
const toolUse = (seq: number, id: string): FixtureRow => ({
  role: 'tool_use', seq, ts: at(seq),
  content: JSON.stringify({ type: 'tool_use', id, name: 'Read', input: { file_path: `/src/${id}.ts` } }),
});
const toolResult = (seq: number, id: string): FixtureRow => ({
  role: 'tool_result', seq, ts: at(seq),
  content: JSON.stringify({ type: 'tool_result', tool_use_id: id, content: 'file body', is_error: false }),
});
const event = (seq: number | null, ts: number, body: Record<string, unknown>): FixtureRow =>
  ({ role: 'event', content: JSON.stringify(body), seq, ts });

const CODEX = 'c0de'.repeat(8);
const FORK = 'f0f0'.repeat(8);
const CURSOR = 'c5c5'.repeat(8);
const CLAUDE = 'c1a0'.repeat(8);
const NULL_CURSOR = '0c0c'.repeat(8);
const NULL_TS = '0e0e'.repeat(8);
const STREAM = '5e5e'.repeat(8);
const STREAM_ACROSS = 'a5a5'.repeat(8);

const FIXTURE: FixtureSession[] = [
  {
    id: CODEX, kind: 'codex', cursor: 60, rows: [
      user('Start', at(1)),
      th(10, 'Let'), th(11, ' me'), th(12, ' look'), th(13, ' at'), th(14, ' it'),
      toolUse(15, 'call_1'), toolResult(16, 'call_1'),
      th(17, 'Now'), th(18, ' the'), th(19, ' result'),
      event(20, at(20), { type: 'turn_usage', input_tokens: 10, output_tokens: 5 }),
      user('Next', at(21)),
      th(22, 'Second'), th(23, ' turn'),
      event(24, at(24), { type: 'endpoint_usage', request_id: 'r1', input_tokens: 1, output_tokens: 2, total_tokens: 3 }),
      th(25, 'Around'), th(26, ' a'), th(27, ' hub'), th(28, ' row'),
      // Hub-stamped (skewed ts): inserted last, sorts between 26 and 27.
      { ...event(29, at(26) + 5, { type: 'bg_task', kind: 'started', task_id: 'bg-1', description: 'job' }), late: true },
      th(30, 'Status'), th(31, ' splits'), /* status @32: a rowless durable event */ th(33, ' this'), th(34, ' run'),
      th(36, 'Extra'), { role: 'event', content: thinking(' keys', { replay: true }), seq: 37, ts: at(37) },
      th(38, ' are'), th(39, ' kept'),
      { ...th(40, 'Wire'), wire: thinking('Wire') }, th(41, ' rows'), th(42, ' stay'),
      { role: 'event', content: thinking(''), seq: 43, ts: at(43) }, th(44, ' Empty'), th(45, ' rows'),
      assistant(46, 'Answer', at(46)),
      th(58, 'Cursor'), th(59, ' straddle'), th(60, ' merges'), th(61, ' only'), th(62, ' below'),
      toolUse(63, 'call_2'),
    ],
  },
  {
    // A fork: copied history has seq NULL; its own events carry seqs.
    id: FORK, kind: 'codex', cursor: 5, rows: [
      user('Q', at(1)),
      thN('a', at(2)), thN('b', at(3)), thN('c', at(4)),
      assistant(null, 'A', at(5)),
      event(null, at(6), { type: 'fork_point', fromId: CODEX, fromName: 'parent' }),
      thN('d', at(7)), th(3, 'e', at(8)), th(4, 'f', at(9)),
      user('R', at(10)),
      thN('g', at(11)), thN('h', at(12)),
    ],
  },
  {
    id: CURSOR, kind: 'cursor', cursor: 8, rows: [
      user('Go', at(0)),
      th(1, 'Plan'), th(2, ' it'), th(3, ' out'), th(4, '.'),
      assistant(5, 'Sure', at(5)),
      th(6, 'Then'), th(7, ' do'), th(8, ' it'), th(9, ' now'),
    ],
  },
  {
    // Claude thinking rows are complete blocks with the same shape: never merged.
    id: CLAUDE, kind: 'claude', cursor: 100, rows: [
      user('Hi', at(0)),
      th(1, 'Block one'), th(2, 'Block two'), th(3, 'Block three'),
      assistant(4, 'Done', at(4)),
    ],
  },
  {
    // No durable cursor: seq rows keep their identity, seq-NULL rows merge.
    id: NULL_CURSOR, kind: 'codex', cursor: null, rows: [
      user('Hey', at(0)),
      th(1, 's1'), th(2, 's2'), th(3, 's3'),
      thN('n1', at(4)), thN('n2', at(5)),
    ],
  },
  {
    // A NULL ts_ms row: the window and the legacy delta order it differently.
    id: NULL_TS, kind: 'codex', cursor: 10, rows: [
      user('Yo', at(0)),
      th(1, 'x'), { role: 'event', content: thinking('y'), seq: 2, ts: null, createdAt: Math.floor(at(2) / 1000) },
      th(3, 'z'),
    ],
  },
  {
    // Rows a pre-C02 hub wrote for the STREAM_EVENTS below (cursor 22).
    id: STREAM, kind: 'codex', cursor: 22, rows: [
      user('Check the file', at(1)),
      th(10, 'Let'), th(11, ' me'), th(12, ' check'), /* status @13 */ th(14, ' the'), th(15, ' file'),
      toolUse(16, 'call_a'),
      th(17, 'Done'), th(18, ' reading'),
      toolUse(19, 'call_b'),
      th(20, 'More'), th(21, ' thought'), th(22, ' here'), th(23, ' and'), th(24, ' more'),
      toolUse(25, 'call_c'),
    ],
  },
  {
    // What a planner WITHOUT the seq rule would leave: one row merged across
    // the status @13 (negative control of the replay test).
    id: STREAM_ACROSS, kind: 'codex', cursor: 22, rows: [
      user('Check the file', at(1)),
      th(10, 'Let me check the file'),
      toolUse(16, 'call_a'),
    ],
  },
];

const CODEX_ROWS = FIXTURE[0].rows.length;

/** `n` codex sessions of one user row + `deltas` consecutive thinking deltas
 *  (one merge each, far below a batch), ids in insertion order. */
const smallSessions = (n: number, deltas = 3): FixtureSession[] => Array.from({ length: n }, (_, i) => ({
  id: `5a11${String(i).padStart(28, '0')}`, kind: 'codex', cursor: 100,
  rows: [user('Q', at(0)), ...Array.from({ length: deltas }, (_, j) => th(j + 1, `t${j}`))],
}));

function seed(h: Database.Database, sessions: FixtureSession[]) {
  h.prepare("INSERT OR IGNORE INTO vps_folders (id, name, position) VALUES ('default', 'default', 0)").run();
  h.prepare("INSERT OR IGNORE INTO vps (id, name, ip, ssh_user) VALUES (?, 'compact', '127.0.0.1', 'root')").run(VPS_ID);
  const session = h.prepare(`INSERT INTO agent_sessions (id, vps_id, cwd, status, kind, last_seen_seq)
    VALUES (?, ?, '/tmp', 'active', ?, ?)`);
  const message = h.prepare(`INSERT INTO session_messages
    (session_id, role, content, wire_content, seq, ts_ms, created_at, model, assistant_final)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insert = (sid: string, r: FixtureRow) => message.run(sid, r.role, r.content, r.wire ?? null, r.seq, r.ts,
    r.createdAt ?? Math.floor((r.ts as number) / 1000), r.model ?? null, r.final ?? null);
  h.transaction(() => {
    for (const s of sessions) {
      session.run(s.id, VPS_ID, s.kind, s.cursor);
      for (const r of s.rows) if (!r.late) insert(s.id, r);
    }
    for (const s of sessions) for (const r of s.rows) if (r.late) insert(s.id, r);
  })();
}

/** A fresh migrated DB file holding `sessions` (closed: the CLI needs it alone). */
function makeDb(file: string, sessions: FixtureSession[] = FIXTURE) {
  const h = new Database(file);
  h.pragma('journal_mode = WAL');
  migrate(drizzle(h), { migrationsFolder: path.join(REPO, 'drizzle') });
  seed(h, sessions);
  h.close();
}

type RawRow = {
  id: number; session_id: string; role: string; content: string; wire_content: string | null; seq: number | null;
  ts_ms: number | null; created_at: number; model: string | null; assistant_final: number | null;
};

function rawRows(h: Database.Database, sid: string): RawRow[] {
  return h.prepare(`SELECT id, session_id, role, content, wire_content, seq, ts_ms, created_at, model, assistant_final
    FROM session_messages WHERE session_id = ? ORDER BY id`).all(sid) as RawRow[];
}

const key = (r: RawRow) => r.ts_ms ?? r.created_at * 1000;
const chrono = (rows: RawRow[]) => [...rows].sort((a, b) => (key(a) - key(b)) || (a.id - b.id));
const textOf = (r: { content: string }) => JSON.parse(r.content).text as string;
const isThinkingRow = (r: { role: string; content: string }) => {
  if (r.role !== 'event') return false;
  try { return JSON.parse(r.content).type === 'thinking'; } catch { return false; }
};

/** Thinking rows of a session as `[seq, text]` in rebuild order. */
function thinkingOf(h: Database.Database, sid: string) {
  return chrono(rawRows(h, sid)).filter(isThinkingRow).map((r) => [r.seq, textOf(r)]);
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charon-compact-test-'));
});
afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
const tmpFile = (name: string) => path.join(fs.mkdtempSync(path.join(tmpRoot, 'db-')), name);

// ─── Pure planner ─────────────────────────────────────────────────────────

describe('planner (scripts/lib/thinkingCompaction.mjs)', () => {
  const row = (id: number, seq: number | null, text: string | null, extra: Record<string, unknown> = {}) => ({
    id, seq, k: id * 10, role: text == null ? 'tool_use' : 'event', wnull: 1,
    content: text == null ? '{"type":"tool_use"}' : thinking(text), ...extra,
  });
  const simple = (ops: any[]) => ops.map((o) => ({ keepId: o.keepId, text: o.text, deleteIds: o.deleteIds }));

  it('DELTA_KINDS is exactly the registry\'s delta providers; the cap is the hub\'s live cut', async () => {
    const { PROVIDERS } = await import('@/lib/sessionCapabilities');
    const { THINKING_ROW_MAX_CHARS } = await import('@/lib/server/agent/thinkingBoundaries');
    const delta = Object.entries(PROVIDERS).filter(([, p]) => p.thinkingDelivery === 'delta').map(([k]) => k);
    expect([...DELTA_KINDS].sort()).toEqual(delta.sort());
    expect(DEFAULT_MAX_CHARS).toBe(THINKING_ROW_MAX_CHARS);
  });

  it('isMergeableThinking: role event, wire_content NULL, EXACTLY {type,text}, type thinking, non-empty text', () => {
    const base = { id: 1, seq: 1, role: 'event', wnull: 1 };
    expect(isMergeableThinking({ ...base, content: thinking('a') })).toBe(true);
    expect(isMergeableThinking({ ...base, content: '{"text":"a","type":"thinking"}' })).toBe(true);
    expect(mergeableThinkingText({ ...base, content: thinking(' x ') })).toBe(' x ');
    expect(isMergeableThinking({ id: 1, seq: 1, role: 'event', wire_content: null, content: thinking('a') })).toBe(true);
    expect(isMergeableThinking({ id: 1, seq: 1, role: 'event', wire_content: thinking('a'), content: thinking('a') })).toBe(false);
    for (const bad of [
      { ...base, role: 'thinking', content: thinking('a') },
      { ...base, role: 'assistant', content: thinking('a') },
      { ...base, wnull: 0, content: thinking('a') },
      { id: 1, seq: 1, role: 'event', content: thinking('a') },              // wire state unknown
      { ...base, content: thinking('') },
      { ...base, content: thinking('a', { replay: true }) },
      { ...base, content: '{"type":"thinking"}' },
      { ...base, content: '{"type":"thinking","text":5}' },
      { ...base, content: '{"type":"reasoning","text":"a"}' },
      { ...base, content: '["thinking","a"]' },
      { ...base, content: 'not json' },
      { ...base, content: null },
    ]) expect(isMergeableThinking(bad as any)).toBe(false);
  });

  it('merges strictly consecutive seq rows ≤ cursor into the first; a row of any other kind or a seq gap splits', () => {
    const rows = [
      row(1, 10, 'a'), row(2, 11, 'b'), row(3, 12, 'c'),
      row(4, 13, null),                                   // tool_use
      row(5, 14, 'd'), row(6, 15, 'e'),
      row(7, 17, 'f'), row(8, 18, 'g'),                   // gap at 16 (a rowless event)
      row(9, 19, 'h'),
    ];
    expect(simple(planRuns(rows, { cursor: 100 }))).toEqual([
      { keepId: 1, text: 'abc', deleteIds: [2, 3] },
      { keepId: 5, text: 'de', deleteIds: [6] },
      { keepId: 7, text: 'fgh', deleteIds: [8, 9] },
    ]);
  });

  it('above the cursor nothing merges (a straddling run keeps its ≤-cursor prefix); a NULL cursor merges seq-NULL runs only', () => {
    const rows = [row(1, 5, 'a'), row(2, 6, 'b'), row(3, 7, 'c'), row(4, 8, 'd')];
    expect(simple(planRuns(rows, { cursor: 6 }))).toEqual([{ keepId: 1, text: 'ab', deleteIds: [2] }]);
    expect(planRuns(rows, { cursor: 5 })).toEqual([]);
    expect(planRuns(rows, { cursor: null })).toEqual([]);
    const nulls = [row(1, null, 'x'), row(2, null, 'y'), row(3, 1, 'z'), row(4, 2, 'w'), row(5, null, 'v')];
    expect(simple(planRuns(nulls, { cursor: null }))).toEqual([{ keepId: 1, text: 'xy', deleteIds: [2] }]);
    // seq-NULL and seq rows never mix, whatever the cursor.
    expect(simple(planRuns(nulls, { cursor: 10 }))).toEqual([
      { keepId: 1, text: 'xy', deleteIds: [2] }, { keepId: 3, text: 'zw', deleteIds: [4] },
    ]);
  });

  it('equal or decreasing seqs never merge (duplicates, a recreated log)', () => {
    expect(planRuns([row(1, 4, 'a'), row(2, 4, 'a'), row(3, 2, 'b')], { cursor: 10 })).toEqual([]);
  });

  it('caps the merged text at maxChars and continues with a new run', () => {
    const rows = [row(1, 1, 'aaaa'), row(2, 2, 'bbbb'), row(3, 3, 'cccc'), row(4, 4, 'dd'), row(5, 5, 'eeeeeeeeeeee'), row(6, 6, 'f')];
    expect(simple(planRuns(rows, { cursor: 10, maxChars: 10 }))).toEqual([
      { keepId: 1, text: 'aaaabbbb', deleteIds: [2] },
      { keepId: 3, text: 'ccccdd', deleteIds: [4] },
      // 'eeeeeeeeeeee' alone exceeds the cap: it stays, and 'f' starts over.
    ]);
    for (const op of planRuns(rows, { cursor: 10, maxChars: 10 })) expect(op.text.length).toBeLessThanOrEqual(10);
  });

  it('ops locate their run for --verify (keep seq/key, last id/key)', () => {
    const [op] = planRuns([row(1, 3, 'a'), row(2, 4, 'b'), row(3, 5, 'c')], { cursor: 9 });
    expect(op).toEqual({ keepId: 1, text: 'abc', deleteIds: [2, 3], keepSeq: 3, keepKey: 10, lastId: 3, lastKey: 30 });
  });

  it('the streaming planner fed in arbitrary pages plans exactly like planRuns; out-of-order rows throw', () => {
    const rows: any[] = [];
    let seq = 1;
    for (let i = 1; i <= 400; i++) {
      const r = (i * 7919) % 13;
      if (r === 0) rows.push(row(i, seq++, null));
      else if (r === 1) { seq++; rows.push(row(i, seq++, `t${i}`)); }  // a gap
      else if (r === 2) rows.push(row(i, null, `n${i}`));
      else rows.push(row(i, seq++, `t${i}`));
    }
    const whole = planRuns(rows, { cursor: 300, maxChars: 40 });
    expect(whole.length).toBeGreaterThan(20);
    for (const size of [1, 2, 3, 17, 400]) {
      const planner = createRunPlanner({ cursor: 300, maxChars: 40 });
      const ops: any[] = [];
      for (let i = 0; i < rows.length; i += size) for (const r of rows.slice(i, i + size)) ops.push(...planner.push(r));
      ops.push(...planner.end());
      expect(ops).toEqual(whole);
    }
    const planner = createRunPlanner({ cursor: 10 });
    planner.push(row(2, 1, 'a'));
    expect(() => planner.push(row(1, 2, 'b'))).toThrow(/out of rebuild order/);
  });
});

// ─── The CLI's arguments ──────────────────────────────────────────────────

describe('arguments', () => {
  it('requires --db and --offline for every writing mode; one step per run', () => {
    expect(() => parseArgs([])).toThrow(/--db <path> is required/);
    expect(parseArgs(['--db', 'x']).mode).toBe('dry-run');
    expect(parseArgs(['--db', 'x', '--dry-run', '--session', 's', '--report', 'r.json']).mode).toBe('dry-run');
    expect(parseArgs(['--db', 'x', '--offline', '--apply', '--verify', '--batch', '7'])).toMatchObject({ mode: 'apply', batch: 7, verify: true });
    expect(parseArgs(['--db', 'x', '--offline', '--backup-to', 'b', '--no-check'])).toMatchObject({ mode: 'backup', noCheck: true });
    expect(parseArgs(['--db', 'x', '--offline', '--vacuum', '--no-analyze'])).toMatchObject({ mode: 'vacuum', noAnalyze: true });
    for (const [args, msg] of [
      [['--db', 'x', '--apply'], /requires --offline/],
      [['--db', 'x', '--backup-to', 'b'], /requires --offline/],
      [['--db', 'x', '--vacuum'], /requires --offline/],
      [['--db', 'x', '--offline'], /only applies/],
      [['--db', 'x', '--offline', '--apply', '--vacuum'], /one maintenance step/],
      [['--db', 'x', '--dry-run', '--offline', '--apply'], /--dry-run writes nothing/],
      [['--db', 'x', '--verify'], /--verify only applies/],
      [['--db', 'x', '--batch', '5'], /--batch only applies/],
      [['--db', 'x', '--offline', '--apply', '--batch', '0'], /positive integer/],
      [['--db', 'x', '--no-analyze'], /--no-analyze only applies/],
      [['--db', 'x', '--no-check'], /--no-check only applies/],
      [['--db', 'x', '--offline', '--vacuum', '--session', 's'], /--session only applies/],
      [['--db'], /needs a value/],
      [['--db', 'x', '--bogus'], /unknown argument/],
    ] as const) expect(() => parseArgs([...args])).toThrow(msg);
  });
});

// ─── Compaction on the migrated (hermetic) DB ─────────────────────────────

describe('compaction keeps every rendering', () => {
  let h: Database.Database;
  let rebuild: (rows: any[], provider: string) => any;
  let orderChronologically: (rows: any[]) => any[];
  let loadMessageWindow: (sid: string, limit: number, before: number | null) => any;
  type Snapshot = { rows: RawRow[]; full: any; fullLegacy: any; pages: Record<number, any[]>; fts: any[] };
  const before = new Map<string, Snapshot>();
  const after = new Map<string, Snapshot>();
  let report: any;
  const LIMITS = [1, 2, 3, 200];

  const persisted = (r: any) => ({
    id: r.id, role: r.role, content: r.content, createdAt: r.createdAt ?? r.created_at,
    model: r.model ?? null, assistantFinal: r.assistantFinal ?? r.assistant_final ?? null,
  });
  const fromRaw = (r: RawRow) => persisted({ ...r, content: r.wire_content ?? r.content });

  function snapshot(s: FixtureSession): Snapshot {
    const rows = rawRows(h, s.id);
    const full = rebuild(chrono(rows).map(fromRaw), s.kind);
    const legacy = orderChronologically(rows.map((r) => ({ ...r, tsMs: r.ts_ms })));
    const fullLegacy = rebuild(legacy.map(fromRaw), s.kind);
    const pages: Record<number, any[]> = {};
    for (const limit of LIMITS) {
      pages[limit] = [];
      let cursor: number | null = null;
      for (;;) {
        const w = loadMessageWindow(s.id, limit, cursor);
        pages[limit].push({ hasMore: w.hasMore, oldestChatId: w.oldestChatId, state: rebuild(w.messages.map(persisted), s.kind) });
        if (!w.hasMore || w.oldestChatId == null) break;
        cursor = w.oldestChatId;
      }
    }
    const fts = h.prepare(`SELECT rowid, content FROM session_messages_fts WHERE session_id = ? ORDER BY rowid`).all(s.id);
    return { rows, full, fullLegacy, pages, fts };
  }

  beforeAll(async () => {
    const dbMod = await import('@/lib/db');
    h = dbMod.rawSqlite();
    migrate(dbMod.db, { migrationsFolder: './drizzle' });
    const { rebuildStateFromMessages } = await import('@/app/sessionRebuild');
    rebuild = (rows, provider) => rebuildStateFromMessages(rows, 'active', provider as any);
    ({ orderChronologically } = await import('@/lib/server/hub/messageOrder') as any);
    ({ loadMessageWindow } = await import('@/lib/server/hub/messageWindow') as any);
    seed(h, FIXTURE);
    for (const s of FIXTURE) before.set(s.id, snapshot(s));
    report = await compactDatabase(h, { apply: true, verify: true });
    for (const s of FIXTURE) after.set(s.id, snapshot(s));
  });

  it('merges exactly the expected runs (codex, fork, cursor; cursor-less and NULL-ts sessions)', () => {
    expect(thinkingOf(h, CODEX)).toEqual([
      [10, 'Let me look at it'],            // ended by tool_use
      [17, 'Now the result'],               // ended by turn_usage
      [22, 'Second turn'],                  // ended by endpoint_usage
      [25, 'Around a'],                     // ended by the hub-stamped bg_task
      [27, ' hub row'],
      [30, 'Status splits'],                // seq gap: the rowless status @32
      [33, ' this run'],                    // (seq gap @35)
      [36, 'Extra'], [37, ' keys'],         // an extra-key row is never merged
      [38, ' are kept'],
      [40, 'Wire'],                         // wire_content set: never merged
      [41, ' rows stay'],
      [43, ''],                             // empty text: never merged
      [44, ' Empty rows'],
      [58, 'Cursor straddle merges'],       // cursor 60: the ≤-cursor prefix
      [61, ' only'], [62, ' below'],        // above the cursor: untouched
    ]);
    expect(thinkingOf(h, FORK)).toEqual([[null, 'abc'], [null, 'd'], [3, 'ef'], [null, 'gh']]);
    expect(thinkingOf(h, CURSOR)).toEqual([[1, 'Plan it out.'], [6, 'Then do it'], [9, ' now']]);
    expect(thinkingOf(h, NULL_CURSOR)).toEqual([[1, 's1'], [2, 's2'], [3, 's3'], [null, 'n1n2']]);
    expect(thinkingOf(h, STREAM)).toEqual([
      [10, 'Let me check'], [14, ' the file'], [17, 'Done reading'], [20, 'More thought here'], [23, ' and'], [24, ' more'],
    ]);
    expect(report.totals).toMatchObject({ sessions: 6, ops: 21 });   // 6 eligible: claude and NULL-ts skipped
    expect(report.totals.verified).toBe(report.totals.ops);
    expect(report.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: CLAUDE, skipped: 'kind' }),
      expect.objectContaining({ id: NULL_TS, skipped: 'null-ts' }),
    ]));
  });

  it('rebuildStateFromMessages is deep-equal before/after: full set (both orders) and every window page', () => {
    for (const s of FIXTURE) {
      const b = before.get(s.id)!;
      const a = after.get(s.id)!;
      expect(a.full).toEqual(b.full);
      expect(a.fullLegacy).toEqual(b.fullLegacy);
      for (const limit of LIMITS) {
        expect(a.pages[limit].map((p) => [p.hasMore, p.oldestChatId])).toEqual(b.pages[limit].map((p) => [p.hasMore, p.oldestChatId]));
        expect(a.pages[limit]).toEqual(b.pages[limit]);
      }
    }
    // The fixture does exercise several pages and one joined bubble per block.
    expect(before.get(CODEX)!.pages[1].length).toBeGreaterThan(3);
    expect(before.get(CODEX)!.full.messages.filter((m: any) => m.role === 'thinking').map((m: any) => m.content)).toEqual([
      'Let me look at it', 'Now the result',
      'Second turnAround a hub rowStatus splits this runExtra keys are keptWire rows stay Empty rows',
      'Cursor straddle merges only below',
    ]);
  });

  it('claude sessions, NULL-ts sessions and every row above the cursor are untouched', () => {
    expect(after.get(CLAUDE)!.rows).toEqual(before.get(CLAUDE)!.rows);
    expect(after.get(NULL_TS)!.rows).toEqual(before.get(NULL_TS)!.rows);
    for (const s of FIXTURE) {
      const kept = (rows: RawRow[]) => rows.filter((r) => r.seq != null && (s.cursor == null || r.seq > s.cursor));
      expect(kept(after.get(s.id)!.rows)).toEqual(kept(before.get(s.id)!.rows));
    }
  });

  it('a run never crosses a row of another kind nor a seq gap; the kept row keeps id/seq/ts/created_at', () => {
    for (const s of FIXTURE) {
      const b = chrono(before.get(s.id)!.rows);
      const afterById = new Map(after.get(s.id)!.rows.map((r) => [r.id, r]));
      for (const r of afterById.values()) {
        const was = b.find((x) => x.id === r.id)!;
        expect({ ...r, content: null }).toEqual({ ...was, content: null });
      }
      let i = 0;
      while (i < b.length) {
        expect(afterById.has(b[i].id)).toBe(true);    // a run always starts with its kept row
        const run = [b[i]];
        let j = i + 1;
        while (j < b.length && !afterById.has(b[j].id)) run.push(b[j++]);
        const kept = afterById.get(b[i].id)!;
        if (run.length > 1) {
          for (const r of run) {
            expect(isMergeableThinking({ ...r, wnull: r.wire_content == null ? 1 : 0 })).toBe(true);
            expect(r.seq == null || (s.cursor != null && r.seq <= s.cursor)).toBe(true);
          }
          if (run[0].seq == null) expect(run.every((r) => r.seq == null)).toBe(true);
          else expect(run.map((r) => r.seq)).toEqual(run.map((_, k) => run[0].seq! + k));
          expect(textOf(kept)).toBe(run.map(textOf).join(''));
          expect(JSON.parse(kept.content)).toEqual({ type: 'thinking', text: textOf(kept) });
        } else {
          expect(kept.content).toBe(b[i].content);
        }
        i = j;
      }
    }
  });

  it('FTS is unchanged (thinking rows were never indexed)', () => {
    for (const s of FIXTURE) expect(after.get(s.id)!.fts).toEqual(before.get(s.id)!.fts);
    expect(before.get(CODEX)!.fts.length).toBeGreaterThan(0);
  });

  it('a second run plans and changes nothing', async () => {
    const rows = FIXTURE.map((s) => rawRows(h, s.id));
    const dry = await compactDatabase(h, {});
    expect(dry.totals.ops).toBe(0);
    const again = await compactDatabase(h, { apply: true, verify: true });
    expect(again.totals).toMatchObject({ ops: 0, rowsDeleted: 0 });
    expect(FIXTURE.map((s) => rawRows(h, s.id))).toEqual(rows);
  });

  describe('a codex SessionStream replaying from BELOW the cursor after compaction (C02 cover)', () => {
    const ev = (event: string, seq: number, sid: string, extra: Record<string, unknown> = {}) =>
      ({ event, session_id: sid, seq, ts: at(seq) / 1000, ...extra });
    const STREAM_EVENTS = (sid: string) => [
      ['thinking', 10, { text: 'Let' }], ['thinking', 11, { text: ' me' }], ['thinking', 12, { text: ' check' }],
      ['status', 13, { status: 'thinking' }],
      ['thinking', 14, { text: ' the' }], ['thinking', 15, { text: ' file' }],
      ['tool_use', 16, { id: 'call_a', name: 'Read', input: { file_path: '/src/call_a.ts' } }],
      ['thinking', 17, { text: 'Done' }], ['thinking', 18, { text: ' reading' }],
      ['tool_use', 19, { id: 'call_b', name: 'Read', input: { file_path: '/src/call_b.ts' } }],
      ['thinking', 20, { text: 'More' }], ['thinking', 21, { text: ' thought' }], ['thinking', 22, { text: ' here' }],
      ['thinking', 23, { text: ' and' }], ['thinking', 24, { text: ' more' }],
      ['tool_use', 25, { id: 'call_c', name: 'Read', input: { file_path: '/src/call_c.ts' } }],
    ].map(([event, seq, extra]) => ev(event as string, seq as number, sid, extra as Record<string, unknown>));

    async function replayAll(sid: string, events: any[]) {
      const { SessionStream } = await import('@/lib/server/agent/sessionOps');
      const s: any = new SessionStream({
        id: sid, vpsId: VPS_ID, name: null, status: 'active', permissionMode: 'normal' as any,
        nativeSessionId: null, kind: 'codex', lastSeenSeq: 22,
      });
      const frames: any[] = [];
      vi.spyOn(s, '_emitBroadcast').mockImplementation((e: any) => { frames.push(e); });
      s._onAgentEvent({ event: 'replay_begin', session_id: sid, count: events.length });
      for (const e of events) s._onAgentEvent(e);
      s._onAgentEvent({ event: 'replay_end', session_id: sid });
      s._flushLiveBroadcast();
      return { s, frames };
    }

    it('the original deltas, the status between them and the boundaries insert nothing', async () => {
      const rows = rawRows(h, STREAM);
      const { s, frames } = await replayAll(STREAM, STREAM_EVENTS(STREAM));
      expect(rawRows(h, STREAM)).toEqual(rows);
      // No text re-sent; each merged row (seq <= the cursor 22) is re-cut at
      // its anchor, positionally (no content: a browser that already had the
      // cut changes nothing). The one-delta rows past the cursor are not.
      expect(frames.filter((f) => f.type === 'thinking')).toEqual([]);
      const cuts = frames.filter((f) => f.type === 'thinking_flushed');
      expect(cuts.map((f) => [f.rowId, f.length, f.content]))
        .toEqual(chrono(rows).filter((r) => isThinkingRow(r) && r.seq! <= 22).map((r) => [r.id, textOf(r).length, undefined]));
      expect(cuts).toHaveLength(4);
      expect(s.getStreamingThinking()).toBe('');
    });

    it('negative control: a row merged ACROSS the status would be written again by that replay', async () => {
      const rows = rawRows(h, STREAM_ACROSS);
      await replayAll(STREAM_ACROSS, STREAM_EVENTS(STREAM_ACROSS).filter((e) => e.seq <= 16));
      const added = rawRows(h, STREAM_ACROSS).filter((r) => !rows.some((x) => x.id === r.id));
      expect(added.map((r) => [r.seq, textOf(r)])).toEqual([[14, ' the file']]);
    });
  });

  it('the keyset page, the --verify probe and the seq-epoch seeks each plan as ONE index range, a DELETE chunk as rowid lookups (also under prod stats)', () => {
    const detail = (rows: any[]) => rows.map((r) => r.detail).join(' | ');
    const plans = () => [
      h.prepare(`EXPLAIN QUERY PLAN ${PAGE_SQL}`).all({ sid: CODEX, k: 1, id: 1, limit: 20000 }),
      h.prepare(`EXPLAIN QUERY PLAN ${BETWEEN_SQL}`).all({ sid: CODEX, k1: 1, id1: 1, k2: 2, id2: 2 }),
    ].map(detail);
    const check = () => {
      for (const plan of plans()) {
        expect(plan).toMatch(/SEARCH session_messages USING (COVERING )?INDEX idx_session_messages_session_chrono_id \(session_id=\? AND <expr>>\?/);
        expect(plan).not.toMatch(/TEMP B-TREE|MULTI-INDEX|SCAN/);
      }
      const latest = detail(h.prepare(`EXPLAIN QUERY PLAN ${LATEST_SEQ_SQL}`).all(CODEX));
      expect(latest).toMatch(/SEARCH session_messages USING INDEX idx_session_messages_session_chrono_id \(session_id=\?\)/);
      expect(latest).not.toMatch(/TEMP B-TREE|MULTI-INDEX|SCAN/);
      const max = detail(h.prepare(`EXPLAIN QUERY PLAN ${MAX_SEQ_SQL}`).all(CODEX));
      expect(max).toMatch(/SEARCH session_messages USING COVERING INDEX idx_session_messages_session_seq \(session_id=\?\)/);
      expect(max).not.toMatch(/TEMP B-TREE|MULTI-INDEX|SCAN/);
      // A DELETE chunk is rowid lookups, never a walk of the session's event
      // prefix on idx_…_snapshot_lookup (the rehearsal's 1000 s apply).
      for (const n of [1, 20, 900]) {
        const ids = Array.from({ length: n }, (_, i) => i + 1);
        const del = detail(h.prepare(`EXPLAIN QUERY PLAN ${DELETE_SQL(n)}`).all(...ids, CODEX))
          .split(' | ').filter((d) => d.includes('session_messages')).join(' | ');
        expect(del).toBe('SEARCH session_messages USING INTEGER PRIMARY KEY (rowid=?)');
      }
    };
    check();
    h.exec('ANALYZE');
    try {
      h.exec("DELETE FROM sqlite_stat1 WHERE tbl = 'session_messages'");
      const ins = h.prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('session_messages', ?, ?)");
      // Production values (read-only copy of its sqlite_stat1, as in peerReplyContext.test.ts).
      for (const [idx, stat] of [
        ['idx_session_messages_session_chrono_id', '347576 11986 1 1'],
        ['idx_session_messages_snapshot_lookup', '347576 11986 2159 96 53 1'],
        ['idx_session_messages_session_seq', '347576 11986 1'],
        ['idx_session_messages_session_ts_id', '347576 11986 1 1'],
        ['idx_session_messages_session_id_id', '347576 11986 1'],
      ]) ins.run(idx, stat);
      h.exec('ANALYZE sqlite_schema');
      check();
      // Negative control: the pre-fix DELETE (bare session_id/role terms)
      // plans a 900-id chunk on the snapshot_lookup prefix under these stats.
      const ids = Array.from({ length: 900 }, (_, i) => i + 1);
      expect(detail(h.prepare(`EXPLAIN QUERY PLAN DELETE FROM session_messages
        WHERE id IN (${ids.map(() => '?').join(',')}) AND session_id = ? AND role = 'event'`).all(...ids, CODEX)))
        .toMatch(/USING COVERING INDEX idx_session_messages_snapshot_lookup \(session_id=\? AND role=\?\)/);
    } finally {
      h.exec('DELETE FROM sqlite_stat1');
      try { h.exec('DELETE FROM sqlite_stat4'); } catch { /* not compiled in */ }
      h.exec('ANALYZE sqlite_schema');
    }
  });
});

// ─── Apply on separate files: batches, paging, stop/resume, FK, --verify ──

describe('apply mechanics', () => {
  const finalRows = (file: string) => {
    const h = new Database(file, { readonly: true });
    try { return FIXTURE.map((s) => rawRows(h, s.id)); } finally { h.close(); }
  };
  let reference: RawRow[][];
  beforeAll(async () => {
    const file = tmpFile('ref.db');
    makeDb(file);
    const h = openOffline(Database, file);
    await compactDatabase(h, { apply: true });
    h.close();
    reference = finalRows(file);
  });

  it('tiny batches and tiny pages give the same result as one transaction', async () => {
    const file = tmpFile('small.db');
    makeDb(file);
    const h = openOffline(Database, file);
    const r = await compactDatabase(h, { apply: true, verify: true, batch: 1, pageRows: 2 });
    h.close();
    expect(r.batches).toBeGreaterThanOrEqual(21);
    expect(r.checkpoints).toBeGreaterThanOrEqual(3);   // every 10 batches + the final one
    expect(finalRows(file)).toEqual(reference);
  });

  it('a stop between batches leaves a consistent DB; the rerun resumes and ends identical', async () => {
    const file = tmpFile('stop.db');
    makeDb(file);
    let h = openOffline(Database, file);
    let commits = 0;
    const first = await compactDatabase(h, { apply: true, batch: 1, shouldStop: () => ++commits > 3 });
    h.close();
    // Stopped right after its 3rd committed batch, inside the first session.
    expect(first.stopped).toBe(true);
    expect(first.totals.ops).toBe(3);
    expect(first.sessions.map((s: any) => [s.id, s.complete, s.ops])).toEqual([[CODEX, false, 3]]);
    expect(h.inTransaction).toBe(false);
    h = openOffline(Database, file);
    const second = await compactDatabase(h, { apply: true, verify: true });
    h.close();
    expect(first.totals.ops + second.totals.ops).toBe(21);
    expect(finalRows(file)).toEqual(reference);
  });

  it('refuses to delete a row a scheduled resume references; the batch rolls back', async () => {
    const file = tmpFile('fk.db');
    makeDb(file);
    let h = new Database(file);
    const victim = (h.prepare(`SELECT id FROM session_messages WHERE session_id = ? AND seq = 11`).get(CODEX) as any).id;
    h.prepare(`INSERT INTO session_scheduled_resumes (id, session_id, source_message_id, message_id, content, run_at, client_message_id)
      VALUES ('sr1', ?, ?, ?, 'continue', 1, 'c1')`).run(CODEX, victim, victim);
    h.close();
    const before = finalRows(file);
    h = openOffline(Database, file);
    await expect(compactDatabase(h, { apply: true, sessionId: CODEX })).rejects.toThrow(/referenced by session_scheduled_resumes/);
    expect(h.inTransaction).toBe(false);
    h.close();
    expect(finalRows(file)).toEqual(before);
  });

  it('foreign keys: PRE-EXISTING orphans are reported and kept; a violation the run adds fails it', async () => {
    const file = tmpFile('orphans.db');
    makeDb(file);
    let h = new Database(file);
    h.pragma('foreign_keys = OFF');
    const orphan = (d: Database.Database, sid: string) => Number(d.prepare(`INSERT INTO session_messages
      (session_id, role, content, ts_ms) VALUES (?, 'user', 'orphan', 1)`).run(sid).lastInsertRowid);
    const old = orphan(h, 'gone');
    h.close();
    const lines: string[] = [];
    h = openOffline(Database, file);
    const r = await compactDatabase(h, { apply: true, log: (l) => lines.push(l) });
    h.close();
    expect(r.foreignKeyViolationsPreExisting).toBe(1);
    expect(lines).toContain(`warning: foreign_key_check: 1 pre-existing violations, left untouched: `
      + `session_messages → agent_sessions ×1 (rowids ${old})`);
    expect(finalRows(file)).toEqual(reference);
    h = new Database(file, { readonly: true });
    expect(h.prepare('SELECT count(*) AS n FROM session_messages WHERE id = ?').get(old)).toEqual({ n: 1 });
    h.close();

    // An orphan appearing during the run (seam: the session-boundary stop check).
    const again = tmpFile('orphans2.db');
    makeDb(again);
    h = openOffline(Database, again);
    let added = false;
    const shouldStop = () => {
      if (!added) {
        added = true;
        h.pragma('foreign_keys = OFF');
        orphan(h, 'also-gone');
        h.pragma('foreign_keys = ON');
      }
      return false;
    };
    const err = await compactDatabase(h, { apply: true, shouldStop }).then(() => null, (e) => e);
    h.close();
    expect(String(err?.message)).toMatch(/foreign_key_check: 1 NEW violations \(0 pre-existing\)/);
    expect(err.report.totals.sessions).toBeGreaterThan(0);              // the committed work is reported
  });

  it('--verify catches a row left inside a merged run, and the batch rolls back', async () => {
    const file = tmpFile('verify.db');
    makeDb(file);
    const before = finalRows(file);
    const h = openOffline(Database, file);
    // A connection-local trigger slips a row into the run as it is merged.
    h.exec(`CREATE TEMP TRIGGER sneak AFTER UPDATE OF content ON main.session_messages
      WHEN new.session_id = '${CODEX}' AND new.seq = 10
      BEGIN
        INSERT INTO session_messages (session_id, role, content, seq, ts_ms, created_at)
        VALUES (new.session_id, 'assistant', 'intruder', NULL, new.ts_ms + 15, new.created_at);
      END`);
    await expect(compactDatabase(h, { apply: true, verify: true, sessionId: CODEX })).rejects.toThrow(/--verify: 1 rows remain/);
    expect(h.inTransaction).toBe(false);
    // …and a kept row whose text is not the concatenation.
    h.exec('DROP TRIGGER sneak');
    h.exec(`CREATE TEMP TRIGGER tamper AFTER UPDATE OF content ON main.session_messages
      WHEN new.session_id = '${CODEX}' AND new.seq = 10
      BEGIN
        UPDATE session_messages SET content = '{"type":"thinking","text":"Let me"}' WHERE id = new.id;
      END`);
    await expect(compactDatabase(h, { apply: true, verify: true, sessionId: CODEX })).rejects.toThrow(/--verify: row \d+ does not hold the merged run/);
    expect(h.inTransaction).toBe(false);
    h.close();
    expect(finalRows(file)).toEqual(before);
  });

  it('every write asserts its changes: an UPDATE or a DELETE touching fewer rows rolls the batch back', async () => {
    const file = tmpFile('changes.db');
    makeDb(file);
    const before = finalRows(file);
    const h = openOffline(Database, file);
    try {
      // The first run is seq 10..14: keep 10, delete 11..14 in one statement.
      h.exec(`CREATE TEMP TRIGGER skip_delete BEFORE DELETE ON main.session_messages
        WHEN old.session_id = '${CODEX}' AND old.seq = 12 BEGIN SELECT RAISE(IGNORE); END`);
      await expect(compactDatabase(h, { apply: true, sessionId: CODEX })).rejects.toThrow(/DELETE of 4 rows after \d+ changed 3/);
      expect(h.inTransaction).toBe(false);
      h.exec('DROP TRIGGER skip_delete');
      h.exec(`CREATE TEMP TRIGGER skip_update BEFORE UPDATE ON main.session_messages
        WHEN old.session_id = '${CODEX}' AND old.seq = 10 BEGIN SELECT RAISE(IGNORE); END`);
      await expect(compactDatabase(h, { apply: true, sessionId: CODEX })).rejects.toThrow(/UPDATE of row \d+ changed 0 rows/);
      expect(h.inTransaction).toBe(false);
    } finally {
      h.close();
    }
    expect(finalRows(file)).toEqual(before);
  });

  it('a cursor that moves between batches aborts the run (something else writes this database)', async () => {
    const file = tmpFile('cursor.db');
    makeDb(file);
    const h = openOffline(Database, file);
    let error: any;
    try {
      // Bumps last_seen_seq inside the first batch's transaction.
      h.exec(`CREATE TEMP TRIGGER bump AFTER UPDATE OF content ON main.session_messages
        WHEN new.session_id = '${CODEX}' AND new.seq = 10
        BEGIN UPDATE agent_sessions SET last_seen_seq = last_seen_seq + 1 WHERE id = new.session_id; END`);
      error = await compactDatabase(h, { apply: true, batch: 1, sessionId: CODEX }).then(() => null, (e) => e);
      expect(h.inTransaction).toBe(false);
      // Only the batch committed before the check landed.
      expect(thinkingOf(h, CODEX).slice(0, 3)).toEqual([[10, 'Let me look at it'], [17, 'Now'], [18, ' the']]);
    } finally {
      h.close();
    }
    expect(error).toBeInstanceOf(RefusedError);
    expect(error.message).toMatch(/last_seen_seq moved 60 → 61 during the run — is the hub running\?/);
    expect(error.report.sessions).toEqual([expect.objectContaining({ id: CODEX, ops: 1, rowsDeleted: 4, complete: false })]);
    // The committed batch counts in the totals (what --report records); the
    // per-session row counts stay complete-sessions only.
    expect(error.report.batches).toBe(1);
    expect(error.report.totals).toEqual({ sessions: 0, ops: 1, rowsDeleted: 4, rowsBefore: 0, rowsAfter: 0, verified: 0 });
  });

  it('sessions are processed largest first (ties by id), whatever their insertion order', async () => {
    const file = tmpFile('order.db');
    const sized = (id: string, deltas: number): FixtureSession => ({ ...smallSessions(1, deltas)[0], id: id.repeat(32) });
    makeDb(file, [sized('a', 1), sized('b', 3), sized('c', 5), sized('d', 3)]);
    const h = new Database(file, { readonly: true });
    try {
      const r = await compactDatabase(h, {});
      expect(r.sessions.map((s: any) => [s.id[0], s.rowsBefore])).toEqual([['c', 6], ['b', 4], ['d', 4], ['a', 2]]);
    } finally {
      h.close();
    }
  });

  it('a stop raised from an event-loop callback (how SIGINT arrives) is honoured at the next session boundary', async () => {
    const file = tmpFile('macrotask.db');
    makeDb(file, smallSessions(5));
    const h = openOffline(Database, file);
    let stop = false;
    let lines = 0;
    try {
      // Default batch: no session reaches a mid-session commit.
      const r = await compactDatabase(h, {
        apply: true,
        log: () => { if (++lines === 1) setImmediate(() => { stop = true; }); },
        shouldStop: () => stop,
      });
      expect(r.stopped).toBe(true);
      expect(r.sessions.map((s: any) => [s.complete, s.ops])).toEqual([[true, 1]]);
      expect(h.inTransaction).toBe(false);
    } finally {
      h.close();
    }
  });

  it('a recreated agent log (latest seq < MAX(seq)) is planned without its cursor: only seq-NULL runs merge', async () => {
    const EPOCH = 'e90c'.repeat(8);
    const CAUGHT_UP = 'ca7c'.repeat(8);
    const file = tmpFile('epoch.db');
    makeDb(file, [
      {
        // The old log reached 492; the recreated one restarted at 1 below the stale cursor 500.
        id: EPOCH, kind: 'codex', cursor: 500, rows: [
          user('Old', at(0)), thN('f', at(1)), thN('g', at(2)),
          th(490, 'old', at(10)), th(491, ' epoch', at(11)), th(492, ' run', at(12)),
          user('New', at(20)), th(1, 'new', at(21)), th(2, ' epoch', at(22)), th(3, ' run', at(23)),
        ],
      },
      {
        // The new epoch outgrew the old one: the cursor is the new epoch's again.
        id: CAUGHT_UP, kind: 'codex', cursor: 6, rows: [
          user('Old', at(0)), th(1, 'a', at(1)), th(2, 'b', at(2)), th(3, 'c', at(3)),
          user('New', at(10)), ...[1, 2, 3, 4, 5, 6].map((seq) => th(seq, `n${seq}`, at(10 + seq))),
        ],
      },
    ]);
    const lines: string[] = [];
    const h = openOffline(Database, file);
    let r: any;
    try {
      r = await compactDatabase(h, { apply: true, verify: true, log: (l) => lines.push(l) });
      expect(thinkingOf(h, EPOCH)).toEqual([
        [null, 'fg'], [490, 'old'], [491, ' epoch'], [492, ' run'], [1, 'new'], [2, ' epoch'], [3, ' run'],
      ]);
      expect(thinkingOf(h, CAUGHT_UP)).toEqual([[1, 'abc'], [1, 'n1n2n3n4n5n6']]);
    } finally {
      h.close();
    }
    expect(r.sessions.find((s: any) => s.id === EPOCH)).toMatchObject({ cursor: 500, seqEpoch: { latestSeq: 3, maxSeq: 492 }, ops: 1 });
    expect(r.sessions.find((s: any) => s.id === CAUGHT_UP)).toMatchObject({ cursor: 6, seqEpoch: null, ops: 2 });
    expect(lines.filter((l) => /SEQ EPOCH suspect/.test(l))).toEqual([expect.stringContaining(EPOCH)]);
  });

  it('backupDatabase keeps the offline lock: once it returns, another process still cannot write', async () => {
    const file = tmpFile('lock.db');
    makeDb(file);
    const dest = path.join(path.dirname(file), 'lock-backup.db');
    const h = openOffline(Database, file);
    let probe: ReturnType<typeof spawnSync> | null = null;
    try {
      await backupDatabase(h, file, dest);
      // NOTHING in this process may open `file` before close() (the script's INVARIANT).
      probe = spawnSync(process.execPath, ['-e', `
        const D = require(${JSON.stringify(SQLITE_MODULE)});
        try {
          const d = new D(${JSON.stringify(file)}, { timeout: 0 });
          d.prepare("INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, 'user', 'intruder', 1)").run(${JSON.stringify(CODEX)});
          d.close();
          console.log('WROTE');
        } catch (e) { console.log('REFUSED: ' + e.message); }`], { encoding: 'utf8', timeout: 30_000 });
    } finally {
      h.close();
    }
    expect(String(probe?.stdout).trim()).toBe('REFUSED: database is locked');
    expect(sha256(file)).toBe(sha256(dest));
  });

  it('the default cap splits a long run (≤ 256 KiB per row) and rendering stays one bubble', async () => {
    const file = tmpFile('cap.db');
    const big = 'x'.repeat(1000);
    const rows: FixtureRow[] = [user('Long', at(0))];
    for (let seq = 1; seq <= 300; seq++) rows.push(th(seq, big));
    makeDb(file, [{ id: CODEX, kind: 'codex', cursor: 400, rows }]);
    const h = openOffline(Database, file);
    await compactDatabase(h, { apply: true, verify: true });
    const merged = thinkingOf(h, CODEX);
    h.close();
    expect(merged.map(([seq, text]) => [seq, (text as string).length])).toEqual([[1, 262000], [263, 38000]]);
  });
});

// ─── The CLI as the operator runs it ──────────────────────────────────────

describe('CLI (node scripts/compact-thinking.mjs)', () => {
  it('--dry-run writes nothing: same mtime, same PRAGMA data_version, same bytes; it reports the plan', () => {
    const file = tmpFile('dry.db');
    makeDb(file);
    const watcher = new Database(file, { readonly: true });
    try {
      const version = watcher.pragma('data_version', { simple: true });
      const mtime = fs.statSync(file).mtimeMs;
      const sha = sha256(file);
      const report = path.join(path.dirname(file), 'plan.json');
      const r = cli(['--db', file, '--dry-run', '--report', report, '--timings']);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/planned: 21 merges, \d+ rows to delete across 6 sessions/);
      expect(r.out).toMatch(/\[timing\] session /);
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
      expect(watcher.pragma('data_version', { simple: true })).toBe(version);
      expect(sha256(file)).toBe(sha);
      const json = JSON.parse(fs.readFileSync(report, 'utf8'));
      expect(json).toMatchObject({ mode: 'dry-run', ok: true, totals: { ops: 21, sessions: 6 } });
      expect(json.sessions.find((s: any) => s.id === CODEX)).toMatchObject({ cursor: 60, rowsBefore: CODEX_ROWS, ops: 11 });
      expect((fs.statSync(report).mode & 0o777).toString(8)).toBe('600');
    } finally {
      watcher.close();
    }
  });

  it('every writing mode refuses without --offline (exit 2, nothing written)', () => {
    const file = tmpFile('refuse.db');
    makeDb(file);
    const sha = sha256(file);
    const dest = path.join(path.dirname(file), 'backup.db');
    for (const args of [['--apply'], ['--apply', '--verify'], ['--backup-to', dest], ['--vacuum']]) {
      const r = cli(['--db', file, ...args]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/requires --offline/);
    }
    expect(fs.existsSync(dest)).toBe(false);
    expect(sha256(file)).toBe(sha);
    expect(cli(['--offline', '--apply']).code).toBe(2);                     // no --db: never .env
    expect(cli(['--db', path.join(tmpRoot, 'missing.db')]).code).toBe(2);
  });

  it('--offline refuses while another process has the database open (exit 1, nothing written)', () => {
    const file = tmpFile('busy.db');
    makeDb(file);
    const holder = new Database(file);
    try {
      const before = rawRows(holder, CODEX);
      const r = cli(['--db', file, '--offline', '--apply']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/--offline probe failed/);
      expect(rawRows(holder, CODEX)).toEqual(before);
    } finally {
      holder.close();
    }
  });

  it('--offline --apply --verify --batch merges like the in-process run and writes its report', () => {
    const file = tmpFile('apply.db');
    makeDb(file);
    const report = path.join(path.dirname(file), 'apply.json');
    const r = cli(['--db', file, '--offline', '--apply', '--verify', '--batch', '5', '--report', report]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/applied: 21 merges, \d+ rows deleted across 6 sessions .*; 21 merges verified/);
    const h = new Database(file, { readonly: true });
    try {
      expect(thinkingOf(h, CURSOR)).toEqual([[1, 'Plan it out.'], [6, 'Then do it'], [9, ' now']]);
      expect(thinkingOf(h, FORK)).toEqual([[null, 'abc'], [null, 'd'], [3, 'ef'], [null, 'gh']]);
    } finally {
      h.close();
    }
    const json = JSON.parse(fs.readFileSync(report, 'utf8'));
    expect(json).toMatchObject({ mode: 'apply', ok: true, totals: { ops: 21, sessions: 6, verified: 21 } });
    const codex = json.sessions.find((s: any) => s.id === CODEX);
    expect(codex).toMatchObject({ rowsBefore: CODEX_ROWS, ops: 11, complete: true });
    expect(codex.rowsAfter).toBe(CODEX_ROWS - codex.rowsDeleted);
    expect(cli(['--db', file]).out).toMatch(/planned: 0 merges/);   // resumable / idempotent
  });

  it('a failed --apply still reports the batches it committed (totals of the --report JSON)', () => {
    const file = tmpFile('failreport.db');
    makeDb(file);
    // A persistent trigger (the CLI is another process): the first merge moves the cursor.
    let h = new Database(file);
    h.exec(`CREATE TRIGGER bump AFTER UPDATE OF content ON session_messages
      WHEN new.session_id = '${CODEX}' AND new.seq = 10
      BEGIN UPDATE agent_sessions SET last_seen_seq = last_seen_seq + 1 WHERE id = new.session_id; END`);
    h.close();
    const report = path.join(path.dirname(file), 'fail.json');
    const r = cli(['--db', file, '--offline', '--apply', '--batch', '1', '--session', CODEX, '--report', report]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/last_seen_seq moved 60 → 61/);
    const json = JSON.parse(fs.readFileSync(report, 'utf8'));
    expect(json).toMatchObject({ mode: 'apply', ok: false, batches: 1, totals: { sessions: 0, ops: 1, rowsDeleted: 4 } });
    expect(json.error).toMatch(/last_seen_seq moved/);
    h = new Database(file, { readonly: true });
    try {
      expect(thinkingOf(h, CODEX)[0]).toEqual([10, 'Let me look at it']);   // what the totals say landed
    } finally {
      h.close();
    }
  });

  // S1 final review: a backup named `<db>-journal` was verified, then deleted
  // as a hot journal by the database's next open.
  it('--backup-to never names a file of the database (any spelling): refused before any work', () => {
    const file = tmpFile('bguard.db');
    makeDb(file);
    const dir = path.dirname(file);
    const sha = sha256(file);
    const viaLink = path.join(fs.mkdtempSync(path.join(tmpRoot, 'bvia-')), 'dir');
    fs.symlinkSync(dir, viaLink, 'dir');
    for (const dest of [`${file}-journal`, `${file}-shm`, `${file}-wal`, path.join(viaLink, 'bguard.db-journal')]) {
      const r = cli(['--db', file, '--offline', '--backup-to', dest]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--backup-to .* is a file of the database/);
      expect(r.out).toBe('');
    }
    expect(fs.readdirSync(dir).sort()).toEqual(['bguard.db']);
    expect(sha256(file)).toBe(sha);
  });

  it('--report must name a NEW file, none of the database\'s nor the backup\'s: refused before any work', () => {
    const file = tmpFile('guard.db');
    makeDb(file);
    const dir = path.dirname(file);
    const sha = sha256(file);
    const dest = path.join(dir, 'backup.db');
    const viaLink = path.join(fs.mkdtempSync(path.join(tmpRoot, 'via-')), 'dir');
    fs.symlinkSync(dir, viaLink, 'dir');
    try {
      for (const [args, msg] of [
        [['--report', file], /is a file of the database/],                                   // the dry run too
        [['--report', path.join(viaLink, 'guard.db')], /is a file of the database/],
        [['--report', `${file}-wal`], /is a file of the database/],
        [['--report', `${file}-shm`], /is a file of the database/],
        [['--offline', '--vacuum', '--report', file], /is a file of the database/],
        [['--offline', '--apply', '--report', `${file}-journal`], /is a file of the database/],
        [['--offline', '--backup-to', dest, '--report', dest], /is a file of the --backup-to copy/],
        [['--offline', '--backup-to', dest, '--report', `${dest}.part`], /is a file of the --backup-to copy/],
        [['--offline', '--backup-to', path.join(viaLink, 'backup.db'), '--report', dest], /is a file of the --backup-to copy/],
        [['--report', path.join(dir, 'missing', 'r.json')], /--report: no directory/],
      ] as const) {
        const r = cli(['--db', file, ...args]);
        expect(r.code).toBe(2);
        expect(r.err).toMatch(msg);
        expect(r.out).toBe('');                       // nothing ran
      }
      expect(fs.existsSync(dest)).toBe(false);
      expect(fs.readdirSync(dir).sort()).toEqual(['guard.db']);
      expect(sha256(file)).toBe(sha);

      // An existing file (an earlier report, a backup) or a symlink is never overwritten.
      const earlier = path.join(dir, 'earlier.json');
      fs.writeFileSync(earlier, 'earlier run');
      const dangling = path.join(dir, 'dangling.json');
      fs.symlinkSync(path.join(dir, 'nowhere.json'), dangling);
      for (const target of [earlier, dangling]) {
        const r = cli(['--db', file, '--report', target]);
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/exists: a report is never overwritten/);
        expect(r.out).toBe('');
      }
      expect(fs.readFileSync(earlier, 'utf8')).toBe('earlier run');
      expect(fs.existsSync(path.join(dir, 'nowhere.json'))).toBe(false);
    } finally {
      fs.unlinkSync(viaLink);   // the link only
    }
  });

  it('a report target created during the run is not overwritten either (O_EXCL at the final write)', async () => {
    const file = tmpFile('race.db');
    makeDb(file);
    const report = path.join(path.dirname(file), 'race.json');
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['--db', file, '--report', report], {
      out: (l) => { out.push(l); if (/^planned:/.test(l)) fs.writeFileSync(report, 'someone else'); },
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/report: EEXIST/);
    expect(fs.readFileSync(report, 'utf8')).toBe('someone else');
    expect(out.some((l) => /^report:/.test(l))).toBe(false);
  });

  it('Ctrl-C during --offline --apply stops after the current commit, even when no session reaches a batch', async () => {
    // ~1 s of uninterrupted work: the signal lands long before the end (≈ 2 sessions in).
    const N = 2000;
    const file = tmpFile('sigint.db');
    makeDb(file, smallSessions(N));
    const sessionLine = /^5a11\d{28} codex: cursor 100, rows/;
    const child = spawn(process.execPath, [SCRIPT, '--db', file, '--offline', '--apply'], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let sent = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      if (!sent && out.split('\n').some((l) => sessionLine.test(l))) { sent = true; child.kill('SIGINT'); }
    });
    child.stderr.on('data', (d: string) => { err += d; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    expect(sent).toBe(true);
    expect(err).toMatch(/stopping after the current batch/);
    expect(out).toMatch(/STOPPED early: rerun to resume/);
    expect(code).toBe(1);
    const done = out.split('\n').filter((l) => sessionLine.test(l)).length;
    expect(done).toBeGreaterThanOrEqual(1);
    expect(done).toBeLessThan(N);
    // Committed sessions stay merged; the rerun does exactly the rest.
    const rerun = cli(['--db', file, '--offline', '--apply']);
    expect(rerun.code).toBe(0);
    expect(rerun.out).toMatch(new RegExp(`applied: ${N - done} merges, ${2 * (N - done)} rows deleted across ${N} sessions`));
  }, 60_000);

  it('runs through a symlinked path (Node resolves the main module to its real path)', () => {
    const link = path.join(fs.mkdtempSync(path.join(tmpRoot, 'link-')), 'scripts');
    fs.symlinkSync(path.join(REPO, 'scripts'), link, 'dir');
    try {
      const r = spawnSync(process.execPath, [path.join(link, 'compact-thinking.mjs'), '--help'], { encoding: 'utf8', timeout: 60_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage: node scripts/compact-thinking.mjs');
      const bad = spawnSync(process.execPath, [path.join(link, 'compact-thinking.mjs')], { encoding: 'utf8', timeout: 60_000 });
      expect(bad.status).toBe(2);
      expect(bad.stderr).toMatch(/--db <path> is required/);
    } finally {
      fs.unlinkSync(link);   // the link only, never what it points to
    }
  });

  it('--backup-to is byte-exact (sha256, mode 600), folds a crash-left WAL in, and never overwrites', async () => {
    const file = tmpFile('live.db');
    makeDb(file);
    // A writer killed mid-life leaves committed frames in the WAL.
    const writer = spawn(process.execPath, ['-e', `
      const D = require(${JSON.stringify(SQLITE_MODULE)});
      const d = new D(${JSON.stringify(file)});
      d.pragma('wal_autocheckpoint = 0');
      d.prepare("INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, 'user', 'in the wal', 1)").run(${JSON.stringify(CODEX)});
      process.kill(process.pid, 'SIGKILL');`], { stdio: 'ignore' });
    await new Promise((resolve) => writer.on('exit', resolve));
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);

    const dest = path.join(path.dirname(file), 'pre-compact.db');
    const r = cli(['--db', file, '--offline', '--backup-to', dest, '--timings']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const sha = sha256(dest);
    expect(sha256(file)).toBe(sha);
    expect(r.out).toContain(`sha256 copy   ${sha}`);
    expect(r.out).toContain(`sha256 source ${sha}`);
    expect(r.out).toMatch(/quick_check copy: ok/);
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(dest)).filter((f) => f.startsWith('pre-compact'))).toEqual(['pre-compact.db']);
    const copy = new Database(dest, { readonly: true });
    try {
      expect(copy.prepare("SELECT count(*) AS n FROM session_messages WHERE content = 'in the wal'").get()).toEqual({ n: 1 });
    } finally {
      copy.close();
    }
    const again = cli(['--db', file, '--offline', '--backup-to', dest]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/exists: a backup is never overwritten/);
    expect(sha256(dest)).toBe(sha);
  });

  it('--backup-to refuses a WAL the checkpoint did not empty, or a busy checkpoint (nothing copied)', async () => {
    const file = tmpFile('walfull.db');
    makeDb(file);
    const writer = spawn(process.execPath, ['-e', `
      const D = require(${JSON.stringify(SQLITE_MODULE)});
      const d = new D(${JSON.stringify(file)});
      d.pragma('wal_autocheckpoint = 0');
      d.exec("UPDATE agent_sessions SET name = 'wal' WHERE kind = 'codex'");
      process.kill(process.pid, 'SIGKILL');`], { stdio: 'ignore' });
    await new Promise((resolve) => writer.on('exit', resolve));
    const h = openOffline(Database, file);
    try {
      const dest = path.join(path.dirname(file), 'b.db');
      await expect(backupDatabase(h, file, dest, { checkpoint: () => ({ busy: 0, log: 3, checkpointed: 0 }) }))
        .rejects.toThrow(/-wal still holds \d+ bytes after the checkpoint/);
      await expect(backupDatabase(h, file, dest, { checkpoint: () => ({ busy: 1, log: 3, checkpointed: 0 }) }))
        .rejects.toThrow(/busy=1/);
      expect(fs.existsSync(dest)).toBe(false);
      expect(fs.existsSync(`${dest}.part`)).toBe(false);
    } finally {
      h.close();
    }
  });

  it('--backup-to never replaces a destination created DURING the copy, nor removes a `.part` it did not make', async () => {
    const file = tmpFile('race.db');
    makeDb(file);
    const h = openOffline(Database, file);
    try {
      // Created after the existence checks, before the copy (another operator).
      const dest = path.join(path.dirname(file), 'pre-compact.db');
      const err = await backupDatabase(h, file, dest, {
        checkpoint: (d) => { fs.writeFileSync(dest, 'someone else'); return checkpointTruncate(d); },
      }).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(RefusedError);
      const kept = /the verified copy \(sha256 ([0-9a-f]{64})\) is kept as (.*)$/.exec(err.message);
      expect(err.message).toMatch(/appeared during the copy: a backup is never overwritten/);
      expect(kept?.[2]).toBe(`${dest}.part`);
      expect(fs.readFileSync(dest, 'utf8')).toBe('someone else');
      // The verified copy, kept. (Never read the database itself through fs
      // here: closing that descriptor would drop the offline lock.)
      expect(sha256(`${dest}.part`)).toBe(kept?.[1]);
      expect(fs.statSync(`${dest}.part`).mode & 0o777).toBe(0o600);

      // A `.part` someone else made after the checks: the copy refuses it and leaves it.
      const dest2 = path.join(path.dirname(file), 'other.db');
      const err2 = await backupDatabase(h, file, dest2, {
        checkpoint: (d) => { fs.writeFileSync(`${dest2}.part`, 'theirs'); return checkpointTruncate(d); },
      }).then(() => null, (e) => e);
      expect(String(err2?.message)).toMatch(/byte copy failed .*EEXIST/s);
      expect(fs.readFileSync(`${dest2}.part`, 'utf8')).toBe('theirs');
      expect(fs.existsSync(dest2)).toBe(false);

      // The normal path still publishes (and leaves no `.part`).
      const dest3 = path.join(path.dirname(file), 'ok.db');
      const ok = await backupDatabase(h, file, dest3);
      expect(ok.quickCheck).toBe('ok');
      expect(sha256(dest3)).toBe(ok.sha256);
      expect(ok.sha256).toBe(kept?.[1]);                                 // same bytes as the first copy
      expect(fs.existsSync(`${dest3}.part`)).toBe(false);
    } finally {
      h.close();
    }
  });

  it('--vacuum --no-analyze keeps sqlite_stat1; --vacuum re-ANALYZEs; both end clean (freelist 0, every check ran and passed)', () => {
    const file = tmpFile('vac.db');
    makeDb(file);
    let h = new Database(file);
    h.exec('ANALYZE');
    const stat = () => h.prepare('SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx').all();
    // Change the data so a new ANALYZE would write other numbers.
    const ins = h.prepare("INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, 'user', 'x', ?)");
    h.transaction(() => { for (let i = 0; i < 500; i++) ins.run(CLAUDE, i); })();
    h.exec(`DELETE FROM session_messages WHERE session_id = '${CLAUDE}' AND content = 'x' AND ts_ms < 400`);
    const stats = stat();
    h.close();

    const r = cli(['--db', file, '--offline', '--vacuum', '--no-analyze', '--timings']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/quick_check ok; foreign_key_check clean; FTS integrity-check ok/);
    for (const phase of ['vacuum', 'quick_check', 'foreign_key_check', 'fts integrity-check']) {
      expect(r.out).toMatch(new RegExp(`\\[timing\\] ${phase} `));
    }
    expect(r.out).not.toMatch(/\[timing\] analyze/);
    expect(fs.statSync(path.join(path.dirname(file), 'tmp')).isDirectory()).toBe(true);   // created when missing
    h = new Database(file, { readonly: true });
    expect(stat()).toEqual(stats);
    expect(h.pragma('freelist_count', { simple: true })).toBe(0);
    h.close();

    const analyzed = cli(['--db', file, '--offline', '--vacuum']);
    expect(analyzed.code).toBe(0);
    h = new Database(file, { readonly: true });
    expect(stat()).not.toEqual(stats);
    h.close();
  });

  it('--vacuum keeps PRE-EXISTING foreign-key orphans (warned, exit 0, never deleted); one created during the run fails it', () => {
    // Prod carries such orphans (rows of sessions deleted without the cascade).
    const orphan = tmpFile('orphan.db');
    makeDb(orphan);
    let h = new Database(orphan);
    h.pragma('foreign_keys = OFF');
    const insertOrphan = (d: Database.Database, sid: string) => Number(d.prepare(`INSERT INTO session_messages
      (session_id, role, content, ts_ms) VALUES (?, 'user', 'orphan', 1)`).run(sid).lastInsertRowid);
    const old = insertOrphan(h, 'gone');
    h.close();
    const r = cli(['--db', orphan, '--offline', '--vacuum', '--no-analyze']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`warning: foreign_key_check: 1 pre-existing violations, left untouched: `
      + `session_messages → agent_sessions ×1 (rowids ${old})`);
    expect(r.out).toMatch(/quick_check ok; foreign_key_check: no new violation \(1 pre-existing\); FTS integrity-check ok/);
    h = new Database(orphan, { readonly: true });
    expect(h.prepare('SELECT count(*) AS n FROM session_messages WHERE id = ?').get(old)).toEqual({ n: 1 });
    h.close();

    // An orphan the run itself leaves (seam: the checkpoint after VACUUM).
    h = openOffline(Database, orphan);
    try {
      let calls = 0;
      expect(() => vacuumDatabase(h, {
        analyze: false,
        checkpoint: (d) => {
          if (++calls === 2) {
            d.pragma('foreign_keys = OFF');
            insertOrphan(d, 'also-gone');
            d.pragma('foreign_keys = ON');
          }
          return checkpointTruncate(d);
        },
      })).toThrow(/foreign_key_check: 1 NEW violations \(1 pre-existing\), first \{"table":"session_messages","parent":"agent_sessions","fkid":0,"before":1,"after":2,"rowids":\[\d+\]\}/);
    } finally {
      h.close();
    }
  });

  it('--vacuum exits 1 when a check after VACUUM fails: a corrupt FTS index (quick_check)', () => {
    const fts = tmpFile('fts.db');
    makeDb(fts);
    const h = new Database(fts);
    h.unsafeMode(true);   // lifts defensive mode: the FTS shadow tables become writable
    expect(h.prepare(`UPDATE session_messages_fts_content SET c3 = 'tampered'
      WHERE id = (SELECT min(id) FROM session_messages_fts_content)`).run().changes).toBe(1);
    h.unsafeMode(false);
    h.close();
    const r = cli(['--db', fts, '--offline', '--vacuum', '--no-analyze']);
    expect(r.code).toBe(1);
    // SQLite ≥ 3.44's quick_check runs FTS5's own check: the first gate catches it.
    expect(r.err).toMatch(/quick_check: malformed inverted index for FTS5 table main\.session_messages_fts/);
    expect(r.out).not.toMatch(/quick_check ok/);
  });

  // inotify sees every temp file, although SQLite unlinks it right after creating it.
  it.runIf(process.platform === 'linux')('--vacuum spills its temp files into <db dir>/tmp, never into TMPDIR (SQLITE_TMPDIR precedes SQLite\'s init)', async () => {
    const file = tmpFile('spill.db');
    makeDb(file);
    const h = new Database(file);
    // Past better-sqlite3's 16 MB default page cache, VACUUM's temp database spills to a file.
    h.exec(`CREATE TABLE ballast (x BLOB);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 24000)
      INSERT INTO ballast SELECT zeroblob(1000) FROM n`);
    h.close();
    const beside = path.join(path.dirname(file), 'tmp');
    const decoy = fs.mkdtempSync(path.join(tmpRoot, 'tmpdir-'));
    fs.mkdirSync(beside);
    const seen: Record<'beside' | 'decoy', string[]> = { beside: [], decoy: [] };
    const watchers = (['beside', 'decoy'] as const).map((where) =>
      fs.watch(where === 'beside' ? beside : decoy, (_event, name) => { seen[where].push(String(name)); }));
    let code: unknown;
    let err = '';
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: decoy };
      delete env.SQLITE_TMPDIR;
      const child = spawn(process.execPath, [SCRIPT, '--db', file, '--offline', '--vacuum', '--no-analyze'], {
        cwd: REPO, env, stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => { err += d; });
      code = await new Promise((resolve) => child.on('close', resolve));
      await new Promise((resolve) => setTimeout(resolve, 200));   // drain queued inotify events
    } finally {
      for (const w of watchers) w.close();
    }
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(seen.beside.filter((n) => n.startsWith('etilqs_')).length).toBeGreaterThan(0);
    expect(seen.decoy.filter((n) => n.startsWith('etilqs_'))).toEqual([]);
  }, 60_000);
});
