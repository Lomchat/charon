import { beforeAll, describe, expect, it, vi } from 'vitest';

// The conversation view's partial index (W4-review, lib/db/conversationIndex.ts):
// the tools-hidden window seeks it instead of walking every technical row of
// its span; same rows with or without it; no migration builds it (SPEC I12):
// boot only on a small table, the offline vacuum otherwise (same SQL).

vi.mock('server-only', () => ({}));

type Page = { messages: Array<{ id: number }>; hasMore: boolean; oldestChatId: number | null };

let raw: import('better-sqlite3').Database;
let ci: typeof import('@/lib/db/conversationIndex');
let loadMessageWindow: (sid: string, limit: number, before: number | null, view?: 'full' | 'conversation') => Page;
const SID = 'c'.repeat(32);

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(dbMod.db, { migrationsFolder: './drizzle' });
  raw = dbMod.rawSqlite();
  ci = await import('@/lib/db/conversationIndex');
  ({ loadMessageWindow } = await import('@/lib/server/hub/messageWindow'));
  raw.prepare("INSERT OR IGNORE INTO vps_folders (id, name, position) VALUES ('default', 'default', 0)").run();
  raw.prepare("INSERT OR IGNORE INTO vps (id, name, ip, ssh_user) VALUES ('civps', 'v', '127.0.0.1', 'root')").run();
  raw.prepare("INSERT INTO agent_sessions (id, vps_id, cwd, name, status) VALUES (?, 'civps', '/tmp', 'n', 'sleeping')").run(SID);
  // 60 turns, each: user, 300 tool rows, a thinking event, a bg_task event, assistant.
  const ins = raw.prepare('INSERT INTO session_messages (session_id, role, content, ts_ms, created_at) VALUES (?, ?, ?, ?, ?)');
  let t = Date.now() - 86_400_000;
  raw.transaction(() => {
    for (let turn = 0; turn < 60; turn++) {
      ins.run(SID, 'user', `q${turn}`, t++, 0);
      for (let j = 0; j < 300; j++) {
        ins.run(SID, j % 2 ? 'tool_result' : 'tool_use', JSON.stringify({ id: `t${turn}-${j >> 1}`, pad: 'x'.repeat(100) }), t++, 0);
      }
      ins.run(SID, 'event', JSON.stringify({ type: 'thinking', text: 'hmm' }), t++, 0);
      ins.run(SID, 'event', JSON.stringify({ type: 'bg_task', taskId: `b${turn}`, status: 'started' }), t++, 0);
      ins.run(SID, 'assistant', `a${turn}`, t++, 0);
    }
  })();
});

/** Every query loadMessageWindow prepares, with its plan. */
function plans(fn: () => void): Array<{ sql: string; plan: string }> {
  const seen: string[] = [];
  const orig = raw.prepare.bind(raw);
  (raw as any).prepare = (sql: string) => { seen.push(sql); return orig(sql); };
  try { fn(); } finally { (raw as any).prepare = orig; }
  return seen.map((sql) => {
    const n = (sql.match(/\?/g) ?? []).length;
    const rows = orig(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill(0)) as Array<{ detail: string }>;
    return { sql, plan: rows.map((r) => r.detail).join(' | ') };
  });
}

describe('conversation partial index', () => {
  it('the offline tool creates the SAME index the queries are written for', async () => {
    const tool = await import('../scripts/compact-thinking.mjs');
    expect(tool.CONVERSATION_INDEX_SQL).toBe(ci.CONVERSATION_INDEX_SQL);
  });

  it('boot creates it on a small table only', () => {
    expect(ci.ensureConversationIndex(raw, 0)).toBe('deferred');      // "large": not online
    expect(ci.ensureConversationIndex(raw)).toBe('created');
    expect(ci.ensureConversationIndex(raw)).toBe('exists');
  });

  it('an index built for an older event-type list is replaced, never kept unused', async () => {
    const stored = () => (raw.prepare('SELECT sql FROM sqlite_master WHERE name = ?')
      .get(ci.CONVERSATION_INDEX_NAME) as { sql: string } | undefined)?.sql;
    const old = ci.CONVERSATION_INDEX_SQL.replace("'scheduled_fire', ", '');
    raw.exec(`DROP INDEX IF EXISTS ${ci.CONVERSATION_INDEX_NAME}`);
    raw.exec(old);
    // Too large to rebuild online: the stale one still goes.
    expect(ci.ensureConversationIndex(raw, 0)).toBe('deferred');
    expect(stored()).toBeUndefined();
    raw.exec(old);
    expect(ci.ensureConversationIndex(raw)).toBe('created');
    expect(stored()).toBe(ci.CONVERSATION_INDEX_STORED_SQL);
    // The offline tool does the same.
    const tool = await import('../scripts/compact-thinking.mjs');
    raw.exec(`DROP INDEX ${ci.CONVERSATION_INDEX_NAME}`);
    raw.exec(old);
    tool.ensureConversationIndexOffline(raw);
    expect(stored()).toBe(ci.CONVERSATION_INDEX_STORED_SQL);
  });

  it('the conversation slot and page queries seek the partial index; same rows as without it', () => {
    ci.ensureConversationIndex(raw);
    raw.exec('ANALYZE');
    let withIdx: Page[] = [];
    const seen = plans(() => {
      const newest = loadMessageWindow(SID, 20, null, 'conversation');
      const older = loadMessageWindow(SID, 20, newest.oldestChatId, 'conversation');
      withIdx = [newest, older];
    });
    const conv = seen.filter((p) => p.sql.includes("NOT IN ('edit_snapshot'"));
    expect(conv.length).toBeGreaterThanOrEqual(4);
    for (const p of conv) expect(p.plan).toContain(ci.CONVERSATION_INDEX_NAME);
    expect(withIdx[0].messages.length).toBeGreaterThan(20);           // 20 slots + bg_task events
    expect(withIdx[0].hasMore).toBe(true);
    raw.exec(`DROP INDEX ${ci.CONVERSATION_INDEX_NAME}`);
    try {
      const newest = loadMessageWindow(SID, 20, null, 'conversation');
      const older = loadMessageWindow(SID, 20, newest.oldestChatId, 'conversation');
      expect([newest, older]).toEqual(withIdx);
    } finally {
      ci.ensureConversationIndex(raw);
    }
  });
});
