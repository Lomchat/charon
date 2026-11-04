import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Sync refonte C06 (§14.31/§14.71): an agent whose durable log was recreated
// restarts its seqs at 1, below the hub's cursor. AgentClient detects it from
// a READABLE subscribe answer (`current_seq < after_seq`) and dispatches ONE
// synthetic `seq_epoch_reset` per session per connection; the stream flushes
// its old-epoch buffers, resets its cursors and replays the new log from 0.
// Nothing dropped, nothing duplicated; no old stop re-finished.

const pool = vi.hoisted(() => ({
  resubscribe: [] as Array<[string, unknown]>,
  afterSeq: [] as Array<[string, unknown]>,
  backpressured: true,
}));
const pushMocks = vi.hoisted(() => ({ sendPushToAll: vi.fn(async (_p: any) => {}) }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/hub/webPush', () => pushMocks);
vi.mock('@/lib/server/hub/codexBgState', () => ({ readCodexBgState: async () => [] }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: async () => {},
  sendQuestionToTelegram: async () => {},
  markInteractionResolvedInTelegram: async () => {},
  sendPlainToTelegram: async () => {},
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: (sid: string, s: unknown) => { pool.afterSeq.push([sid, s]); },
    subscribe: () => {}, unsubscribe: () => {},
    resubscribe: (sid: string, opts: unknown) => { pool.resubscribe.push([sid, opts]); },
    backpressuresReplay: () => pool.backpressured,
    call: async () => ({ ok: true }),
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

import { AgentClient } from '@/lib/server/agent/AgentClient';
import type { Vps } from '@/lib/db/schema';

const VPS_ID = 'epochvps';
const SID = '7'.repeat(32);

// ── AgentClient: detection ────────────────────────────────────────────────
describe('AgentClient: seq_epoch_reset detection', () => {
  beforeEach(() => { vi.useRealTimers(); });
  function client(answer: () => Record<string, unknown>) {
    const c = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    (c as any).call = (method: string) => Promise.resolve(method === 'subscribe' ? answer() : {});
    c.status = 'connected';
    const events: any[] = [];
    c.subscribe('s1', (ev) => events.push(ev), { afterSeq: 4000 });
    return { c, events, resets: () => events.filter((e) => e.event === 'seq_epoch_reset') };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it('a readable log below the cursor ⇒ ONE synthetic event per connection', async () => {
    const { c, resets } = client(() => ({ ok: true, replay_count: 0, current_seq: 5, earliest_seq: 1 }));
    await flush();
    expect(resets()).toEqual([{ event: 'seq_epoch_reset', session_id: 's1', after_seq: 4000, current_seq: 5 }]);
    // The same connection answering the same again (a second subscribe): no repeat.
    await (c as any)._fireSubscribe('s1', { afterSeq: 4000 });
    expect(resets()).toHaveLength(1);
    // A new connection clears the once-per-connection guard (hello path).
    (c as any).epochResetFired.clear();
    await (c as any)._fireSubscribe('s1', { afterSeq: 4000 });
    expect(resets()).toHaveLength(2);
  });

  it('an unreadable log (current_seq 0, earliest_seq null) is no reset', async () => {
    const { resets } = client(() => ({ ok: true, replay_count: 0, current_seq: 0, earliest_seq: null }));
    await flush();
    expect(resets()).toEqual([]);
  });

  it.each([
    ['earliest_seq null', { current_seq: 5, earliest_seq: null }],
    ['current_seq missing (old agent)', {}],
    ['current_seq at the cursor', { current_seq: 4000, earliest_seq: 1 }],
    ['current_seq above the cursor', { current_seq: 4100, earliest_seq: 1 }],
  ])('%s ⇒ none', async (_label, fields) => {
    const { resets } = client(() => ({ ok: true, replay_count: 0, ...fields }));
    await flush();
    expect(resets()).toEqual([]);
  });

  it('the reset is dispatched WITH the answer line, before held live events of the same chunk', () => {
    const c = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    const writes: string[] = [];
    (c as any).child = { stdin: { write: (l: string) => { writes.push(l); return true; } } };
    c.status = 'connected';
    const order: string[] = [];
    c.subscribe('s1', (ev: any) => order.push(ev.seq != null ? `${ev.event}:${ev.seq}` : ev.event), { afterSeq: 4000 });
    const req = JSON.parse(writes[0]);
    expect(req).toMatchObject({ method: 'subscribe', params: { session_id: 's1', after_seq: 4000 } });
    const line = (o: unknown) => JSON.stringify(o) + '\n';
    (c as any)._onStdout(Buffer.from(
      line({ id: req.id, result: { ok: true, replay_count: 0, current_seq: 5, earliest_seq: 1 } })
      + line({ event: 'assistant_text', session_id: 's1', seq: 6, delta: 'abc' })
      + line({ event: 'assistant_text', session_id: 's1', seq: 7, delta: 'def' }),
    ));
    expect(order).toEqual(['seq_epoch_reset', 'assistant_text:6', 'assistant_text:7']);
  });

  it('the reset replay from 0 joins a running reconnect chain instead of bursting beside it', async () => {
    const c = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    const fired: Array<[string, unknown]> = [];
    (c as any)._fireSubscribe = (sid: string, opts?: { afterSeq?: number }) => {
      fired.push([sid, opts?.afterSeq ?? (c as any)._pendingAfterSeq.get(sid)]);
      return Promise.resolve();
    };
    c.status = 'connected';
    c.subscribe('s1', () => {}, { afterSeq: 4000 });
    c.subscribe('s2', () => {}, { afterSeq: 10 });
    fired.length = 0;
    (c as any).chainPending = new Set(['s2']);
    c.resubscribe('s1', { afterSeq: 0 });
    expect(fired).toEqual([]);  // nothing fired out of turn
    expect([...(c as any).chainPending]).toEqual(['s2', 's1']);
    expect((c as any)._pendingAfterSeq.get('s1')).toBe(0);
    // Without a chain, the explicit range fires at once.
    (c as any).chainPending = null;
    c.resubscribe('s1', { afterSeq: 0 });
    expect(fired).toEqual([['s1', 0]]);
  });

  it('backpressuresReplay follows the hello version', () => {
    const c = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    expect(c.backpressuresReplay()).toBe(false);
    c.hello = { agent_version: '0.102.9' } as any;
    expect(c.backpressuresReplay()).toBe(false);
    c.hello = { agent_version: '0.103.0' } as any;
    expect(c.backpressuresReplay()).toBe(true);
  });

  it('a cursor-less (ring) subscribe is never a reset', async () => {
    const c = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    (c as any).call = () => Promise.resolve({ ok: true, current_seq: 5, earliest_seq: 1 });
    c.status = 'connected';
    const events: any[] = [];
    c.subscribe('s1', (ev) => events.push(ev));
    await flush();
    expect(events).toEqual([]);
  });
});

// ── SessionStream: the reset ──────────────────────────────────────────────
let db: any;
let schema: any;
let SessionStream: any;
let hubHooks: typeof import('@/lib/server/agent/hubHooks').hubHooks;
const T_OLD = Date.now() - 3_600_000;   // the old epoch
const T_NEW = Date.now() - 60_000;      // the recreated log

function rows(): any[] {
  return db.select().from(schema.sessionMessages).all()
    .filter((r: any) => r.sessionId === SID).sort((a: any, b: any) => a.id - b.id);
}
function sessionRow(): any {
  return db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, SID)).get();
}
function eventType(r: any): string | null {
  if (r.role !== 'event') return null;
  try { return JSON.parse(r.content).type ?? null; } catch { return null; }
}
function thinkingText(r: any): string {
  return JSON.parse(r.content).text;
}

function mkStream(kind: 'claude' | 'codex' = 'codex') {
  const row = sessionRow();
  const s = new SessionStream({
    id: SID, vpsId: VPS_ID, vpsName: 'v', name: 'n', status: 'thinking',
    permissionMode: kind === 'codex' ? 'workspace-write' : 'normal', nativeSessionId: null, kind,
    lastSeenSeq: row.lastSeenSeq, lastStopNotifiedSeq: row.lastStopNotifiedSeq,
  }) as any;
  const frames: any[] = [];
  vi.spyOn(s, '_emitBroadcast').mockImplementation(((f: any) => { frames.push(f); }) as any);
  return { s, frames };
}
const oldEv = (seq: number, e: Record<string, unknown>) => ({ session_id: SID, seq, ts: (T_OLD + seq) / 1000, ...e });
const newEv = (seq: number, e: Record<string, unknown>) => ({ session_id: SID, seq, ts: (T_NEW + seq) / 1000, ...e });
const reset = { event: 'seq_epoch_reset', session_id: SID, after_seq: 4000, current_seq: 5 };
const begin = { event: 'replay_begin', session_id: SID, count: 9 };
const end = { event: 'replay_end', session_id: SID };

/** Text the browser received for a lane (live and replayed deltas). */
function laneText(s: any, frames: any[], lane: 'assistant' | 'thinking'): string {
  s._flushAssistantBroadcast?.();
  return frames.filter((f) => f.type === (lane === 'assistant' ? 'assistant_text' : 'thinking'))
    .map((f) => (lane === 'assistant' ? f.delta : f.text) ?? '').join('');
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'v', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  ({ SessionStream } = await import('@/lib/server/agent/sessionOps'));
  ({ hubHooks } = await import('@/lib/server/agent/hubHooks'));
  await import('@/lib/server/agent/endpointOps');
});

beforeEach(() => {
  vi.useFakeTimers();
  pool.resubscribe = [];
  pool.afterSeq = [];
  pool.backpressured = true;
  pushMocks.sendPushToAll.mockClear();
  hubHooks().focusChecker = undefined;
  db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
  db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, SID)).run();
  db.insert(schema.agentSessions).values({
    id: SID, vpsId: VPS_ID, cwd: '/tmp', name: 'n', status: 'thinking',
    lastSeenSeq: 3990, lastStopNotifiedSeq: 3989,
  }).run();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('SessionStream: seq_epoch_reset', () => {
  it.each(['assistant', 'thinking'] as const)(
    'an open old-epoch %s buffer + new-epoch deltas 1..5 live and replayed from 0 ⇒ each text once',
    (lane) => {
      const { s, frames } = mkStream('codex');
      const delta = (mk: typeof oldEv, seq: number, text: string) => mk(seq, lane === 'assistant'
        ? { event: 'assistant_text', delta: text } : { event: 'thinking', text });
      // Old epoch: a buffer left open at 3998..4000.
      s._onAgentEvent(delta(oldEv, 3998, 'Old '));
      s._onAgentEvent(delta(oldEv, 3999, 'epoch '));
      s._onAgentEvent(delta(oldEv, 4000, 'text.'));
      s._onAgentEvent(reset);
      // (1) The old buffer is persisted as its own row, at its own seq/ts.
      const afterReset = rows();
      expect(afterReset).toHaveLength(1);
      expect(lane === 'assistant' ? afterReset[0].content : thinkingText(afterReset[0])).toBe('Old epoch text.');
      expect(afterReset[0]).toMatchObject({ seq: 3998, tsMs: T_OLD + 3998 });
      // (3)(4) cursors reset and persisted; (5) the new log replays from 0.
      expect(sessionRow()).toMatchObject({ lastSeenSeq: 0, lastStopNotifiedSeq: null });
      expect(pool.resubscribe).toEqual([[SID, { afterSeq: 0 }]]);
      // New epoch, live first (the agent streams before the replay lands)…
      const parts = ['a', 'b', 'c', 'd', 'e'];
      parts.forEach((p, i) => s._onAgentEvent(delta(newEv, i + 1, p)));
      // …then the replay from 0 re-delivers 1..5.
      s._onAgentEvent(begin);
      parts.forEach((p, i) => s._onAgentEvent(delta(newEv, i + 1, p)));
      s._onAgentEvent(end);
      s._onAgentEvent(newEv(6, { event: 'tool_use', id: 'tu-new', name: 'Read', input: {} }));
      const all = rows();
      const laneRows = all.filter((r) => (lane === 'assistant' ? r.role === 'assistant' : eventType(r) === 'thinking'));
      expect(laneRows.map((r) => (lane === 'assistant' ? r.content : thinkingText(r)))).toEqual(['Old epoch text.', 'abcde']);
      expect(laneRows[1]).toMatchObject({ seq: 1, tsMs: T_NEW + 1 });
      expect(laneText(s, frames, lane)).toBe('Old epoch text.abcde');
      expect(all.filter((r) => r.role === 'tool_use')).toHaveLength(1);
    },
  );

  it('the reset replay from 0 (no live copy) persists the new text once; a second replay adds nothing', () => {
    const { s } = mkStream('codex');
    s._onAgentEvent(oldEv(4000, { event: 'assistant_text', delta: 'Old.' }));
    s._onAgentEvent(reset);
    const replay = () => {
      s._onAgentEvent(begin);
      s._onAgentEvent(newEv(1, { event: 'assistant_text', delta: 'New ' }));
      s._onAgentEvent(newEv(2, { event: 'assistant_text', delta: 'answer.' }));
      s._onAgentEvent(newEv(3, { event: 'tool_use', id: 'tu-1', name: 'Read', input: {} }));
      s._onAgentEvent(end);
    };
    replay();
    replay();
    expect(rows().map((r) => [r.role, r.content.startsWith('{') ? JSON.parse(r.content).id ?? '' : r.content]))
      .toEqual([['assistant', 'Old.'], ['assistant', 'New answer.'], ['tool_use', 'tu-1']]);
  });

  it('new-epoch events reusing old seqs, with new ts, are persisted', () => {
    const { s } = mkStream('claude');
    // Old epoch rows at seqs 3 and 4.
    s._onAgentEvent(oldEv(3, { event: 'tool_use', id: 'old-3', name: 'Read', input: {} }));
    s._onAgentEvent(oldEv(4, { event: 'tool_result', tool_use_id: 'old-3', content: 'old', is_error: false }));
    s._onAgentEvent(reset);
    s._onAgentEvent(begin);
    s._onAgentEvent(newEv(3, { event: 'tool_use', id: 'new-3', name: 'Read', input: {} }));
    s._onAgentEvent(newEv(4, { event: 'tool_result', tool_use_id: 'new-3', content: 'new', is_error: false }));
    s._onAgentEvent(end);
    const tools = rows().filter((r) => r.role === 'tool_use' || r.role === 'tool_result');
    expect(tools.map((r) => [r.role, r.seq])).toEqual([['tool_use', 3], ['tool_result', 4], ['tool_use', 3], ['tool_result', 4]]);
  });

  it('the new stop marks unread; replayed stops at or below the floor do not, and set no status', async () => {
    const { s, frames } = mkStream('claude');
    s._onAgentEvent(oldEv(3995, { event: 'assistant_text', delta: 'Old answer.' }));
    s._onAgentEvent(oldEv(3996, { event: 'stop', subtype: 'success' }));
    expect(sessionRow().unreadStop).toBe(1);
    db.update(schema.agentSessions).set({ unreadStop: 0 }).where(eq(schema.agentSessions.id, SID)).run();
    pushMocks.sendPushToAll.mockClear();
    s._onAgentEvent(oldEv(3997, { event: 'status', status: 'thinking' }));
    s._onAgentEvent(reset);
    const floor = Math.max(...rows().map((r) => r.tsMs));
    frames.length = 0;
    // A stop the new log dates at/before the newest row at the reset: handled already.
    s._onAgentEvent(begin);
    s._onAgentEvent({ session_id: SID, seq: 1, ts: floor / 1000, event: 'stop', subtype: 'success' });
    s._onAgentEvent(end);
    expect(sessionRow().unreadStop).toBe(0);
    expect(frames.filter((f) => f.type === 'session_unread' || f.type === 'status')).toEqual([]);
    // The new epoch's own stop (replayed: unread, no push).
    s._onAgentEvent(begin);
    s._onAgentEvent(newEv(2, { event: 'assistant_text', delta: 'New answer.' }));
    s._onAgentEvent(newEv(3, { event: 'stop', subtype: 'success' }));
    s._onAgentEvent(end);
    expect(sessionRow()).toMatchObject({ unreadStop: 1, lastStopNotifiedSeq: 3 });
    expect(pushMocks.sendPushToAll).not.toHaveBeenCalled();
    // A live new-epoch stop pushes.
    db.update(schema.agentSessions).set({ unreadStop: 0 }).where(eq(schema.agentSessions.id, SID)).run();
    s._onAgentEvent(newEv(4, { event: 'status', status: 'thinking' }));
    s._onAgentEvent(newEv(5, { event: 'assistant_text', delta: 'Live.' }));
    s._onAgentEvent(newEv(6, { event: 'stop', subtype: 'success' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRow()).toMatchObject({ unreadStop: 1, lastStopNotifiedSeq: 6, status: 'active' });
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(1);
  });

  it('the floor filters only replayed stops: a live stop dated below it (clock skew) still marks unread', async () => {
    const { s } = mkStream('claude');
    s._onAgentEvent(oldEv(3995, { event: 'assistant_text', delta: 'Old answer.' }));
    s._onAgentEvent(oldEv(3996, { event: 'stop', subtype: 'success' }));
    db.update(schema.agentSessions).set({ unreadStop: 0 }).where(eq(schema.agentSessions.id, SID)).run();
    s._onAgentEvent(reset);
    const floor = Math.max(...rows().map((r) => r.tsMs));
    expect(s.stopNotifyFloorTsMs).toBe(floor);
    // The new box's clock lags: its live stop is dated before the floor.
    s._onAgentEvent({ session_id: SID, seq: 1, ts: (floor - 60_000) / 1000, event: 'status', status: 'thinking' });
    s._onAgentEvent({ session_id: SID, seq: 2, ts: (floor - 59_000) / 1000, event: 'stop', subtype: 'success' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRow()).toMatchObject({ unreadStop: 1, lastStopNotifiedSeq: 2 });
  });

  it('the floor is dropped at the reset replay real end', () => {
    const { s } = mkStream('claude');
    s._onAgentEvent(oldEv(3995, { event: 'assistant_text', delta: 'Old answer.' }));
    s._onAgentEvent(oldEv(3996, { event: 'stop', subtype: 'success' }));
    s._onAgentEvent(reset);
    expect(s.stopNotifyFloorTsMs).not.toBeNull();
    s._onAgentEvent(begin);
    s._onAgentEvent(end);
    expect(s.stopNotifyFloorTsMs).toBeNull();
  });

  it.each([true, false])('old buffer open=%s: held live deltas after the reset start a new-epoch row', (withOld) => {
    const { s } = mkStream('codex');
    if (withOld) {
      s._onAgentEvent(oldEv(3999, { event: 'assistant_text', delta: 'Old ' }));
      s._onAgentEvent(oldEv(4000, { event: 'assistant_text', delta: 'text.' }));
    }
    // The order AgentClient now dispatches: the reset with the answer line,
    // then the live deltas the agent held behind it.
    s._onAgentEvent(reset);
    s._onAgentEvent(newEv(6, { event: 'assistant_text', delta: 'abc' }));
    s._onAgentEvent(newEv(7, { event: 'assistant_text', delta: 'def' }));
    s._onAgentEvent(newEv(8, { event: 'assistant_text', delta: 'ghi' }));
    s._onAgentEvent(begin);
    s._onAgentEvent(newEv(5, { event: 'status', status: 'thinking' }));
    s._onAgentEvent(newEv(6, { event: 'assistant_text', delta: 'abc' }));
    s._onAgentEvent(newEv(7, { event: 'assistant_text', delta: 'def' }));
    s._onAgentEvent(newEv(8, { event: 'assistant_text', delta: 'ghi' }));
    s._onAgentEvent(end);
    s._onAgentEvent(newEv(9, { event: 'stop', subtype: 'success' }));
    const assistant = rows().filter((r) => r.role === 'assistant').map((r) => [r.content, r.seq]);
    expect(assistant).toEqual([...(withOld ? [['Old text.', 3999]] : []), ['abcdefghi', 6]]);
  });

  it('an agent < 0.103.0 is not asked for the whole new log: the cursor jumps, the hole is explicit', () => {
    pool.backpressured = false;
    const { s } = mkStream('codex');
    s._onAgentEvent(oldEv(4000, { event: 'assistant_text', delta: 'Old.' }));
    s._onAgentEvent(reset);
    expect(pool.resubscribe).toEqual([]);
    expect(pool.afterSeq).toContainEqual([SID, 5]);
    expect(sessionRow().lastSeenSeq).toBe(5);
    expect(rows().filter((r) => eventType(r) === 'replay_gap').map((r) => JSON.parse(r.content)))
      .toEqual([{ type: 'replay_gap', from: 1, to: 5 }]);
    s._onAgentEvent(newEv(6, { event: 'assistant_text', delta: 'New.' }));
    s._onAgentEvent(newEv(7, { event: 'stop', subtype: 'success' }));
    expect(rows().filter((r) => r.role === 'assistant').map((r) => r.content)).toEqual(['Old.', 'New.']);
  });

  it('live new-epoch events before the replay keep both cursors pinned at 0 until its real end', () => {
    const { s } = mkStream('claude');
    s._onAgentEvent(oldEv(4000, { event: 'assistant_text', delta: 'Old.' }));
    s._onAgentEvent(reset);
    pool.afterSeq = [];
    // Held live events released behind the reset's answer, a landmark included.
    s._onAgentEvent(newEv(6, { event: 'status', status: 'thinking' }));
    s._onAgentEvent(newEv(7, { event: 'tool_use', id: 'tu-7', name: 'Read', input: {} }));
    expect(pool.afterSeq).toEqual([]);                    // the client keeps the stored 0
    expect(sessionRow().lastSeenSeq).toBe(0);             // a hub restart replays from 0 too
    expect(s._durableCursor()).toBe(0);
    // A cut before the replay began leaves the pin alone.
    s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
    expect(s._durableCursor()).toBe(0);
    // The replay from 0 lands: 1..5 persisted once, then the cursors follow the frontier.
    s._onAgentEvent(begin);
    s._onAgentEvent(newEv(1, { event: 'assistant_text', delta: 'New ' }));
    s._onAgentEvent(newEv(2, { event: 'assistant_text', delta: 'text.' }));
    s._onAgentEvent(newEv(3, { event: 'tool_use', id: 'tu-3', name: 'Read', input: {} }));
    s._onAgentEvent(newEv(4, { event: 'tool_result', tool_use_id: 'tu-3', content: 'r', is_error: false }));
    s._onAgentEvent(newEv(5, { event: 'stop', subtype: 'success' }));
    s._onAgentEvent(newEv(6, { event: 'status', status: 'thinking' }));
    s._onAgentEvent(newEv(7, { event: 'tool_use', id: 'tu-7', name: 'Read', input: {} }));
    expect(s._durableCursor()).toBe(0);
    s._onAgentEvent(end);
    expect(pool.afterSeq.at(-1)).toEqual([SID, 7]);
    expect(sessionRow().lastSeenSeq).toBe(7);
    expect(rows().filter((r) => r.role === 'assistant').map((r) => r.content)).toEqual(['Old.', 'New text.']);
    expect(rows().filter((r) => r.role === 'tool_use').map((r) => JSON.parse(r.content).id)).toEqual(['tu-7', 'tu-3']);
  });

  it('a log recreated EMPTY at subscribe time (no reset answer): the first live new-epoch event resets, its stop notifies', async () => {
    const { s } = mkStream('claude');
    s.attached = true;                                  // the stream is subscribed (live events)
    // No seq_epoch_reset: the subscribe answered current_seq 0. Live 1..4:
    s._onAgentEvent(newEv(1, { event: 'status', status: 'thinking' }));
    expect(pool.resubscribe).toEqual([[SID, { afterSeq: 0 }]]);
    expect(sessionRow()).toMatchObject({ lastSeenSeq: 0, lastStopNotifiedSeq: null });
    s._onAgentEvent(newEv(2, { event: 'assistant_text', delta: 'Fresh.' }));
    s._onAgentEvent(newEv(3, { event: 'stop', subtype: 'success' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRow()).toMatchObject({ unreadStop: 1, lastStopNotifiedSeq: 3 });
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(1);
    // Once: the next live event is above the new cursor.
    s._onAgentEvent(newEv(4, { event: 'status', status: 'active' }));
    expect(pool.resubscribe).toHaveLength(1);
  });

  it('a replayed or unattached event below the cursor is no regression', () => {
    const { s } = mkStream('claude');
    s._onAgentEvent(newEv(1, { event: 'status', status: 'thinking' }));   // not attached
    s.attached = true;
    s._onAgentEvent(begin);
    s._onAgentEvent(newEv(2, { event: 'status', status: 'thinking' }));   // inside a replay window
    s._onAgentEvent(end);
    expect(pool.resubscribe).toEqual([]);
  });

  it('a hub restart during the pinned reset replay rebuilds the finish floor from the rows', async () => {
    const first = mkStream('claude').s;
    first._onAgentEvent(oldEv(3995, { event: 'assistant_text', delta: 'Old answer.' }));
    first._onAgentEvent(oldEv(3996, { event: 'stop', subtype: 'success' }));
    db.update(schema.agentSessions).set({ unreadStop: 0 }).where(eq(schema.agentSessions.id, SID)).run();
    pushMocks.sendPushToAll.mockClear();
    first._onAgentEvent(reset);
    const floor = Math.max(...rows().map((r) => r.tsMs));
    first._onAgentEvent(begin);
    first._onAgentEvent({ session_id: SID, seq: 1, ts: (floor - 2) / 1000, event: 'stop', subtype: 'success' });
    // …the hub restarts before the replay ends.
    expect(sessionRow()).toMatchObject({ lastSeenSeq: 0, lastStopNotifiedSeq: 1, unreadStop: 0 });
    const { s } = mkStream('claude');
    expect(s.stopNotifyFloorTsMs).toBe(floor);
    s._onAgentEvent(begin);
    s._onAgentEvent({ session_id: SID, seq: 1, ts: (floor - 2) / 1000, event: 'stop', subtype: 'success' });
    s._onAgentEvent({ session_id: SID, seq: 2, ts: (floor - 1) / 1000, event: 'stop', subtype: 'success' });
    expect(sessionRow().unreadStop).toBe(0);              // handled before the reset
    s._onAgentEvent({ session_id: SID, seq: 3, ts: (floor + 1_000) / 1000, event: 'stop', subtype: 'success' });
    expect(sessionRow().unreadStop).toBe(1);              // a real unseen finish
    s._onAgentEvent(end);
    expect(s.stopNotifyFloorTsMs).toBeNull();
    expect(pushMocks.sendPushToAll).not.toHaveBeenCalled();
  });

  it('holdbacks and seq guards of the old epoch are gone', () => {
    const { s } = mkStream('codex');
    s.holdbacks.set('event', 3000);
    s._onAgentEvent(oldEv(4000, { event: 'thinking', text: 'x' }));
    s._onAgentEvent(reset);
    expect(s.holdbacks.size).toBe(0);
    expect(s.pendingAssistantLastSeq).toBeNull();
    expect(s.pendingThinkingLastSeq).toBeNull();
    expect(s.replayThinkingCover).toBeNull();
    expect(s.deltaSpans.size).toBe(0);
    expect(s.lastSeenSeq).toBe(0);
    expect(s._durableCursor()).toBe(0);
  });
});
