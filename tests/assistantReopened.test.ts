import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Reopened partial rows (sync refonte C08). A SIGTERM flush
// (`flushPendingAssistant`) persists the open answer as row X stamped with its
// FIRST delta's seq while the durable cursor stays below it, so the restart
// replay re-delivers the deltas from there. The hub used to re-broadcast the
// whole text next to X (shown twice until the boundary). Now: no frame while
// the replayed buffer stays inside X's text, ONE `assistant_reopened{rowId:X,
// length}` when it passes it, then only the remainder; the boundary extends
// X and announces `assistant_flushed{rowId:X, content}` (or `duplicate` when
// the replay equals X). The session GET mirrors it as `streamingExtends`.

const pool = vi.hoisted(() => ({
  client: {
    setAfterSeq: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    resubscribe: () => {},
    call: async (..._args: any[]): Promise<any> => ({ ok: true }),
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
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

const VPS_ID = 'reopenvps';
const SID = 'e'.repeat(32);
const GET_SID = 'd'.repeat(32);      // registered stream (session GET)
const T0 = Date.now() - 3_600_000;

let db: any;
let schema: any;
let SessionStream: any;
let getOrCreateStream: any;
// Fail the next N INSERTs into session_messages.
let failMessageInserts = 0;

function mkStream(lastSeenSeq: number | null = null, id = SID) {
  return new SessionStream({
    id, vpsId: VPS_ID, name: null,
    status: 'active', permissionMode: 'normal', nativeSessionId: null,
    kind: 'claude', lastSeenSeq,
  }) as any;
}

function ev(event: string, seq: number, extra: Record<string, unknown> = {}, sid = SID) {
  return { event, session_id: sid, seq, ts: (T0 + seq) / 1000, ...extra };
}
const text = (seq: number, delta: string, sid = SID) => ev('assistant_text', seq, { delta }, sid);
const toolUse = (seq: number, sid = SID) => ev('tool_use', seq, { id: `t${seq}`, name: 'Read', input: {} }, sid);

function send(s: any, events: any[]) {
  for (const e of events) s._onAgentEvent(e);
}

function assistantRows(sid = SID) {
  return db.select().from(schema.sessionMessages).all()
    .filter((r: any) => r.sessionId === sid && r.role === 'assistant')
    .sort((a: any, b: any) => a.id - b.id);
}

function spyFrames(s: any) {
  const spy = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
  return () => spy.mock.calls.map(([f]: any[]) => f);
}

/** The live run: deltas 10/11, then the hub is SIGTERMed (shutdown flush). */
function sigtermPartial(sid = SID): number {
  const live = mkStream(null, sid);
  send(live, [text(10, 'Hello', sid), text(11, ' wor', sid)]);
  live.flushPendingAssistant();
  const [x] = assistantRows(sid);
  expect(x).toMatchObject({ content: 'Hello wor', seq: 10, tsMs: T0 + 10 });
  return x.id;
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  for (const id of [SID, GET_SID]) {
    db.insert(schema.agentSessions).values({ id, vpsId: VPS_ID, cwd: '/tmp', status: 'active' }).onConflictDoNothing().run();
  }
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  const realInsert = db.insert.bind(db);
  vi.spyOn(db, 'insert').mockImplementation(((table: any) => {
    if (failMessageInserts > 0 && table === schema.sessionMessages) {
      failMessageInserts--;
      const boom = () => { throw new Error('injected DB failure'); };
      return { values: () => ({ run: boom, onConflictDoNothing: () => ({ run: boom }) }) };
    }
    return realInsert(table);
  }) as any);
  ({ SessionStream, getOrCreateStream } = await import('@/lib/server/agent/sessionOps'));
});

afterEach(() => {
  failMessageInserts = 0;
  for (const id of [SID, GET_SID]) {
    db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, id)).run();
  }
  db.update(schema.agentSessions).set({ lastSeenSeq: null, pendingAssistantMessageId: null }).run();
});

describe('a replay extending a SIGTERM partial row', () => {
  it('sends nothing inside the prefix, ONE assistant_reopened, then only the remainder; the cut extends X', () => {
    const x = sigtermPartial();
    const s = mkStream(9);
    const frames = spyFrames(s);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 5 });
    send(s, [text(10, 'Hello'), text(11, ' wor')]);
    expect(frames()).toEqual([]);                                   // inside X: already rendered
    expect(s.getStreamingExtends()).toEqual({ rowId: x, length: 9 });
    send(s, [text(12, 'ld'), text(13, '!'), toolUse(14)]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(frames().map((f: any) => f.type)).toEqual(['assistant_reopened', 'assistant_text', 'assistant_flushed', 'tool_use']);
    const [reopened, remainder, flushed] = frames();
    expect(reopened).toEqual({ type: 'assistant_reopened', rowId: x, length: 9, replay: true });
    expect(remainder).toEqual({ type: 'assistant_text', delta: 'ld!', replay: true });
    expect(flushed).toEqual({
      type: 'assistant_flushed', rowId: x, length: 12, tsMs: T0 + 10, model: null, content: 'Hello world!', replay: true,
    });
    expect(assistantRows().map((r: any) => [r.id, r.content])).toEqual([[x, 'Hello world!']]);
    expect(s.getStreamingExtends()).toBeNull();                       // reset with the buffer
  });

  it('a replay equal to X sends zero text frames and a duplicate cut', () => {
    const x = sigtermPartial();
    const s = mkStream(9);
    const frames = spyFrames(s);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
    send(s, [text(10, 'Hello'), text(11, ' wor'), toolUse(14)]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(frames().filter((f: any) => f.type === 'assistant_text' || f.type === 'assistant_reopened')).toEqual([]);
    expect(frames().filter((f: any) => f.type === 'assistant_flushed')).toEqual([{
      type: 'assistant_flushed', rowId: x, length: 9, tsMs: T0 + 10, model: null, duplicate: true, replay: true,
    }]);
    expect(assistantRows().map((r: any) => r.content)).toEqual(['Hello wor']);
  });

  it('a replay that stops short of X then reaches a gated boundary drops it as duplicate, no text', () => {
    const x = sigtermPartial();
    // The boundary's row already exists (the live run wrote it before dying).
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't12', name: 'Read', input: {} }),
      seq: 12, tsMs: T0 + 12,
    }).run();
    const s = mkStream(9);
    const frames = spyFrames(s);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
    send(s, [text(10, 'Hello'), text(11, ' wor'), toolUse(12)]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(frames().map((f: any) => [f.type, f.rowId, f.duplicate])).toEqual([['assistant_flushed', x, true]]);
  });

  it('the remainder keeps streaming LIVE after the replay ended; the live stop extends X', () => {
    const x = sigtermPartial();
    const s = mkStream(9);
    const frames = spyFrames(s);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 2 });
    send(s, [text(10, 'Hello'), text(11, ' wor')]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    send(s, [text(12, 'ld'), text(13, '!'), ev('stop', 14, { subtype: 'success' })]);
    expect(frames().filter((f: any) => f.type.startsWith('assistant_'))).toEqual([
      { type: 'assistant_reopened', rowId: x, length: 9 },
      { type: 'assistant_text', delta: 'ld', replay: true },
      { type: 'assistant_text', delta: '!' },
      { type: 'assistant_flushed', rowId: x, length: 12, tsMs: T0 + 10, model: null, content: 'Hello world!' },
    ]);
    expect(assistantRows().map((r: any) => r.content)).toEqual(['Hello world!']);
  });

  it('a replay diverging from X re-sends the whole buffer once (identity decides at the cut)', () => {
    const x = sigtermPartial();
    const s = mkStream(9);
    const frames = spyFrames(s);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
    send(s, [text(10, 'Hel'), text(11, 'p!'), toolUse(14)]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(frames().filter((f: any) => f.type === 'assistant_reopened')).toEqual([]);
    expect(frames().filter((f: any) => f.type === 'assistant_text').map((f: any) => f.delta).join('')).toBe('Help!');
    expect(frames().find((f: any) => f.type === 'assistant_flushed')).toMatchObject({ rowId: x, duplicate: true });
    expect(s.getStreamingExtends()).toBeNull();
  });

  it('a buffer KEPT for its longer row stays reopened: nothing re-sent across the repaired boundary', () => {
    // Live: the flush at tool_use 12 failed, the buffer ran on and landed at 15.
    const live = mkStream();
    send(live, [text(10, 'Hello ')]);
    failMessageInserts = 1;
    send(live, [toolUse(12), text(13, 'world'), toolUse(15)]);
    const [x] = assistantRows();
    expect(x.content).toBe('Hello world');
    // Restart replay from the anchor: tool_use 12 is repaired between them.
    const s = mkStream(9);
    const frames = spyFrames(s);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 4 });
    send(s, [text(10, 'Hello '), toolUse(12), text(13, 'world'), toolUse(15)]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(frames().filter((f: any) => f.type === 'assistant_text' || f.type === 'assistant_reopened')).toEqual([]);
    expect(frames().map((f: any) => [f.type, f.rowId, f.duplicate])).toEqual([
      ['tool_use', expect.any(Number), undefined],
      ['assistant_flushed', x.id, true],
    ]);
    expect(assistantRows().map((r: any) => r.content)).toEqual(['Hello world']);
  });

  it('a failed extend keeps the reopened row: the retry still extends it and nothing is re-sent', () => {
    const x = sigtermPartial();
    const s = mkStream(9);
    const frames = spyFrames(s);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 5 });
    send(s, [text(10, 'Hello'), text(11, ' wor'), text(12, 'ld')]);
    // The extend is an UPDATE: fail it through the row lookup's write path.
    const realUpdate = db.update.bind(db);
    const spy = vi.spyOn(db, 'update').mockImplementationOnce((() => ({
      set: () => ({ where: () => ({ run: () => { throw new Error('injected DB failure'); } }) }),
    })) as any);
    send(s, [toolUse(14)]);
    spy.mockImplementation(realUpdate);
    expect(frames().filter((f: any) => f.type === 'assistant_flushed')).toEqual([]);
    expect(s.getStreamingExtends()).toEqual({ rowId: x, length: 9 });
    send(s, [text(15, '!'), toolUse(16)]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(frames().filter((f: any) => f.type === 'assistant_reopened')).toHaveLength(1);
    expect(frames().filter((f: any) => f.type === 'assistant_flushed')).toEqual([
      expect.objectContaining({ rowId: x, content: 'Hello world!' }),
    ]);
    expect(assistantRows().map((r: any) => r.content)).toEqual(['Hello world!']);
    spy.mockRestore();
  });

  it('a buffer with no row at its anchor streams as before (no reopen)', () => {
    const s = mkStream(0);
    const frames = spyFrames(s);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 2 });
    send(s, [text(1, 'Fresh '), text(2, 'answer')]);
    expect(s.getStreamingExtends()).toBeNull();
    send(s, [toolUse(3)]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(frames().map((f: any) => f.type)).toEqual(['assistant_text', 'assistant_flushed', 'tool_use']);
    expect(frames()[0].delta).toBe('Fresh answer');
    expect(frames()[1]).not.toHaveProperty('content');
  });
});

describe('session GET during the replay', () => {
  const get = async () => {
    const { GET } = await import('@/app/api/sessions/[id]/route');
    return (await GET(new Request(`http://localhost/api/sessions/${GET_SID}?open=1`),
      { params: Promise.resolve({ id: GET_SID }) })).json();
  };

  it('returns streamingExtends {rowId:X, length} and only the text past X; features advertised', async () => {
    const x = sigtermPartial(GET_SID);
    const s = getOrCreateStream(GET_SID);
    s._onAgentEvent({ event: 'replay_begin', session_id: GET_SID, count: 4 });
    send(s, [text(10, 'Hello', GET_SID), text(11, ' wor', GET_SID)]);
    const inside = await get();
    expect(inside.streamingExtends).toEqual({ rowId: x, length: 9 });
    expect(inside.streamingText).toBe('');
    expect(inside.messages.filter((m: any) => m.role === 'assistant').map((m: any) => [m.id, m.content])).toEqual([[x, 'Hello wor']]);
    expect(inside.features).toEqual(['assistant_flushed', 'thinking_flushed', 'assistant_reopened', 'row_ids', 'client_message_id']);
    send(s, [text(12, 'ld', GET_SID)]);
    const past = await get();
    expect(past.streamingExtends).toEqual({ rowId: x, length: 9 });
    expect(past.streamingText).toBe('ld');
    send(s, [toolUse(13, GET_SID)]);
    s._onAgentEvent({ event: 'replay_end', session_id: GET_SID });
    const done = await get();
    expect(done.streamingExtends).toBeNull();
    expect(done.streamingText).toBe('');
    expect(done.messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content)).toEqual(['Hello world']);
  });

  it('streamingText is the whole buffer when nothing is reopened', async () => {
    const s = getOrCreateStream(GET_SID);
    send(s, [text(30, 'Live ', GET_SID), text(31, 'text', GET_SID)]);
    const r = await get();
    expect(r.streamingExtends).toBeNull();
    expect(r.streamingText).toBe('Live text');
    send(s, [toolUse(32, GET_SID)]);
  });
});

describe('a hub-only cut the restart replay cannot reproduce (`plan_progress` is transient agent-side)', () => {
  function codexStream(lastSeenSeq: number | null) {
    return new SessionStream({
      id: SID, vpsId: VPS_ID, name: null,
      status: 'active', permissionMode: 'normal', nativeSessionId: null,
      kind: 'codex', lastSeenSeq,
    }) as any;
  }
  // No seq: the agent never logs it, so a replay never re-delivers it.
  const planProgress = { event: 'plan_progress', session_id: SID, id: 'plan-1', text: '1. step' };

  /** The live run: delta 10, the hub's plan_progress cut (row X), delta 11,
   *  then a SIGTERM flush (row Y) with the durable cursor still ≤ 9. */
  function liveRunCutByPlanProgress(): { x: number; y: number } {
    const live = codexStream(null);
    send(live, [text(10, 'Alpha. '), planProgress, text(11, 'Beta. ')]);
    live.flushPendingAssistant();
    const rows = assistantRows();
    expect(rows.map((r: any) => [r.seq, r.content])).toEqual([[10, 'Alpha. '], [11, 'Beta. ']]);
    return { x: rows[0].id, y: rows[1].id };
  }

  it('the replay re-cuts at the delta that has its own row: each text written once, nothing re-sent', () => {
    const { x, y } = liveRunCutByPlanProgress();
    const s = codexStream(9);
    const frames = spyFrames(s);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 2 });
    send(s, [text(10, 'Alpha. '), text(11, 'Beta. ')]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    send(s, [text(12, 'Gamma.'), ev('stop', 13, { subtype: 'success' })]);

    expect(assistantRows().map((r: any) => [r.id, r.content])).toEqual([[x, 'Alpha. '], [y, 'Beta. Gamma.']]);
    expect(assistantRows().map((r: any) => r.content).join('')).toBe('Alpha. Beta. Gamma.');
    expect(frames().filter((f: any) => f.type.startsWith('assistant_'))).toEqual([
      { type: 'assistant_flushed', rowId: x, length: 7, tsMs: T0 + 10, model: null, duplicate: true, replay: true },
      { type: 'assistant_reopened', rowId: y, length: 6 },
      { type: 'assistant_text', delta: 'Gamma.', replay: true },
      { type: 'assistant_flushed', rowId: y, length: 12, tsMs: T0 + 11, model: null, content: 'Beta. Gamma.' },
    ]);
  });

  it('a replay ending inside the second row leaves both rows as they were', () => {
    const { x, y } = liveRunCutByPlanProgress();
    const s = codexStream(9);
    const frames = spyFrames(s);
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
    send(s, [text(10, 'Alpha. '), text(11, 'Beta. '), toolUse(12)]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(assistantRows().map((r: any) => [r.id, r.content])).toEqual([[x, 'Alpha. '], [y, 'Beta. ']]);
    expect(frames().filter((f: any) => f.type === 'assistant_text' || f.type === 'assistant_reopened')).toEqual([]);
    expect(frames().filter((f: any) => f.type === 'assistant_flushed').map((f: any) => [f.rowId, f.duplicate]))
      .toEqual([[x, true], [y, true]]);
  });
});

describe('replay cost of a long answer (G1: no whole-buffer compare per delta)', () => {
  const DELTA = 'abcdefghijklmnopqrs ';           // 20 chars
  const deltas = (from: number, n: number) => Array.from({ length: n }, (_, i) => text(from + i, `${DELTA.slice(0, 15)}${String(i).padStart(5, '0')}`));

  /** Count `startsWith` calls comparing a LONG argument (a whole buffer). */
  function countLongCompares(run: () => void): number {
    const orig = String.prototype.startsWith;
    let long = 0;
    const spy = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (this: string, search: string, pos?: number) {
      if (typeof search === 'string' && search.length > 10_000) long++;
      return orig.call(this, search, pos);
    });
    try { run(); } finally { spy.mockRestore(); }
    return long;
  }

  it('a ~100 KB reopened answer replays with O(1) whole-buffer compares', () => {
    const live = mkStream(null);
    const n = 5000;
    send(live, deltas(10, n));
    live.flushPendingAssistant();
    const [x] = assistantRows();
    expect(x.content.length).toBe(n * 20);
    const s = mkStream(9);
    const frames = spyFrames(s);
    const long = countLongCompares(() => {
      s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: n + 2 });
      send(s, deltas(10, n));
      send(s, [text(10 + n, 'END'), toolUse(11 + n)]);
      s._onAgentEvent({ event: 'replay_end', session_id: SID });
    });
    expect(long).toBeLessThanOrEqual(4);
    expect(frames().filter((f: any) => f.type === 'assistant_text')).toEqual([{ type: 'assistant_text', delta: 'END', replay: true }]);
    expect(assistantRows().map((r: any) => [r.id, r.content.length])).toEqual([[x.id, n * 20 + 3]]);
  });

  it('a buffer kept for a LONGER row (guide) runs on with O(1) whole-buffer compares', () => {
    // Live: the flush at the first boundary fails, the buffer runs on past
    // it, and the second boundary persists the whole answer as ONE row.
    const live = mkStream(null);
    const n = 2500;
    send(live, deltas(10, n));
    failMessageInserts = 1;
    send(live, [toolUse(10 + n)]);
    expect(failMessageInserts).toBe(0);
    send(live, deltas(11 + n, n));
    send(live, [toolUse(11 + 2 * n)]);
    const rows = assistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content.length).toBe(2 * n * 20);

    const s = mkStream(9);
    const long = countLongCompares(() => {
      s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 2 * n + 2 });
      send(s, deltas(10, n));
      send(s, [toolUse(10 + n)]);
      send(s, deltas(11 + n, n));
      send(s, [toolUse(11 + 2 * n)]);
      s._onAgentEvent({ event: 'replay_end', session_id: SID });
    });
    expect(long).toBeLessThanOrEqual(6);
    expect(assistantRows().map((r: any) => r.content)).toEqual([rows[0].content]);
  });
});
