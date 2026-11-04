import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Conversation-only transcript ("tools off", sync refonte C14, CLAUDE.md
// §14.25): `loadMessageWindow(…, view)` counts and returns only conversation
// rows in `conversation`, with the same half-open partition and cursor
// semantics as `full`; the window GET echoes the view, counts tool calls,
// omits the open reasoning block, and fills from compact sources what the
// tool rows used to feed (running tasks' launcher, an empty ExitPlan's plan).

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
const pool = vi.hoisted(() => ({
  client: {
    setAfterSeq: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    resubscribe: () => {},
    call: async (..._args: any[]): Promise<any> => ({ ok: true, status: 'active' }),
  },
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => pool.client,
  getAgentClient: () => pool.client,
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

type View = 'full' | 'conversation';
type Row = {
  id: number; role: string; content: string; tsMs: number | null; createdAt: number;
  model: string | null; assistantFinal: number | null;
};
type Page = { messages: Row[]; hasMore: boolean; oldestChatId: number | null };

const VPS = 'views-vps';
let db: any;
let schema: any;
let rawSqlite: () => import('better-sqlite3').Database;
let loadMessageWindow: (sid: string, limit: number, before: number | null, view?: View) => Page;
let deriveMessageStorage: (role: string, content: string) => Record<string, unknown>;
let rebuildStateFromMessages: typeof import('@/app/sessionRebuild').rebuildStateFromMessages;
let shouldShowChatRole: typeof import('@/app/chatVisibility').shouldShowChatRole;
let rows: typeof import('@/lib/transcriptRows');
let getOrCreateStream: any;

let counter = 0;
let clock = Date.now() - 86_400_000;   // a day ago, 1 s per row

function newSession(kind = 'claude'): string {
  const id = (++counter).toString(16).padStart(32, 'a');
  db.insert(schema.agentSessions).values({ id, vpsId: VPS, cwd: '/tmp', name: 'v', status: 'sleeping', kind }).run();
  return id;
}

/** Persist one row the way `_persist` does (wire/snapshot columns derived). */
function add(sid: string, role: string, content: unknown, extra: Record<string, unknown> = {}): number {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  clock += 1000;
  return Number(db.insert(schema.sessionMessages).values({
    sessionId: sid, role, content: text, ...deriveMessageStorage(role, text), tsMs: clock, ...extra,
  }).run().lastInsertRowid);
}

const ev = (sid: string, event: Record<string, unknown>) => add(sid, 'event', event);
const toolUse = (sid: string, id: string, name = 'Read', input: unknown = { file_path: '/x' }) =>
  add(sid, 'tool_use', { type: 'tool_use', id, name, input });
const toolResult = (sid: string, id: string, content = 'ok') =>
  add(sid, 'tool_result', { type: 'tool_result', tool_use_id: id, content, is_error: false });
const snapshot = (sid: string, file: string, phase: string, body: string) =>
  add(sid, 'edit_snapshot', { type: 'edit_snapshot', file_path: file, phase, tool_use_id: 'e', content: body });

function eventType(r: Row): string | null {
  if (r.role !== 'event') return null;
  try { return JSON.parse(r.content)?.type ?? null; } catch { return null; }
}
function isTechnical(r: Row): boolean {
  return (rows.TECHNICAL_ROLES as readonly string[]).includes(r.role)
    || (r.role === 'event' && !(rows.CONVERSATION_EVENT_TYPES as readonly string[]).includes(eventType(r) ?? ''));
}
/** The rows a view carries (JS mirror of messageWindow's predicates). */
function carried(r: Row, view: View): boolean {
  if (r.role === 'edit_snapshot') return false;
  if (view === 'full') return true;
  return rows.isConversationSlotRole(r.role)
    || (r.role === 'event' && (rows.CONVERSATION_EVENT_TYPES as readonly string[]).includes(eventType(r) ?? ''));
}
const key = (r: Row) => r.tsMs ?? r.createdAt * 1000;
const chrono = (a: Row, b: Row) => (key(a) - key(b)) || (a.id - b.id);

/** Every page of a view, oldest first (newest page = last). */
function allPages(sid: string, view: View, limit: number, before: number | null = null): Page[] {
  const pages: Page[] = [];
  for (let i = 0; i < 10_000; i++) {
    const p = loadMessageWindow(sid, limit, before, view);
    pages.unshift(p);
    if (!p.hasMore) break;
    before = p.oldestChatId;
  }
  return pages;
}
const chatOf = (pages: Page[]) => pages.flatMap((p) => p.messages).filter((m) => m.role !== 'edit_snapshot');
function allRows(sid: string): Row[] {
  return db.select().from(schema.sessionMessages).all()
    .filter((r: any) => r.sessionId === sid).sort(chrono);
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  rawSqlite = dbMod.rawSqlite;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS, name: 'v', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ({ loadMessageWindow } = await import('@/lib/server/hub/messageWindow') as any);
  ({ deriveMessageStorage } = await import('@/lib/server/hub/messageWire') as any);
  ({ rebuildStateFromMessages } = await import('@/app/sessionRebuild'));
  ({ shouldShowChatRole } = await import('@/app/chatVisibility'));
  rows = await import('@/lib/transcriptRows');
  ({ getOrCreateStream } = await import('@/lib/server/agent/sessionOps'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadMessageWindow — conversation view', () => {
  it('counts only conversation slots and ships no technical row', () => {
    const sid = newSession();
    add(sid, 'user', 'first');
    for (let i = 0; i < 30; i++) {
      toolUse(sid, `t${i}`);
      toolResult(sid, `t${i}`);
      ev(sid, { type: 'thinking', text: `hmm ${i}` });
    }
    add(sid, 'assistant', 'middle', { assistantFinal: 0 });
    add(sid, 'thinking', 'legacy thinking role');
    add(sid, 'user_question', JSON.stringify({ type: 'user_question', id: 'q', questions: [] }));
    add(sid, 'assistant', 'last', { assistantFinal: 1 });

    const conv = loadMessageWindow(sid, 2, null, 'conversation');
    expect(conv.messages.map((m) => m.content)).toEqual(['middle', 'last']);
    expect(conv.hasMore).toBe(true);
    const older = loadMessageWindow(sid, 2, conv.oldestChatId, 'conversation');
    expect(older.messages.map((m) => m.content)).toEqual(['first']);
    expect(older.hasMore).toBe(false);

    const full = loadMessageWindow(sid, 2, null, 'full');
    expect(full.messages.map((m) => m.role)).toEqual(['user_question', 'assistant']);
  });

  it('10 k tool/thinking rows between two user turns return 0 of them', () => {
    const sid = newSession('codex');
    add(sid, 'user', 'turn 1');
    add(sid, 'assistant', 'answer 1', { assistantFinal: 1 });
    const ins = rawSqlite().prepare(
      'INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, ?, ?, ?)');
    const kinds: Array<[string, string]> = [
      ['tool_use', JSON.stringify({ type: 'tool_use', id: 'x', name: 'Read', input: {} })],
      ['tool_result', JSON.stringify({ type: 'tool_result', tool_use_id: 'x', content: 'r' })],
      ['event', JSON.stringify({ type: 'thinking', text: 'delta' })],
      ['event', JSON.stringify({ type: 'plan_update', id: 'p', plan: [] })],
      ['event', JSON.stringify({ type: 'tool_activity', name: 'Read' })],
    ];
    rawSqlite().transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const [role, content] = kinds[i % kinds.length];
        clock += 1;
        ins.run(sid, role, content, clock);
      }
    })();
    add(sid, 'user', 'turn 2');
    add(sid, 'assistant', 'answer 2', { assistantFinal: 1 });

    const conv = loadMessageWindow(sid, 200, null, 'conversation');
    expect(conv.messages.map((m) => m.content)).toEqual(['turn 1', 'answer 1', 'turn 2', 'answer 2']);
    expect(conv.hasMore).toBe(false);
    const full = loadMessageWindow(sid, 200, null, 'full');
    expect(full.messages.filter((m) => m.role !== 'event')).toHaveLength(200);   // the full view is all tools
    expect(full.hasMore).toBe(true);
  });

  it('conversation event types ride with the page that owns them; other events never', () => {
    const sid = newSession('codex');
    ev(sid, { type: 'fork_point', fromName: 'origin', fromId: 'o' });          // leading → oldest page
    add(sid, 'user', 'c1');
    add(sid, 'assistant', 'c2');
    ev(sid, { type: 'compaction', trigger: 'auto' });
    add(sid, 'user', 'c3');
    add(sid, 'assistant', 'c4');
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'b1' });
    ev(sid, { type: 'thinking', text: 'no' });
    toolUse(sid, 'between');
    add(sid, 'user', 'c5');
    add(sid, 'assistant', 'c6');
    ev(sid, { type: 'external_message', text: 'peer', origin: 'charon_peer', messageId: 'pm' });
    ev(sid, { type: 'plan_update', id: 'p1', plan: [] });
    ev(sid, { type: 'turn_usage', provider: 'codex' });
    add(sid, 'event', '{"type":"compaction" broken');                          // malformed: never shipped
    ev(sid, { type: 'interaction_resolved', kind: 'question', id: 'q', outcome: 'answered' });

    const [p3, p2, p1] = allPages(sid, 'conversation', 2);
    const label = (m: Row) => (m.role === 'event' ? eventType(m) ?? 'malformed' : m.content);
    expect(p3.messages.map(label)).toEqual(['fork_point', 'c1', 'c2', 'compaction']);
    expect(p2.messages.map(label)).toEqual(['c3', 'c4', 'bg_task']);
    expect(p1.messages.map(label)).toEqual(['c5', 'c6', 'external_message', 'interaction_resolved']);
  });

  it('pages tile with no gap and no duplicate in BOTH views, repaired and tied rows included', () => {
    const sid = newSession('codex');
    let seed = 7;
    let toolN = 0;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const makers: Array<() => void> = [
      () => add(sid, 'user', 'u'),
      () => add(sid, 'assistant', 'a', { assistantFinal: rnd() < 0.5 ? 0 : 1 }),
      () => toolUse(sid, `t${toolN++}`),
      () => toolResult(sid, 't'),
      () => ev(sid, { type: 'thinking', text: 'th' }),
      () => ev(sid, { type: 'bg_task', kind: 'started', taskId: 'x' }),
      () => ev(sid, { type: 'compaction', trigger: 'manual' }),
      () => ev(sid, { type: 'tool_activity' }),
      () => ev(sid, { type: 'external_message', text: 'e' }),
      () => add(sid, 'event', 'not json'),
      () => snapshot(sid, `/f${Math.floor(rnd() * 3)}`, rnd() < 0.5 ? 'before' : 'after', 'body'),
      () => add(sid, 'async_question', JSON.stringify({ id: 'aq', questions: [] })),
      () => add(sid, 'error', 'boom'),
      () => add(sid, 'exit_plan_request', JSON.stringify({ id: 'xp', plan: '' })),
      () => add(sid, 'thinking', 'legacy'),
    ];
    for (let i = 0; i < 400; i++) makers[Math.floor(rnd() * makers.length)]();
    // Ties: several rows sharing one ts (ordered by id), and two REPAIRED rows
    // (inserted last, dated early) that must sort back into their place.
    const tie = clock + 1;
    for (const r of ['user', 'assistant', 'event']) {
      add(sid, r, r === 'event' ? JSON.stringify({ type: 'compaction' }) : 'tie', { tsMs: tie });
    }
    const early = allRows(sid)[40].tsMs! + 1;
    add(sid, 'assistant', 'repaired', { tsMs: early });
    // A finish with no `started` anywhere: never pruned (older conversation
    // pages drop only tasks they both launch and settle — tested below).
    add(sid, 'event', JSON.stringify({ type: 'bg_task', kind: 'finished', taskId: 'y' }), { tsMs: early });

    const everything = allRows(sid);
    for (const view of ['full', 'conversation'] as View[]) {
      const expected = everything.filter((r) => carried(r, view)).map((r) => r.id);
      for (const limit of [1, 3, 7, 50, 1000]) {
        const pages = allPages(sid, view, limit);
        const got = chatOf(pages).map((r) => r.id);
        expect(got, `${view} limit ${limit}`).toEqual(expected);
        if (view === 'conversation') expect(chatOf(pages).some(isTechnical)).toBe(false);
        for (const p of pages.slice(0, -1)) {
          expect(p.messages.some((m) => m.role === 'edit_snapshot')).toBe(false);
        }
      }
    }
  });

  it('a `before` cursor from a conversation page is valid in both views', () => {
    const sid = newSession();
    for (let i = 0; i < 12; i++) {
      add(sid, 'user', `u${i}`);
      toolUse(sid, `t${i}`);
      toolResult(sid, `t${i}`);
      add(sid, 'assistant', `a${i}`);
    }
    const p1 = loadMessageWindow(sid, 5, null, 'conversation');
    const cursor = p1.oldestChatId!;
    const cursorRow = allRows(sid).find((r) => r.id === cursor)!;
    expect(rows.isConversationSlotRole(cursorRow.role)).toBe(true);

    // Full view from that cursor: exactly the full history strictly before it.
    const fullHistory = chatOf(allPages(sid, 'full', 4));
    const olderFull = chatOf(allPages(sid, 'full', 4, cursor));
    const at = fullHistory.findIndex((r) => r.id === cursor);
    expect(olderFull.map((r) => r.id)).toEqual(fullHistory.slice(0, at).map((r) => r.id));
    // Conversation view from it: the conversation history before it.
    const convHistory = chatOf(allPages(sid, 'conversation', 3));
    const olderConv = chatOf(allPages(sid, 'conversation', 3, cursor));
    const cAt = convHistory.findIndex((r) => r.id === cursor);
    expect(olderConv.map((r) => r.id)).toEqual(convHistory.slice(0, cAt).map((r) => r.id));
    // A full-view cursor (a tool row) positions the conversation view too.
    const toolCursor = loadMessageWindow(sid, 6, null, 'full').oldestChatId!;
    const toolRow = allRows(sid).find((r) => r.id === toolCursor)!;
    const olderOfTool = chatOf(allPages(sid, 'conversation', 3, toolCursor));
    expect(olderOfTool.length).toBeGreaterThan(0);
    expect(olderOfTool.every((r) => chrono(r, toolRow) < 0)).toBe(true);
    expect(olderOfTool.map((r) => r.id)).toEqual(
      convHistory.filter((r) => chrono(r, toolRow) < 0).map((r) => r.id));
  });

  it('latest edit metadata rides on the NEWEST page in both views (the files panel)', () => {
    const sid = newSession();
    for (let i = 0; i < 6; i++) {
      add(sid, 'user', `u${i}`);
      snapshot(sid, '/a.ts', 'before', 'x'.repeat(5_000));
      snapshot(sid, '/a.ts', 'after', 'y'.repeat(5_000));
      add(sid, 'assistant', `a${i}`);
    }
    for (const view of ['full', 'conversation'] as View[]) {
      const [older, newest] = allPages(sid, view, 6);
      const snaps = newest.messages.filter((m) => m.role === 'edit_snapshot');
      expect(snaps).toHaveLength(2);
      expect(snaps.every((m) => !m.content.includes('yyyy'))).toBe(true);           // metadata only
      expect(older.messages.some((m) => m.role === 'edit_snapshot')).toBe(false);
    }
  });

  it('an OLDER conversation page drops the bg_task rows of tasks it both launches and settles (smoke: 7.7 MB pages)', () => {
    const sid = newSession();
    add(sid, 'user', 'old-1');
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'cross', toolUseId: 'L0' });  // settles on the next page
    for (let i = 0; i < 50; i++) {
      ev(sid, { type: 'bg_task', kind: 'started', taskId: `done-${i}`, toolUseId: `L${i + 1}` });
      ev(sid, { type: 'bg_task', kind: 'finished', taskId: `done-${i}`, status: 'completed', terminal: true });
    }
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'open', toolUseId: 'Lopen' });   // still running
    ev(sid, { type: 'bg_task', kind: 'finished', taskId: 'orphan', status: 'completed' }); // its start is older
    add(sid, 'assistant', 'old-2', { assistantFinal: 1 });
    const newest = add(sid, 'user', 'new-1');
    ev(sid, { type: 'bg_task', kind: 'finished', taskId: 'cross', status: 'completed', terminal: true });
    add(sid, 'assistant', 'new-2', { assistantFinal: 1 });

    const ids = (p: Page) => p.messages.filter((m) => eventType(m) === 'bg_task')
      .map((m) => JSON.parse(m.content).taskId as string);
    const older = loadMessageWindow(sid, 2, newest, 'conversation');
    expect(older.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.content))
      .toEqual(['old-1', 'old-2']);
    expect(ids(older)).toEqual(['cross', 'open', 'orphan']);
    // The full view and the root window are untouched.
    expect(ids(loadMessageWindow(sid, 2, newest, 'full'))).toHaveLength(103);
    expect(ids(loadMessageWindow(sid, 2, null, 'conversation'))).toEqual(['cross']);
  });

  it('side-channel-only session: the bounded tail carries no technical row in conversation view', () => {
    const sid = newSession('codex');
    ev(sid, { type: 'thinking', text: 'a' });
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'b' });
    ev(sid, { type: 'tool_activity' });
    ev(sid, { type: 'bg_task', kind: 'finished', taskId: 'b' });
    const conv = loadMessageWindow(sid, 10, null, 'conversation');
    expect(conv.messages.map(eventType)).toEqual(['bg_task', 'bg_task']);
    expect(conv.oldestChatId).toBeNull();
    const full = loadMessageWindow(sid, 10, null, 'full');
    expect(full.messages).toHaveLength(4);                                          // unchanged
  });
});

describe('keyset pages seek a chronological RANGE (EXPLAIN, both views)', () => {
  /** Run `fn` and return the plan of every chronological message query it
   *  prepared, with the exact parameters it bound. */
  function capturePlans(fn: () => void): Array<{ sql: string; plan: string[] }> {
    const sqlite = rawSqlite();
    const realPrepare = sqlite.prepare.bind(sqlite);
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const spy = vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
      const stmt: any = realPrepare(source);
      if (!/order by coalesce\("session_messages"\."ts_ms"/i.test(source)) return stmt;
      for (const m of ['all', 'get'] as const) {
        const orig = stmt[m].bind(stmt);
        stmt[m] = (...params: unknown[]) => { captured.push({ sql: source, params }); return orig(...params); };
      }
      return stmt;
    }) as any);
    try { fn(); } finally { spy.mockRestore(); }
    return captured.map((c) => ({
      sql: c.sql,
      plan: realPrepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(...c.params).map((r: any) => String(r.detail)),
    }));
  }

  /** A paged query never sorts, never splits the OR, and seeks the chrono
   *  index by a `<expr>` RANGE (the cursor), not by `session_id` alone. */
  function expectRangeSeek(q: { sql: string; plan: string[] }): void {
    const text = q.plan.join('\n');
    expect(text, q.sql).not.toMatch(/TEMP B-TREE|MULTI-INDEX|SCAN /);
    expect(text, q.sql).toMatch(
      /SEARCH session_messages USING INDEX idx_session_messages_session_chrono_id \(session_id=\? AND <expr>[<>]\?/);
  }

  let sid = '';
  function seed(): string {
    if (sid) return sid;
    sid = newSession();
    for (let turn = 0; turn < 120; turn++) {
      add(sid, 'user', `question ${turn}`);
      for (let t = 0; t < 4; t++) {
        toolUse(sid, `k${turn}-${t}`);
        toolResult(sid, `k${turn}-${t}`);
      }
      ev(sid, { type: 'thinking', text: 'hmm' });
      add(sid, 'assistant', `answer ${turn}`);
    }
    return sid;
  }

  function checkEveryPagedQuery(): void {
    const s = seed();
    for (const view of ['full', 'conversation'] as const) {
      const root = loadMessageWindow(s, 20, null, view);
      expect(root.hasMore).toBe(true);
      // Mid-history `?before=` page: the chat query (DESC) and the window
      // query (ASC, both bounds) must both be range seeks.
      const mid = allPages(s, view, 20).at(-4)!;
      const qs = capturePlans(() => { loadMessageWindow(s, 20, mid.oldestChatId, view); });
      expect(qs.length).toBeGreaterThanOrEqual(2);
      for (const q of qs) expectRangeSeek(q);
      // The root window query (lower bound only) too.
      const rootQs = capturePlans(() => { loadMessageWindow(s, 20, null, view); });
      const windowQ = rootQs.filter((q) => /order by coalesce\("session_messages"\."ts_ms".*\) asc/i.test(q.sql));
      expect(windowQ).toHaveLength(1);
      expectRangeSeek(windowQ[0]);
    }
  }

  it('without planner statistics', () => {
    checkEveryPagedQuery();
  });

  it('under production planner statistics (sqlite_stat1)', () => {
    const sqlite = rawSqlite();
    seed();
    sqlite.exec('ANALYZE');
    try {
      sqlite.exec("DELETE FROM sqlite_stat1 WHERE tbl = 'session_messages'");
      const ins = sqlite.prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('session_messages', ?, ?)");
      // Production values (same copy as peerReplyContext.test.ts).
      for (const [idx, stat] of [
        ['idx_session_messages_session_chrono_id', '347576 11986 1 1'],
        ['idx_session_messages_snapshot_lookup', '347576 11986 2159 96 53 1'],
        ['idx_session_messages_session_seq', '347576 11986 1'],
        ['idx_session_messages_session_ts_id', '347576 11986 1 1'],
        ['idx_session_messages_session_id_id', '347576 11986 1'],
      ]) ins.run(idx, stat);
      sqlite.exec('ANALYZE sqlite_schema');
      checkEveryPagedQuery();
    } finally {
      sqlite.exec('DELETE FROM sqlite_stat1');
      try { sqlite.exec('DELETE FROM sqlite_stat4'); } catch { /* not compiled in */ }
      sqlite.exec('ANALYZE sqlite_schema');
    }
  });

  it('with a full ANALYZE of the fixture', () => {
    const sqlite = rawSqlite();
    seed();
    sqlite.exec('ANALYZE');
    try {
      checkEveryPagedQuery();
    } finally {
      sqlite.exec('DELETE FROM sqlite_stat1');
      try { sqlite.exec('DELETE FROM sqlite_stat4'); } catch { /* not compiled in */ }
      sqlite.exec('ANALYZE sqlite_schema');
    }
  });
});

describe('render property: rebuild(conversation) ≡ rebuild(full) without technical rows', () => {
  function fixture(withRenderNull: boolean): string {
    const sid = newSession('codex');
    ev(sid, { type: 'fork_point', fromName: 'parent', fromId: 'p' });
    add(sid, 'user', 'please look');
    ev(sid, { type: 'thinking', text: 'Let me ' });
    ev(sid, { type: 'thinking', text: 'look.' });
    add(sid, 'thinking', 'a legacy thinking row');
    toolUse(sid, 't1', 'Read', { file_path: '/a.ts' });
    toolResult(sid, 't1', 'file body');
    snapshot(sid, '/a.ts', 'before', 'old');
    snapshot(sid, '/a.ts', 'after', 'new');
    add(sid, 'assistant', 'reading', { assistantFinal: 0, model: 'gpt-x' });
    toolUse(sid, 't2', 'Bash', { command: 'sleep 9', run_in_background: true, description: 'nap' });
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'bg', toolUseId: 't2' });
    ev(sid, { type: 'plan_update', id: 'plan-1', plan: [{ step: 'a', status: 'pending' }] });
    ev(sid, { type: 'plan_update', id: 'plan-1', plan: [{ step: 'a', status: 'completed' }] });
    add(sid, 'assistant', 'done', { assistantFinal: 1, model: 'gpt-x' });
    ev(sid, { type: 'turn_usage', provider: 'codex', inputTokens: 1 });
    add(sid, 'async_question', JSON.stringify({ id: 'aq1', questions: [{ question: 'Which?' }] }));
    add(sid, 'async_question', JSON.stringify({ id: 'aq2', questions: [{ question: 'Why?' }] }));
    ev(sid, { type: 'interaction_resolved', kind: 'question', id: 'aq1', outcome: 'answered', answers: { 'Which?': 'that' } });
    if (withRenderNull) {
      add(sid, 'user_question', JSON.stringify({ type: 'user_question', id: 'uq', questions: [] }));
      add(sid, 'exit_plan_request', JSON.stringify({ type: 'exit_plan_request', id: 'xp', plan: '' }));
    }
    ev(sid, { type: 'external_message', text: 'peer asks', from: 'other', origin: 'charon_peer',
      sourceSessionId: 's2', messageId: 'pm1', expectsReply: true });
    ev(sid, { type: 'thinking', text: 'peer thought' });
    add(sid, 'assistant', 'peer answer', { assistantFinal: 1 });
    ev(sid, { type: 'peer_message_status', messageId: 'pm2', status: 'accepted', target: 'x', text: 'sent' });
    toolUse(sid, 't3', 'Edit', { file_path: '/b.ts' });
    ev(sid, { type: 'peer_message_status', messageId: 'pm2', status: 'replied', target: 'x', text: 'answered' });
    ev(sid, { type: 'compaction', trigger: 'auto' });
    ev(sid, { type: 'structured_output', value: { ok: true } });
    ev(sid, { type: 'tool_activity', name: 'Read' });
    add(sid, 'error', 'turn failed');
    add(sid, 'scheduled_resume', JSON.stringify({ runAt: 1 }));
    add(sid, 'user', 'thanks');
    ev(sid, { type: 'thinking', text: 'open-ish' });
    return sid;
  }

  const rebuild = (list: Row[]) => rebuildStateFromMessages(
    list.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt,
      model: m.model, assistantFinal: m.assistantFinal })), 'sleeping', 'codex').messages;

  for (const limit of [3, 1000]) {
    it(`spec predicate, no render-null rows (limit ${limit})`, () => {
      const sid = fixture(false);
      const conv = rebuild(chatOf(allPages(sid, 'conversation', limit)));
      const full = rebuild(chatOf(allPages(sid, 'full', limit)));
      expect(full.some((m) => !shouldShowChatRole(m.role, false))).toBe(true);    // the fixture has tool rows
      expect(conv).toEqual(full.filter((m) => shouldShowChatRole(m.role, false)));
      expect(conv.map((m) => m.role)).toEqual(expect.arrayContaining(
        ['forkpoint', 'user', 'assistant', 'async_question', 'external', 'peer_status', 'compaction', 'structured', 'error']));
    });

    it(`rendered predicate, blocking question and ExitPlan rows included (limit ${limit})`, () => {
      const sid = fixture(true);
      const conv = rebuild(chatOf(allPages(sid, 'conversation', limit)));
      const full = rebuild(chatOf(allPages(sid, 'full', limit)));
      // user_question/exit_plan_request render null (Message.tsx) in both views.
      const rendered = (m: { role: string }) => shouldShowChatRole(m.role, false)
        && !(rows.RENDER_NULL_ROLES as readonly string[]).includes(m.role);
      expect(full.some((m) => (rows.RENDER_NULL_ROLES as readonly string[]).includes(m.role))).toBe(true);
      expect(conv).toEqual(full.filter(rendered));
    });
  }
});

describe('window GET — view, toolCallCount, compact sources', () => {
  const get = async (sid: string, query = '') => {
    const { GET } = await import('@/app/api/sessions/[id]/route');
    return (await GET(new Request(`http://localhost/api/sessions/${sid}${query}`),
      { params: Promise.resolve({ id: sid }) })).json();
  };
  /** SQL prepared on the shared handle while `fn` runs. */
  async function preparedDuring(fn: () => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const handle = rawSqlite();
    const real = handle.prepare.bind(handle);
    const spy = vi.spyOn(handle, 'prepare').mockImplementation(((source: string) => {
      seen.push(source);
      return real(source);
    }) as any);
    try { await fn(); } finally { spy.mockRestore(); }
    return seen;
  }
  const LAUNCHER_SEEK = /json_extract\(wc, '\$\.id'\)/;

  it('echoes the view, counts every tool call of the session and ships no technical row', async () => {
    const sid = newSession();
    for (let i = 0; i < 7; i++) { toolUse(sid, `t${i}`); toolResult(sid, `t${i}`); }
    for (let i = 0; i < 5; i++) { add(sid, 'user', `u${i}`); add(sid, 'assistant', `a${i}`); }
    const conv = await get(sid, '?open=1&limit=4&view=conversation');
    expect(conv.view).toBe('conversation');
    expect(conv.toolCallCount).toBe(7);
    expect(conv.messages.map((m: any) => m.content)).toEqual(['u3', 'a3', 'u4', 'a4']);
    const full = await get(sid, '?open=1&limit=4');
    expect(full.view).toBe('full');
    expect(full.toolCallCount).toBe(7);
    expect((await get(sid, '?open=1&view=bogus')).view).toBe('full');
    // The legacy delta poll's envelope is unchanged (and always full).
    const delta = await get(sid, '?open=1&since=0&view=conversation');
    expect('view' in delta || 'toolCallCount' in delta).toBe(false);
    expect(delta.messages.some((m: any) => m.role === 'tool_use')).toBe(true);
    // `before` stays LEAN (C03 contract) and honours the view.
    const older = await get(sid, `?before=${conv.oldestChatId}&limit=2&view=conversation`);
    expect(Object.keys(older).sort()).toEqual(['hasMore', 'messages', 'oldestChatId', 'sync']);
    expect(older.messages.map((m: any) => m.content)).toEqual(['u2', 'a2']);
  });

  it('omits the open reasoning block in conversation view only', async () => {
    const sid = newSession('codex');
    db.update(schema.agentSessions).set({ status: 'active' }).where(eq(schema.agentSessions.id, sid)).run();
    add(sid, 'user', 'go');
    const s = getOrCreateStream(sid);
    const t = Date.now();
    s._onAgentEvent({ event: 'thinking', session_id: sid, seq: 1, ts: t / 1000, text: 'still ' });
    s._onAgentEvent({ event: 'thinking', session_id: sid, seq: 2, ts: (t + 1) / 1000, text: 'thinking' });
    const full = await get(sid, '?open=1');
    expect(full.streamingThinking).toBe('still thinking');
    const conv = await get(sid, '?open=1&view=conversation');
    expect('streamingThinking' in conv).toBe(false);
    expect('streamingThinkingTsMs' in conv).toBe(false);
    // An old bundle (no open=1) asking for conversation gets no synthetic row either.
    const legacy = await get(sid, '?view=conversation');
    expect(legacy.messages.some((m: any) => m.id === -1)).toBe(false);
    s._onAgentEvent({ event: 'tool_use', session_id: sid, seq: 3, ts: (t + 2) / 1000, id: 'z', name: 'Read', input: {} });
  });

  it('a RUNNING task gets its launcher command/description in conversation view; finished ones look nothing up', async () => {
    const sid = newSession();
    add(sid, 'user', 'start the server');
    toolUse(sid, 'L1', 'Bash', { command: 'npm run dev', run_in_background: true, description: 'dev server' });
    for (let i = 0; i < 10; i++) toolUse(sid, `noise${i}`);   // parallel calls between launcher and start
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'task-1', toolUseId: 'L1' });
    // A sub-agent launcher is not a command (the rebuild ignores it too).
    toolUse(sid, 'L2', 'Task', { description: 'explore', prompt: 'look around' });
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'task-2', toolUseId: 'L2', description: 'explorer' });
    for (let i = 0; i < 40; i++) { add(sid, 'user', `later ${i}`); toolUse(sid, `later${i}`); }
    const seen: any[] = [];
    const sqls = await preparedDuring(async () => { seen.push(await get(sid, '?open=1&limit=10&view=conversation')); });
    const [win] = seen;
    expect(win.messages.some((m: any) => m.role === 'tool_use')).toBe(false);   // the launcher is far back
    const byId = new Map(win.backgroundTasks.map((t: any) => [t.taskId, t]));
    expect(byId.get('task-1')).toMatchObject({ command: 'npm run dev', description: 'dev server', status: 'running' });
    expect(byId.get('task-2')).toMatchObject({ command: null, description: 'explorer' });
    expect(sqls.filter((q) => LAUNCHER_SEEK.test(q))).toHaveLength(2);           // one bounded seek per running task

    // Finished tasks: no launcher lookup at all.
    const done = newSession();
    toolUse(done, 'L3', 'Bash', { command: 'make', run_in_background: true });
    ev(done, { type: 'bg_task', kind: 'started', taskId: 'task-3', toolUseId: 'L3' });
    ev(done, { type: 'bg_task', kind: 'finished', taskId: 'task-3', status: 'completed' });
    add(done, 'user', 'hi');
    const doneSql = await preparedDuring(async () => { seen.push(await get(done, '?open=1&view=conversation')); });
    expect(seen[1].backgroundTasks).toEqual([]);
    expect(doneSql.filter((q) => LAUNCHER_SEEK.test(q))).toEqual([]);
  });

  it('a COLD registry: the warm bg_tasks_snapshot carries the launcher fields the window GET deferred', async () => {
    const sid = newSession();
    add(sid, 'user', 'start the server');
    toolUse(sid, 'LW', 'Bash', { command: 'npm run dev', run_in_background: true, description: 'dev server' });
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'srv', toolUseId: 'LW', description: 'dev server' });
    // More session rows than one synchronous fold slice: the first reader
    // finds the registry cold and the fold warms in the background.
    const filler = rawSqlite().prepare(
      "INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, 'event', '{\"type\":\"tool_activity\"}', ?)");
    rawSqlite().transaction(() => {
      for (let i = 0; i < 20_500; i++) filler.run(sid, (clock += 1));
    })();
    add(sid, 'assistant', 'it is up');
    const { subscribeGlobalSessionEvents } = await import('@/lib/server/agent/sessionOps');
    const snapshots: any[] = [];
    const off = subscribeGlobalSessionEvents((e: any) => {
      if (e.type === 'bg_tasks_snapshot' && e.sessionId === sid) snapshots.push(e);
    });
    try {
      const win = await get(sid, '?open=1&view=conversation');
      expect(win.backgroundTasksPending).toBe(true);
      expect(win.messages.some((m: any) => m.role === 'tool_use')).toBe(false);
      await vi.waitFor(() => expect(snapshots).toHaveLength(1), { timeout: 5_000 });
      expect(snapshots[0].tasks).toEqual([expect.objectContaining({
        taskId: 'srv', command: 'npm run dev', description: 'dev server', toolUseId: 'LW', status: 'running',
      })]);
    } finally {
      off();
    }
  });

  it('a launcher beyond the bounded seek is not found (the task keeps its own fields)', async () => {
    const sid = newSession();
    toolUse(sid, 'FAR', 'Bash', { command: 'far away', run_in_background: true });
    for (let i = 0; i < 60; i++) toolUse(sid, `n${i}`);
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'far', toolUseId: 'FAR', description: 'own' });
    add(sid, 'user', 'x');
    const win = await get(sid, '?open=1&view=conversation');
    expect(win.backgroundTasks).toEqual([expect.objectContaining({ taskId: 'far', command: null, description: 'own' })]);
  });

  // Integration (wave 1): the bg registry fold keeps the reduced registry, not
  // its rows, so the seek origin is the fold's launch anchor — the latest
  // `started` row NAMING a launcher (the same rule as the task's toolUseId).
  it('the seek starts at the latest started row naming the launcher (re-run, launcher-less restart)', async () => {
    const sid = newSession();
    toolUse(sid, 'R1', 'Bash', { command: 'first run', run_in_background: true });
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'rerun', toolUseId: 'R1' });
    ev(sid, { type: 'bg_task', kind: 'finished', taskId: 'rerun', status: 'completed' });
    toolUse(sid, 'R2', 'Bash', { command: 'second run', run_in_background: true });
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'rerun', toolUseId: 'R2' });
    for (let i = 0; i < 60; i++) toolUse(sid, `gap${i}`);         // R2 is beyond a seek from a later row
    ev(sid, { type: 'bg_task', kind: 'started', taskId: 'rerun' }); // names no launcher: keeps R2's row
    add(sid, 'user', 'x');
    const win = await get(sid, '?open=1&view=conversation');
    expect(win.backgroundTasks).toEqual([expect.objectContaining({ taskId: 'rerun', command: 'second run' })]);
  });

  describe('ExitPlan fallback (server-side plan text)', () => {
    const pendingPlan = (sid: string, id: string, plan: string) => db.insert(schema.sessionPendingQuestions).values({
      id, sessionId: sid, kind: 'exit_plan', payload: JSON.stringify({ plan }), status: 'pending',
    }).run();

    it('Write ⇒ its input.content, from the lossless row (a long plan is not truncated)', async () => {
      const sid = newSession();
      add(sid, 'user', 'plan it');
      const long = '# Plan\n' + 'step\n'.repeat(5_000);                              // > the 16 KiB wire preview
      toolUse(sid, 'w0', 'Write', { file_path: '/root/.claude/plans/old.md', content: 'stale plan' });
      toolUse(sid, 'w1', 'Write', { file_path: '/home/me/.claude/plans/new.md', content: long });
      toolUse(sid, 'r1', 'Read', { file_path: '/elsewhere.md' });
      pendingPlan(sid, 'xp-w', '');
      for (const view of ['', '&view=conversation']) {
        const win = await get(sid, `?open=1${view}`);
        expect(win.pendingExitPlans).toEqual([expect.objectContaining({ id: 'xp-w', plan: long })]);
      }
    });

    it('Edit ⇒ the latest edit_snapshot `after` body of that path', async () => {
      const sid = newSession();
      const file = '/root/.claude/plans/p.md';
      toolUse(sid, 'w', 'Write', { file_path: file, content: 'v0' });
      snapshot(sid, file, 'before', 'v0');
      snapshot(sid, file, 'after', 'v1');
      snapshot(sid, '/other.md', 'after', 'not this one');
      toolUse(sid, 'e', 'Edit', { file_path: file, old_string: 'v1', new_string: 'v2' });
      snapshot(sid, file, 'before', 'v1');
      snapshot(sid, file, 'after', 'v2');
      snapshot(sid, file, 'before', 'v2, touched outside');           // a newer row, but not an 'after'
      add(sid, 'user', 'ok');
      pendingPlan(sid, 'xp-e', '');
      const win = await get(sid, '?open=1&view=conversation');
      expect(win.pendingExitPlans[0].plan).toBe('v2');
    });

    it('a plan that came with the request is kept; nothing found ⇒ empty', async () => {
      const sid = newSession();
      toolUse(sid, 'w', 'Write', { file_path: '/root/.claude/plans/p.md', content: 'from file' });
      pendingPlan(sid, 'xp-own', 'the agent plan');
      const own = await get(sid, '?open=1');
      expect(own.pendingExitPlans[0].plan).toBe('the agent plan');
      const bare = newSession();
      toolUse(bare, 'w', 'Write', { file_path: '/tmp/not-a-plan.md', content: 'x' });
      pendingPlan(bare, 'xp-none', '');
      expect((await get(bare, '?open=1')).pendingExitPlans[0].plan).toBe('');
    });
  });
});
