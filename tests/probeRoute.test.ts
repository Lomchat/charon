import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/sessions/[id]/probe (sync refonte C12): the transcript's
// O(1), rev-gated consistency check. It pushes a heartbeat to the caller's
// connection BEFORE reading the revision (id ≥ the response's rev), then
// answers from point lookups and one bounded range — never a window query, a
// LIKE scan or the expiry sweep.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  subscribeGlobalSessionEvents: () => () => {},
  setSessionFocusChecker: () => {},
  markSessionRead: () => {},
  peekStream: () => null,
  sweepExpiredInteractions: () => { throw new Error('the probe never sweeps'); },
}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({ userId: 'test-user' })) }));

import { markConnectionLive, registerConnection } from '@/lib/server/agent/eventConnections';
import { currentRev, epoch, publish } from '@/lib/server/sync/syncBus';

const VPS = 'probe-vps';
const SID = 'a1'.repeat(16);
const OTHER = 'b2'.repeat(16);

let db: any;
let schema: any;
let GET: typeof import('@/app/api/sessions/[id]/probe/route').GET;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS, name: 'p', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  for (const id of [SID, OTHER]) {
    db.insert(schema.agentSessions).values({ id, vpsId: VPS, cwd: '/tmp', status: 'active' }).onConflictDoNothing().run();
  }
  ({ GET } = await import('@/app/api/sessions/[id]/probe/route'));
});

const unregs: Array<() => void> = [];
beforeEach(() => {
  db.delete(schema.sessionMessages).run();
  db.delete(schema.sessionPendingPermissions).run();
  db.delete(schema.sessionPendingQuestions).run();
});
afterEach(() => { for (const u of unregs.splice(0)) u(); });

function conn(connId: string, focus: string | null) {
  const got: Array<{ rev: number; type: string }> = [];
  const dec = new TextDecoder();
  unregs.push(registerConnection({
    connId, initialFocus: focus, initialFocusSeq: 1,
    push: (chunk) => {
      const t = dec.decode(chunk);
      const id = /^id: \d+\.(\d+)$/m.exec(t);
      const data = /^data: (.*)$/m.exec(t);
      if (id && data) got.push({ rev: Number(id[1]), type: JSON.parse(data[1]).type });
    },
  }));
  markConnectionLive(connId);
  got.length = 0;               // drop the first heartbeat
  return got;
}

function row(role: string, content: unknown, sessionId = SID): number {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Number(db.insert(schema.sessionMessages).values({ sessionId, role, content: text }).run().lastInsertRowid);
}

async function probe(query: string, id = SID) {
  const res = await GET(new Request(`http://localhost/api/sessions/${id}/probe?${query}`),
    { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

describe('probe', () => {
  it('pushes a heartbeat to its conn whose id ≥ the response rev; focused/sessionRev from the registry and bus', async () => {
    const got = conn('probe-conn-0001', SID);
    const r = publish({ type: 'tool_use', sessionId: SID, id: 't', name: 'Read', input: {} });
    publish({ type: 'assistant_text', sessionId: OTHER, delta: 'x' });
    got.length = 0;
    const { body } = await probe('conn=probe-conn-0001&afterId=0');
    expect(got).toHaveLength(1);
    expect(got[0].type).toBe('heartbeat');
    expect(got[0].rev).toBeGreaterThanOrEqual(body.rev);
    expect(body.epoch).toBe(epoch());
    expect(body.rev).toBe(currentRev().rev);
    expect(body.sessionRev).toBe(r);
    expect(body.focused).toBe(true);
    // A summary-class (low) frame counts too.
    const low = publish({ type: 'session_unread', sessionId: SID, unread: true });
    expect((await probe('afterId=0')).body.sessionRev).toBe(low);
  });

  it('an unknown or unfocused conn: no heartbeat anywhere, focused false', async () => {
    const got = conn('probe-conn-0002', OTHER);
    const a = await probe('conn=probe-conn-0002&afterId=0');
    expect(a.body.focused).toBe(false);
    expect(got.map((f) => f.type)).toEqual(['heartbeat']);
    const b = await probe('conn=probe-conn-nobody&afterId=0');
    expect(b.body.focused).toBe(false);
    expect((await probe('afterId=0')).body.focused).toBe(false);
  });

  it('newRows = rendered rows past afterId, per view; maxMessageId covers every role', async () => {
    const before = row('user', 'old');
    const ids = {
      user: row('user', 'hi'),
      assistant: row('assistant', 'hello'),
      toolUse: row('tool_use', { type: 'tool_use', id: 't1', name: 'Read', input: {} }),
      toolResult: row('tool_result', { type: 'tool_result', tool_use_id: 't1', content: 'x', is_error: false }),
      thinkingRole: row('thinking', 'hmm'),
      thinkingEvent: row('event', { type: 'thinking', text: 'delta block' }),
      planUpdate: row('event', { type: 'plan_update', id: 'p', steps: [] }),
      compaction: row('event', { type: 'compaction', trigger: 'auto' }),
      bgTask: row('event', { type: 'bg_task', kind: 'started', taskId: 'b' }),
      turnUsage: row('event', { type: 'turn_usage' }),
      snapshot: row('edit_snapshot', { file_path: '/a', phase: 'after', content: 'x' }),
      question: row('user_question', '{}'),
      asyncQuestion: row('async_question', '{}'),
      notJson: row('event', 'not json'),
    };
    row('user', 'elsewhere', OTHER);
    const full = (await probe(`afterId=${before}`)).body;
    expect(full.newRows).toEqual([ids.user, ids.assistant, ids.toolUse, ids.toolResult, ids.thinkingRole,
      ids.thinkingEvent, ids.planUpdate, ids.compaction, ids.asyncQuestion]);
    expect(full.newRowsTruncated).toBe(false);
    expect(full.maxMessageId).toBe(ids.notJson);
    const conv = (await probe(`afterId=${before}&view=conversation`)).body;
    expect(conv.newRows).toEqual([ids.user, ids.assistant, ids.compaction, ids.asyncQuestion]);
    const none = (await probe(`afterId=${ids.notJson}`)).body;
    expect(none.newRows).toEqual([]);
  });

  it('≤ 50 rows reported, flagged when more exist (or the 200-row range is full)', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => row('user', `u${i}`));
    const r = (await probe('afterId=0')).body;
    expect(r.newRows).toEqual(ids.slice(0, 50));
    expect(r.newRowsTruncated).toBe(true);
    db.delete(schema.sessionMessages).run();
    for (let i = 0; i < 210; i++) row('tool_use', { type: 'tool_use', id: `t${i}` });
    const conv = (await probe('afterId=0&view=conversation')).body;
    expect(conv.newRows).toEqual([]);
    expect(conv.newRowsTruncated).toBe(true);
  });

  it('pendingIds = every pending gate of this session (all kinds)', async () => {
    db.insert(schema.sessionPendingPermissions).values([
      { id: 'p-1', sessionId: SID, toolName: 'Bash', toolInput: '{}' },
      { id: 'p-done', sessionId: SID, toolName: 'Bash', toolInput: '{}', status: 'allowed' },
      { id: 'p-other', sessionId: OTHER, toolName: 'Bash', toolInput: '{}' },
    ]).run();
    db.insert(schema.sessionPendingQuestions).values([
      { id: 'q-1', sessionId: SID, kind: 'question', payload: '[]' },
      { id: 'q-async', sessionId: SID, kind: 'async_question', payload: '[]' },
      { id: 'x-1', sessionId: SID, kind: 'exit_plan', payload: '{}' },
    ]).run();
    const r = (await probe('afterId=0')).body;
    expect([...r.pendingIds].sort()).toEqual(['p-1', 'q-1', 'q-async', 'x-1']);
  });

  it('is O(1): a handful of statements, no LIKE, no window query, no sweep', async () => {
    for (let i = 0; i < 30; i++) row('assistant', `a${i}`);
    const sqlite = (globalThis as any)._sqlite;
    const real = sqlite.prepare;
    const seen: string[] = [];
    sqlite.prepare = function (this: unknown, ...args: unknown[]) {
      seen.push(String(args[0]));
      return real.apply(this, args);
    };
    try {
      const { status } = await probe('afterId=5&view=full');
      expect(status).toBe(200);
    } finally {
      sqlite.prepare = real;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(5);
    for (const q of seen) {
      expect(q.toLowerCase()).not.toContain(' like ');
      expect(q).not.toMatch(/ts_ms|chrono|count\(/i);       // the window's chronological queries
    }
  });

  it('404 for an unknown session', async () => {
    expect((await probe('afterId=0', 'nope')).status).toBe(404);
  });
});
