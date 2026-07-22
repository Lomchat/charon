import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Fault-injection tests for the replay engine (Codex section 13.2) ────────
// These reproduce the failure scenarios the counter-review demanded before
// P0.2/P0.3 may be called closed:
//   S1  persist fails at seq N, succeeds at N+1 → restart replay REPAIRS N
//       (the MAX(seq)-gate regression: a max would swallow N).
//   S2  assistant flush fails after several deltas → text recovered by a
//       later boundary, never lost.
//   S3  two IDENTICAL assistant answers in different turns, second turn's
//       rows missing → replay persists the second (the original 'Done.'
//       bug — fails on content-dedup, passes on seq-identity).
//   S4  replay overlapping an already-persisted range → zero duplicates.
//   S5  pending-interaction insert fails → nothing half-written; restart
//       replay redoes pending AND row.
//
// The SessionStream is driven directly through its (compile-time-private)
// _onAgentEvent, with a real SQLite DB (temp file, real migrations) and a
// mocked AgentClientPool. DB failures are injected by patching db.insert.

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-replay-test-')),
  'test.db',
);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  // The stream pings the pool on every tracked seq + on attach; none of it
  // matters here — no ssh children, no reconnect timers in tests.
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    call: async () => ({}),
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'testvps0';
const SID = 'a'.repeat(32);

let db: any;
let schema: any;
let SessionStream: any;
let orderChronologically: any;
// Injection: skip the first `skipInserts` row inserts (pass through), then
// fail the next `failNextInserts` ones. Lets a test target e.g. "the SECOND
// insert of this event" (pending succeeds, message row fails — S6).
let failNextInserts = 0;
let skipInserts = 0;

function mkStream(lastSeenSeq: number | null) {
  const s = new SessionStream({
    id: SID, vpsId: VPS_ID, vpsName: 'test', name: null,
    status: 'active', permissionMode: 'normal', claudeSessionId: null,
    lastSeenSeq,
  });
  return s as any;
}

function rows(role?: string) {
  const all = db.select().from(schema.claudeSessionMessages).all()
    .filter((r: any) => r.sessionId === SID);
  return role ? all.filter((r: any) => r.role === role) : all;
}

function replayThrough(s: any, evs: any[]) {
  s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: evs.length });
  for (const ev of evs) s._onAgentEvent({ session_id: SID, ...ev });
  s._onAgentEvent({ event: 'replay_end', session_id: SID });
}

function persistedCursor(): number | null {
  const [r] = db.select().from(schema.claudeSessions).all()
    .filter((x: any) => x.id === SID);
  return r?.lastSeenSeq ?? null;
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });

  // Minimal fixture graph (FKs are ON): folder → vps → session. Notifications
  // OFF so stop events don't reach for VAPID/web-push.
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  db.insert(schema.claudeSessions).values({
    id: SID, vpsId: VPS_ID, cwd: '/tmp', status: 'active',
  }).onConflictDoNothing().run();
  db.insert(schema.claudeSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();

  // Failure injection: patch db.insert — `failNextInserts = k` makes the
  // next k row inserts throw, everything after goes through untouched.
  const realInsert = db.insert.bind(db);
  vi.spyOn(db, 'insert').mockImplementation(((table: any) => {
    if (skipInserts > 0) {
      skipInserts--;
      return realInsert(table);
    }
    if (failNextInserts > 0) {
      failNextInserts--;
      const boom = () => { throw new Error('injected DB failure'); };
      return {
        values: () => ({ run: boom, onConflictDoNothing: () => ({ run: boom }) }),
      };
    }
    return realInsert(table);
  }) as any);

  ({ SessionStream } = await import('@/lib/server/agent/sessionOps'));
  ({ orderChronologically } = await import('@/lib/server/claude/messageOrder'));
});

afterEach(() => {
  failNextInserts = 0;
  skipInserts = 0;
  db.delete(schema.claudeSessionMessages).run();
  db.delete(schema.claudePendingQuestions).run();
  db.update(schema.claudeSessions).set({ lastSeenSeq: null }).run();
});

describe('replay exactness under injected faults', () => {
  it('S1: persist fails at N, succeeds at N+1 — restart replay repairs N (SET-gate, not MAX)', () => {
    const s1 = mkStream(null);
    failNextInserts = 1; // the tool_use row insert at seq 10 fails
    s1._onAgentEvent({ event: 'tool_use', session_id: SID, id: 't1', name: 'Bash', input: {}, seq: 10 });
    s1._onAgentEvent({ event: 'tool_result', session_id: SID, tool_use_id: 't1', content: 'ok', is_error: false, seq: 11 });
    s1._persistSeqNow();

    // The failed persist pinned the durable cursor BELOW 10.
    expect(persistedCursor()).toBe(9);
    expect(rows('tool_use')).toHaveLength(0);
    expect(rows('tool_result')).toHaveLength(1);

    // Restart: fresh stream replays 10..11. 10 must be REPAIRED, 11 skipped.
    const s2 = mkStream(persistedCursor());
    replayThrough(s2, [
      { event: 'tool_use', id: 't1', name: 'Bash', input: {}, seq: 10 },
      { event: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false, seq: 11 },
    ]);
    s2._persistSeqNow();

    expect(rows('tool_use')).toHaveLength(1);
    expect(rows('tool_use')[0].seq).toBe(10);
    expect(rows('tool_result')).toHaveLength(1); // still exactly one
  });

  it('S2: flush failure — text recovered AND chronological order preserved (16.3)', () => {
    const s1 = mkStream(null);
    const parts = ['alpha ', 'beta ', 'gamma ', 'delta ', 'omega'];
    parts.forEach((p, i) =>
      s1._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: p, seq: 20 + i }));
    failNextInserts = 1; // the FLUSH row fails
    s1._onAgentEvent({ event: 'tool_use', session_id: SID, id: 't2', name: 'Read', input: {}, seq: 25 });
    s1._persistSeqNow();

    expect(persistedCursor()).toBe(19); // pinned at first delta - 1
    expect(rows('assistant')).toHaveLength(0);
    // Order-preserving stop (Codex 16.3): the boundary's OWN row must NOT
    // be persisted after its flush failed — else it lands BEFORE the text.
    expect(rows('tool_use')).toHaveLength(0);

    // Restart: replay redoes deltas → flush → boundary IN ORDER, then the
    // turn continues (thinking, post-tool text, stop) — the post-tool text
    // must form a SEPARATE segment, never merged with the first one.
    const s2 = mkStream(persistedCursor());
    replayThrough(s2, [
      ...parts.map((p, i) => ({ event: 'assistant_text', delta: p, seq: 20 + i })),
      { event: 'tool_use', id: 't2', name: 'Read', input: {}, seq: 25 },
    ]);
    s2._onAgentEvent({ event: 'thinking', session_id: SID, text: 'next', seq: 26 });
    s2._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'after-tool', seq: 27 });
    s2._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 28 });
    s2._persistSeqNow();

    const assistants = rows('assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0].content).toBe(parts.join(''));
    expect(assistants[0].seq).toBe(20); // stamped with the FIRST delta
    expect(assistants[1].content).toBe('after-tool'); // separate segment
    expect(rows('tool_use')).toHaveLength(1);
    // FULL chronological check through the real ordering used by the GET:
    const ordered = orderChronologically(rows()).map((r: any) => r.role);
    expect(ordered).toEqual(['assistant', 'tool_use', 'event', 'assistant']); // thinking rows have role 'event'
  });

  it('S3: identical "Done." in two turns — the genuinely-missed second one is persisted', () => {
    // Turn 1, fully persisted live.
    const s1 = mkStream(null);
    s1._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'Done.', seq: 5 });
    s1._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 6 });
    s1._persistSeqNow();
    expect(rows('assistant')).toHaveLength(1);

    // Crash. Turn 2 (identical text) happened while the hub was down — its
    // events arrive only via replay on the fresh stream.
    const s2 = mkStream(persistedCursor());
    replayThrough(s2, [
      { event: 'assistant_text', delta: 'Done.', seq: 7 },
      { event: 'stop', subtype: 'end_turn', seq: 8 },
    ]);
    s2._persistSeqNow();

    const assistants = rows('assistant');
    expect(assistants).toHaveLength(2); // ← fails on content-dedup, passes on identity
    expect(assistants.map((r: any) => r.content)).toEqual(['Done.', 'Done.']);
  });

  it('S4: replay overlapping an already-persisted range creates zero duplicates', () => {
    const s1 = mkStream(null);
    s1._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'Done.', seq: 5 });
    s1._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 6 });
    s1._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'Done.', seq: 7 });
    s1._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 8 });
    s1._persistSeqNow();
    expect(rows('assistant')).toHaveLength(2);

    // Stale-cursor replay re-delivers EVERYTHING.
    const s2 = mkStream(4);
    replayThrough(s2, [
      { event: 'assistant_text', delta: 'Done.', seq: 5 },
      { event: 'stop', subtype: 'end_turn', seq: 6 },
      { event: 'assistant_text', delta: 'Done.', seq: 7 },
      { event: 'stop', subtype: 'end_turn', seq: 8 },
    ]);
    s2._persistSeqNow();

    expect(rows('assistant')).toHaveLength(2); // unchanged
  });

  it('S6: pending SUCCEEDS but message row FAILS — replay repairs the row without re-notifying (16.2)', () => {
    const s1 = mkStream(null);
    skipInserts = 1;      // pending insert passes…
    failNextInserts = 1;  // …the user_question message row fails
    s1._onAgentEvent({ event: 'user_question', session_id: SID, id: 'q2', questions: [{ question: 'go?' }], seq: 50 });
    s1._persistSeqNow();

    const pendings = db.select().from(schema.claudePendingQuestions).all()
      .filter((r: any) => r.sessionId === SID);
    expect(pendings).toHaveLength(1);           // pending survived
    expect(rows('user_question')).toHaveLength(0); // row did not
    expect(persistedCursor()).toBe(49);         // cursor pinned → replay

    // Restart: the pending's presence must NOT short-circuit the repair.
    const s2 = mkStream(persistedCursor());
    replayThrough(s2, [
      { event: 'user_question', id: 'q2', questions: [{ question: 'go?' }], seq: 50 },
    ]);
    s2._persistSeqNow();

    const pendings2 = db.select().from(schema.claudePendingQuestions).all()
      .filter((r: any) => r.sessionId === SID);
    expect(pendings2).toHaveLength(1);            // still exactly one pending
    expect(rows('user_question')).toHaveLength(1); // row REPAIRED
    expect(persistedCursor()).toBe(50);            // cursor may now advance
  });

  it('S6bis: same repair for exit_plan_request', () => {
    const s1 = mkStream(null);
    skipInserts = 1;
    failNextInserts = 1;
    s1._onAgentEvent({ event: 'exit_plan_request', session_id: SID, id: 'p1', plan: 'the plan', seq: 60 });
    s1._persistSeqNow();
    expect(rows('exit_plan_request')).toHaveLength(0);
    expect(persistedCursor()).toBe(59);

    const s2 = mkStream(persistedCursor());
    replayThrough(s2, [
      { event: 'exit_plan_request', id: 'p1', plan: 'the plan', seq: 60 },
    ]);
    s2._persistSeqNow();
    const pendings = db.select().from(schema.claudePendingQuestions).all()
      .filter((r: any) => r.sessionId === SID);
    expect(pendings).toHaveLength(1);
    expect(rows('exit_plan_request')).toHaveLength(1);
    expect(persistedCursor()).toBe(60);
  });

  it('orderChronologically: repaired rows sort back into place, null-seq rows stay anchored', () => {
    const rowsIn = [
      { id: 1, seq: 10, role: 'assistant' },
      { id: 2, seq: null, role: 'user' },      // anchored at watermark 10
      { id: 3, seq: 30, role: 'tool_use' },
      { id: 4, seq: 31, role: 'tool_result' },
      { id: 5, seq: 20, role: 'assistant' },   // REPAIRED row (late insert, old seq)
      { id: 6, seq: null, role: 'user' },      // must NOT be dragged back by id 5
    ];
    const ordered = orderChronologically(rowsIn as any).map((r: any) => r.id);
    expect(ordered).toEqual([1, 2, 5, 3, 4, 6]);
    // Fully-legacy sessions (all null): exact id order preserved.
    const legacy = [{ id: 3, seq: null }, { id: 1, seq: null }, { id: 2, seq: null }];
    expect(orderChronologically(legacy as any).map((r: any) => r.id)).toEqual([1, 2, 3]);
  });

  it('S5: failed pending insert leaves nothing half-written; restart replay redoes both', () => {
    const s1 = mkStream(null);
    failNextInserts = 1; // the pending-question insert fails
    s1._onAgentEvent({ event: 'user_question', session_id: SID, id: 'q1', questions: [{ question: 'ok?' }], seq: 40 });
    s1._persistSeqNow();

    // Break-on-failure: no pending, no message row, cursor pinned below 40.
    const pendings = db.select().from(schema.claudePendingQuestions).all()
      .filter((r: any) => r.sessionId === SID);
    expect(pendings).toHaveLength(0);
    expect(rows('user_question')).toHaveLength(0);
    expect(persistedCursor()).toBe(39);

    const s2 = mkStream(persistedCursor());
    replayThrough(s2, [
      { event: 'user_question', id: 'q1', questions: [{ question: 'ok?' }], seq: 40 },
    ]);
    s2._persistSeqNow();

    const pendings2 = db.select().from(schema.claudePendingQuestions).all()
      .filter((r: any) => r.sessionId === SID);
    expect(pendings2).toHaveLength(1);
    expect(rows('user_question')).toHaveLength(1);
  });
});
