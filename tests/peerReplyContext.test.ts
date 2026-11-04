import { beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq, gte, and } from 'drizzle-orm';

// The input preceding a transcript page (C03): a bounded backward walk on the
// chronological index instead of an OR query that sorted the whole prefix.

vi.mock('server-only', () => ({}));

let db: any;
let schema: any;
let rawSqlite: () => import('better-sqlite3').Database;
let attachPeerAssistantReplies: typeof import('@/lib/server/hub/peerReplyContext').attachPeerAssistantReplies;
let priorInputStatement: typeof import('@/lib/server/hub/peerReplyContext').priorInputStatement;
let CAP: number;

const VPS = 'peer-vps';
let counter = 0;
let clock = 1_800_000_000_000;

function newSession(): string {
  const id = (++counter).toString(16).padStart(32, 'e');
  db.insert(schema.agentSessions).values({ id, vpsId: VPS, cwd: '/tmp', name: 'peer', status: 'active' }).run();
  return id;
}

function row(sid: string, role: string, content: unknown, tsMs: number | null = (clock += 10)): number {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Number(rawSqlite().prepare('INSERT INTO session_messages (session_id, role, content, ts_ms) VALUES (?, ?, ?, ?)')
    .run(sid, role, text, tsMs).lastInsertRowid);
}

const request = (sid: string, messageId: string | null, extra: Record<string, unknown> = {}) => row(sid, 'event', {
  type: 'external_message', text: 'please', from: 'peer', origin: 'charon_peer',
  ...(messageId ? { messageId } : {}), ...extra,
});

/** `n` rows of every role the walk must step over (it stops only at inputs). */
function filler(sid: string, n: number): void {
  const kinds: Array<[string, unknown]> = [
    ['event', { type: 'thinking', text: 'mentions "external_message" and "fork_point" in prose' }],
    ['tool_use', { id: 'tu', name: 'Bash', input: { command: 'ls' } }],
    ['tool_result', { tool_use_id: 'tu', content: 'ok' }],
    ['assistant', 'progress'],
    ['event', { type: 'endpoint_usage', requestId: 'r', inputTokens: 1 }],
    ['edit_snapshot', { file_path: '/a', phase: 'before', content: 'x' }],
  ];
  rawSqlite().transaction(() => {
    for (let i = 0; i < n; i++) row(sid, ...kinds[i % kinds.length]);
  })();
}

/** The page whose FIRST row is `fromId` (fixture ids follow chronology). */
function pageFrom(sid: string, fromId: number) {
  const m = schema.sessionMessages;
  return db.select().from(m).where(and(eq(m.sessionId, sid), gte(m.id, fromId))).orderBy(asc(m.id)).all();
}

function replyOf(sid: string, answerId: number): string | undefined {
  return attachPeerAssistantReplies(sid, pageFrom(sid, answerId)).find((r) => r.id === answerId)?.peerReplyTo;
}

function plan(): string[] {
  return rawSqlite().prepare(`EXPLAIN QUERY PLAN ${priorInputStatement().source}`)
    .all({ sid: 'x', ts: 1, id: 1 }).map((r: any) => r.detail as string);
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  rawSqlite = dbMod.rawSqlite;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS, name: 'peer', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  ({ attachPeerAssistantReplies, priorInputStatement, PRIOR_INPUT_WALK_CAP: CAP } = await import('@/lib/server/hub/peerReplyContext'));
});

describe('the input preceding a page', () => {
  it('links a page to a peer request ~5k interleaved rows back', () => {
    const sid = newSession();
    row(sid, 'user', 'earlier human prompt');
    request(sid, 'req-far');
    filler(sid, 4_990);
    const answer = row(sid, 'assistant', 'the answer');
    expect(replyOf(sid, answer)).toBe('req-far');
  });

  it('stops at the first input boundary: a human prompt, a fork point, a received reply', () => {
    const human = newSession();
    request(human, 'req');
    filler(human, 20);
    row(human, 'user', 'a human takes over');
    filler(human, 20);
    expect(replyOf(human, row(human, 'assistant', 'answer'))).toBeUndefined();

    const fork = newSession();
    request(fork, 'req');
    row(fork, 'event', { type: 'fork_point', sourceSessionId: 'other' });
    filler(fork, 20);
    expect(replyOf(fork, row(fork, 'assistant', 'answer'))).toBeUndefined();

    for (const reply of [{ origin: 'charon_peer_reply' }, { replyTo: 'mine' }, { expectsReply: false }]) {
      const s = newSession();
      request(s, 'old-request');
      filler(s, 10);
      request(s, 'a-reply', reply);
      filler(s, 10);
      expect(replyOf(s, row(s, 'assistant', 'internal update'))).toBeUndefined();
    }
  });

  it('a request without a message id is addressed by its row id', () => {
    const sid = newSession();
    const req = request(sid, null);
    filler(sid, 5);
    expect(replyOf(sid, row(sid, 'assistant', 'answer'))).toBe(`m${req}`);
  });

  it('walks CHRONOLOGICALLY (ts, then id), legacy NULL ts_ms by created_at', () => {
    // A repaired human row inserted late (high id) but dated between the
    // request and the page: chronologically it is the nearer input.
    const repaired = newSession();
    const base = (clock += 1_000);
    request(repaired, 'req');
    rawSqlite().prepare('UPDATE session_messages SET ts_ms = ? WHERE id = (SELECT max(id) FROM session_messages)').run(base);
    const answer = row(repaired, 'assistant', 'answer', base + 100);
    row(repaired, 'user', 'repaired prompt', base + 50);
    expect(attachPeerAssistantReplies(repaired, pageFrom(repaired, answer).filter((r: any) => r.id === answer))[0].peerReplyTo)
      .toBeUndefined();

    // The reverse: a REQUEST inserted late (highest id) but dated before the
    // human prompt. Id order would find the request; chronology finds the human.
    const lateRequest = newSession();
    const b2 = (clock += 1_000);
    row(lateRequest, 'user', 'human prompt', b2 + 50);
    const answer2 = row(lateRequest, 'assistant', 'answer', b2 + 100);
    request(lateRequest, 'req-late');
    rawSqlite().prepare('UPDATE session_messages SET ts_ms = ? WHERE id = (SELECT max(id) FROM session_messages)').run(b2);
    expect(attachPeerAssistantReplies(lateRequest, pageFrom(lateRequest, answer2).filter((r: any) => r.id === answer2))[0].peerReplyTo)
      .toBeUndefined();

    // Same ts as the page's first row: a LOWER id is before it, a higher id is not.
    const tie = newSession();
    const t = (clock += 1_000);
    request(tie, 'req-tie', {});
    rawSqlite().prepare('UPDATE session_messages SET ts_ms = ? WHERE id = (SELECT max(id) FROM session_messages)').run(t);
    const tied = row(tie, 'assistant', 'same ms answer', t);
    expect(replyOf(tie, tied)).toBe('req-tie');

    // ts_ms NULL (pre-0026 rows): ordered by created_at * 1000.
    const legacy = newSession();
    const created = Math.floor((clock += 5_000) / 1000);
    rawSqlite().prepare(`INSERT INTO session_messages (session_id, role, content, ts_ms, created_at)
      VALUES (?, 'event', ?, NULL, ?)`).run(legacy, JSON.stringify({ type: 'external_message', messageId: 'req-legacy' }), created);
    const later = row(legacy, 'assistant', 'answer', created * 1000 + 500);
    expect(replyOf(legacy, later)).toBe('req-legacy');
  });

  it(`gives up after ${5_000} rows: the leading rows of that page get no peerReplyTo`, () => {
    expect(CAP).toBe(5_000);
    const within = newSession();
    request(within, 'req-in');
    filler(within, CAP - 1);           // the request is the CAP-th row walked
    expect(replyOf(within, row(within, 'assistant', 'answer'))).toBe('req-in');

    const beyond = newSession();
    request(beyond, 'req-out');
    filler(beyond, CAP);               // the request would be row CAP + 1
    const answer = row(beyond, 'assistant', 'answer');
    expect(replyOf(beyond, answer)).toBeUndefined();
    // Inside the page, a later request still links normally.
    const req2 = request(beyond, 'req-in-page');
    const answer2 = row(beyond, 'assistant', 'second answer');
    const linked = attachPeerAssistantReplies(beyond, pageFrom(beyond, answer));
    expect(linked.find((r) => r.id === answer)?.peerReplyTo).toBeUndefined();
    expect(linked.find((r) => r.id === answer2)?.peerReplyTo).toBe('req-in-page');
    expect(req2).toBeLessThan(answer2);
  });
});

describe('query plan', () => {
  // The walk must be a RANGE seek on the chronological index starting at the
  // page bound, read newest first: no MULTI-INDEX OR, no TEMP B-TREE sort of
  // the whole prefix, and not a seek on session_id alone (that walks every
  // newer row first). Production statistics turned the unbounded OR form into
  // MULTI-INDEX OR + TEMP B-TREE; the plan must hold with and without them.
  function expectBoundedWalk(details: string[]): void {
    expect(details.join('\n')).not.toMatch(/TEMP B-TREE|MULTI-INDEX|SCAN /);
    expect(details).toContainEqual(expect.stringMatching(
      /SEARCH session_messages USING INDEX idx_session_messages_session_chrono_id \(session_id=\? AND <expr><\?\)/));
  }

  it('is a bounded descending range on idx_…_session_chrono_id (no stats)', () => {
    expectBoundedWalk(plan());
  });

  it('is prepared once per process: a vi.resetModules() twin reuses it (globalThis, I3)', async () => {
    const statement = priorInputStatement();
    expect(priorInputStatement()).toBe(statement);
    vi.resetModules();
    const twin = await import('@/lib/server/hub/peerReplyContext');
    expect(twin.priorInputStatement).not.toBe(priorInputStatement);
    expect(twin.priorInputStatement()).toBe(statement);
  });

  it('stays bounded under production planner statistics (sqlite_stat1)', () => {
    const sqlite = rawSqlite();
    sqlite.exec('ANALYZE');
    try {
      sqlite.exec("DELETE FROM sqlite_stat1 WHERE tbl = 'session_messages'");
      const ins = sqlite.prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('session_messages', ?, ?)");
      // Production values (read-only copy of its sqlite_stat1, 2026-10-15).
      for (const [idx, stat] of [
        ['idx_session_messages_session_chrono_id', '347576 11986 1 1'],
        ['idx_session_messages_snapshot_lookup', '347576 11986 2159 96 53 1'],
        ['idx_session_messages_session_seq', '347576 11986 1'],
        ['idx_session_messages_session_ts_id', '347576 11986 1 1'],
        ['idx_session_messages_session_id_id', '347576 11986 1'],
      ]) ins.run(idx, stat);
      sqlite.exec('ANALYZE sqlite_schema');
      expectBoundedWalk(plan());
    } finally {
      sqlite.exec('DELETE FROM sqlite_stat1');
      try { sqlite.exec('DELETE FROM sqlite_stat4'); } catch { /* not compiled in */ }
      sqlite.exec('ANALYZE sqlite_schema');
    }
  });
});
