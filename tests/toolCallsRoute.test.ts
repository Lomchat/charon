import { beforeAll, describe, expect, it, vi } from 'vitest';

// GET /api/sessions/[id]/tool-calls (sync refonte C14, CLAUDE.md
// §14.25): the calls tab in conversation view. Pages of tool_use rows (newest
// page first, chronological inside), paired with their tool_result by
// `tool_use_id`, ≤ 512-char previews computed in SQLite — a tool_result's
// lossless `content` is never selected.

vi.mock('server-only', () => ({}));
const auth = vi.hoisted(() => ({ ok: true }));
vi.mock('@/lib/server/session', () => ({
  requireApiSession: async () => (auth.ok ? { userId: 'u' } : Response.json({ error: 'unauthorized' }, { status: 401 })),
}));

const VPS = 'calls-vps';
let db: any;
let schema: any;
let rawSqlite: () => import('better-sqlite3').Database;
let deriveMessageStorage: (role: string, content: string) => Record<string, unknown>;
let GET: typeof import('@/app/api/sessions/[id]/tool-calls/route').GET;
let counter = 0;
let clock = Date.now() - 3_600_000;

function newSession(): string {
  const id = (++counter).toString(16).padStart(32, 'c');
  db.insert(schema.agentSessions).values({ id, vpsId: VPS, cwd: '/tmp', name: 't', status: 'sleeping' }).run();
  return id;
}
function add(sid: string, role: string, content: unknown): number {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  clock += 1000;
  return Number(db.insert(schema.sessionMessages).values({
    sessionId: sid, role, content: text, ...deriveMessageStorage(role, text), tsMs: clock,
  }).run().lastInsertRowid);
}
const use = (sid: string, id: string | null, name = 'Read', input: unknown = { file_path: `/f/${id}` }) =>
  add(sid, 'tool_use', { type: 'tool_use', ...(id ? { id } : {}), name, input });
const result = (sid: string, id: string, content: unknown = `out of ${id}`, isError = false) =>
  add(sid, 'tool_result', { type: 'tool_result', tool_use_id: id, content, is_error: isError });

async function calls(sid: string, query = ''): Promise<any> {
  const res = await GET(new Request(`http://localhost/api/sessions/${sid}/tool-calls${query}`),
    { params: Promise.resolve({ id: sid }) });
  return { status: res.status, body: await res.json() };
}

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

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  rawSqlite = dbMod.rawSqlite;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS, name: 'c', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  ({ deriveMessageStorage } = await import('@/lib/server/hub/messageWire') as any);
  ({ GET } = await import('@/app/api/sessions/[id]/tool-calls/route'));
});

describe('GET …/tool-calls', () => {
  it('a duplicated SDK id: the later call gets h<rowId> and only its own result (the rebuild rule)', async () => {
    const sid = newSession();
    add(sid, 'user', 'go');
    const r1 = use(sid, 'dup');
    result(sid, 'dup', 'one');
    const r2 = use(sid, 'dup');                                 // unanswered
    let { body } = await calls(sid);
    expect(body.calls.map((c: any) => [c.id, c.rowId, c.result?.preview ?? null]))
      .toEqual([['dup', r1, 'one'], [`h${r2}`, r2, null]]);
    result(sid, 'dup', 'two');
    ({ body } = await calls(sid));
    expect(body.calls.map((c: any) => [c.id, c.result?.preview ?? null]))
      .toEqual([['dup', 'one'], [`h${r2}`, 'two']]);
  });

  it('pairs each call with its result by tool_use_id: error flag, bounded preview, null while running', async () => {
    const sid = newSession();
    add(sid, 'user', 'go');
    const r1 = use(sid, 'a');
    const r2 = use(sid, 'b', 'Bash', { command: 'false' });
    add(sid, 'thinking', 'interleaved');
    result(sid, 'b', 'exit 1', true);                         // answered out of order
    result(sid, 'a', 'x'.repeat(5_000));
    const r3 = use(sid, 'c');                                    // still running
    const r4 = use(sid, null, 'Legacy');                         // no SDK id
    add(sid, 'tool_use', '{"broken');                            // unparsable: skipped like the rebuild does
    const { status, body } = await calls(sid);
    expect(status).toBe(200);
    expect(body.total).toBe(5);
    expect(body.hasMore).toBe(false);
    expect(body.calls).toEqual([
      { id: 'a', rowId: r1, name: 'Read', input: { file_path: '/f/a' }, startedAt: expect.any(Number),
        result: { isError: false, preview: 'x'.repeat(512) } },
      { id: 'b', rowId: r2, name: 'Bash', input: { command: 'false' }, startedAt: expect.any(Number),
        result: { isError: true, preview: 'exit 1' } },
      { id: 'c', rowId: r3, name: 'Read', input: { file_path: '/f/c' }, startedAt: expect.any(Number), result: null },
      { id: `h${r4}`, rowId: r4, name: 'Legacy', input: { file_path: '/f/null' }, startedAt: expect.any(Number), result: null },
    ]);
  });

  it('pages newest first, chronological inside; `before` = the oldest rowId held; pages tile', async () => {
    const sid = newSession();
    const ids: number[] = [];
    for (let i = 0; i < 11; i++) { ids.push(use(sid, `t${i}`)); result(sid, `t${i}`, `r${i}`); }
    const p1 = (await calls(sid, '?limit=4')).body;
    expect(p1.calls.map((c: any) => c.id)).toEqual(['t7', 't8', 't9', 't10']);
    expect(p1.hasMore).toBe(true);
    expect(p1.total).toBe(11);
    const p2 = (await calls(sid, `?limit=4&before=${p1.calls[0].rowId}`)).body;
    const p3 = (await calls(sid, `?limit=4&before=${p2.calls[0].rowId}`)).body;
    expect(p3.hasMore).toBe(false);
    const all = [...p3.calls, ...p2.calls, ...p1.calls];
    expect(all.map((c: any) => c.rowId)).toEqual(ids);
    expect(all.map((c: any) => c.result.preview)).toEqual(ids.map((_, i) => `r${i}`));
  });

  it('a result answered after the page boundary (parallel calls) is still paired', async () => {
    const sid = newSession();
    use(sid, 'old');
    use(sid, 'p1');                                              // parallel batch: p1 p2 p3, then results
    use(sid, 'p2');
    use(sid, 'p3');
    result(sid, 'p1', 'one');
    result(sid, 'p2', 'two');
    result(sid, 'p3', 'three');
    result(sid, 'old', 'late');
    const newest = (await calls(sid, '?limit=2')).body;           // p2, p3
    expect(newest.calls.map((c: any) => c.id)).toEqual(['p2', 'p3']);
    const older = (await calls(sid, `?limit=2&before=${newest.calls[0].rowId}`)).body;   // old, p1
    expect(older.calls.map((c: any) => [c.id, c.result?.preview])).toEqual([['old', 'late'], ['p1', 'one']]);
  });

  it('a sub-agent launcher answered after hundreds of its sub-agents\' rows is still paired (parallel sub-agents)', async () => {
    // The agent forwards each sub-agent's tool rows to the parent session
    // BEFORE the launcher's own result.
    const sid = newSession();
    for (let i = 0; i < 50; i++) { use(sid, `pre${i}`); result(sid, `pre${i}`); }
    for (const t of ['T1', 'T2', 'T3']) use(sid, t, t === 'T3' ? 'Agent' : 'Task', { description: t, prompt: 'go' });
    for (let i = 0; i < 80; i++) {
      for (const t of ['T1', 'T2', 'T3']) { use(sid, `${t}-sub${i}`); result(sid, `${t}-sub${i}`); }
    }
    for (const t of ['T1', 'T2', 'T3']) result(sid, t, `${t} done`);
    // Page the session newest first until the launchers' page.
    let before: number | null = null;
    let launchers: any[] = [];
    for (let i = 0; i < 20 && launchers.length === 0; i++) {
      const page: any = (await calls(sid, `?limit=200${before != null ? `&before=${before}` : ''}`)).body;
      launchers = page.calls.filter((c: any) => ['T1', 'T2', 'T3'].includes(c.id));
      before = page.calls[0]?.rowId ?? null;
    }
    expect(launchers.map((c: any) => [c.id, c.result?.preview, c.resultUnknown])).toEqual([
      ['T1', 'T1 done', undefined], ['T2', 'T2 done', undefined], ['T3', 'T3 done', undefined],
    ]);
  });

  it('a result beyond every bound is `resultUnknown`, never shown as running', async () => {
    const sid = newSession();
    use(sid, 'old');
    use(sid, 'mid');
    const boundary = use(sid, 'new');
    for (let i = 0; i < 260; i++) { use(sid, `s${i}`); result(sid, `s${i}`); }
    result(sid, 'old', 'very late');
    const page = (await calls(sid, `?limit=2&before=${boundary}`)).body;
    expect(page.calls.map((c: any) => [c.id, c.result, c.resultUnknown])).toEqual([
      ['old', null, true], ['mid', null, true],
    ]);
    // The newest page is never bounded: an unanswered call there is running.
    const newest = (await calls(sid, '?limit=1')).body;
    expect(newest.calls.map((c: any) => [c.id, c.result?.preview, c.resultUnknown])).toEqual([['s259', 'out of s259', undefined]]);
    const running = newSession();
    use(running, 'r');
    expect((await calls(running)).body.calls).toEqual([expect.objectContaining({ id: 'r', result: null })]);
    expect('resultUnknown' in (await calls(running)).body.calls[0]).toBe(false);
  });

  it('compacts inputs once: a wire-compacted input keeps its original byte count', async () => {
    const sid = newSession();
    const body = 'y'.repeat(50_000);
    use(sid, 'w', 'Write', { file_path: '/big.txt', content: body });
    const [call] = (await calls(sid)).body.calls;
    expect(call.input.content_truncated).toBe(true);
    expect(call.input.content_bytes).toBe(50_000);
    expect(call.input.content.length).toBeLessThan(17_000);
    expect(call.input.content.match(/characters omitted/g)).toHaveLength(1);
  });

  it('never selects a full payload: results are taken apart in SQLite (spy on the prepared SQL)', async () => {
    const sid = newSession();
    use(sid, 'huge', 'Bash', { command: 'cat big' });
    result(sid, 'huge', 'z'.repeat(2_000_000));                   // lossless 2 MB, wire preview ≤ 16 KiB
    result(sid, 'other', [{ type: 'text', text: 'array content' }]);
    use(sid, 'arr');
    result(sid, 'arr', [{ type: 'text', text: 'block' }]);
    let res: any;
    const sqls = await preparedDuring(async () => { res = await calls(sid); });
    expect(res.body.calls[0].result.preview).toBe('z'.repeat(512));
    expect(JSON.parse(res.body.calls[1].result.preview)).toEqual([{ type: 'text', text: 'block' }]);
    const touching = sqls.filter((q) => /session_messages/.test(q));
    expect(touching.length).toBeGreaterThanOrEqual(3);              // count, page, results
    for (const q of touching) {
      // Left once the bounded form, the wire column and JSON paths are removed:
      // any `content` would be the lossless column.
      const rest = q.replace(/coalesce\(wire_content, content\)/g, '')
        .replace(/wire_content/g, '').replace(/'\$\.[^']*'/g, "''");
      expect(rest, q).not.toMatch(/\bcontent\b/);
    }
    // The page and result reads seek the snapshot_lookup index: no session-wide sort.
    const page = touching.find((q) => /role = \?/.test(q) && /created_at AS createdAt/.test(q))!;
    const plan = rawSqlite().prepare(`EXPLAIN QUERY PLAN ${page}`).all(sid, 'tool_use', 501)
      .map((r: any) => r.detail).join(' | ');
    expect(plan).toMatch(/idx_session_messages_snapshot_lookup/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it('clamps `limit` to 1..500, 404s an unknown session and stays behind the auth gate', async () => {
    const sid = newSession();
    const ins = rawSqlite().prepare(
      'INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, ?, ?, ?)');
    rawSqlite().transaction(() => {
      for (let i = 0; i < 502; i++) ins.run(sid, 'tool_use', JSON.stringify({ id: `k${i}`, name: 'Read', input: {} }), ++clock);
    })();
    expect((await calls(sid, '?limit=0')).body.calls.map((c: any) => c.id)).toEqual(['k501']);
    const max = (await calls(sid, '?limit=100000')).body;
    expect(max.calls).toHaveLength(500);
    expect(max.hasMore).toBe(true);
    expect((await calls(sid, '?limit=nope')).body.calls).toHaveLength(200);
    expect((await calls('f'.repeat(32))).status).toBe(404);
    auth.ok = false;
    try {
      expect((await calls(sid)).status).toBe(401);
    } finally {
      auth.ok = true;
    }
  });
});
