import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  closeThinkingMessage, createThinkingLane, thinkingLaneBeforeFrame, thinkingLaneCommit, thinkingLaneDelta,
  thinkingLaneFlushed, thinkingLaneReopened, thinkingLaneSnapshot, thinkingRowIds, type ThinkingLane,
} from '@/app/thinkingMessages';
import type { Msg } from '@/app/sessionTypes';

// Delta providers' reasoning coalesces hub-side (CLAUDE.md §14.17/§14.31, sync
// refonte C02): ONE `event` row per block, stamped with the first delta's seq
// and ts, closed by every non-transparent event; replay identity per delta
// (own row, or positional cover of a coalesced row); sealed retries with
// per-source holdbacks; no row persisted while a block is open (I8); a 25 ms
// broadcast lane and the `thinking_flushed` cut; `streamingThinking` on the
// GET. Same harness as replayIdentity/replayExactness: a real migrated SQLite
// DB (tests/setup/hermeticDb.ts), the SessionStream driven through
// `_onAgentEvent`, message-row inserts failed on demand.

const pool = vi.hoisted(() => {
  // The AgentClient's reconnect cursor (`_pendingAfterSeq`): written by
  // `setAfterSeq` and by a `resubscribe` with an explicit `afterSeq`.
  const cursors = new Map<string, number | null>();
  return {
    cursors,
    // ONE stable client object (attach() compares identity); resubscribe spied.
    client: {
      setAfterSeq: (sid: string, seq: number | null) => { cursors.set(sid, seq); },
      subscribe: (..._args: any[]) => {},
      unsubscribe: () => {},
      resubscribe: vi.fn((sid: string, opts?: { afterSeq?: number }) => {
        if (typeof opts?.afterSeq === 'number') cursors.set(sid, opts.afterSeq);
      }),
      call: async (..._args: any[]): Promise<any> => ({ ok: true, status: 'active' }),
    },
  };
});

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

const VPS_ID = 'thinkvps';
const SID = 'c'.repeat(32);
const REF_SID = 'b'.repeat(32);      // reference (uninterrupted) runs
const SCHED_SID = '8'.repeat(32);    // registered stream (scheduled resume)
const GET_SID = '7'.repeat(32);      // registered stream (session GET)
const SHUT_SID = '6'.repeat(32);     // registered stream (graceful shutdown)
const ALL_SIDS = [SID, REF_SID, SCHED_SID, GET_SID, SHUT_SID];
const T0 = Date.now() - 3_600_000;   // agent event clock: an hour ago

let db: any;
let schema: any;
let SessionStream: any;
let getOrCreateStream: any;
let orderChronologically: any;
let rebuildStateFromMessages: any;
// Fail the next N INSERTs into session_messages (other tables pass).
let failMessageInserts = 0;
// Fail the next N UPDATEs of session_messages.
let failMessageUpdates = 0;
// Fail the next N INSERTs into session_pending_questions.
let failPendingInserts = 0;

function mkStream(opts: { id?: string; kind?: string; lastSeenSeq?: number | null } = {}) {
  return new SessionStream({
    id: opts.id ?? SID, vpsId: VPS_ID, vpsName: 'test', name: null,
    status: 'active', permissionMode: 'normal', nativeSessionId: null,
    kind: opts.kind ?? 'codex', lastSeenSeq: opts.lastSeenSeq ?? null,
  }) as any;
}

/** Agent event with the agent's `ts` (unix SECONDS) = T0 + seq ms. */
function ev(event: string, seq: number | null, extra: Record<string, unknown> = {}, sid = SID) {
  return {
    event, session_id: sid,
    ...(seq != null ? { seq, ts: (T0 + seq) / 1000 } : {}),
    ...extra,
  };
}
const delta = (seq: number, text: string, sid = SID) => ev('thinking', seq, { text }, sid);
const toolUse = (seq: number, id = `t${seq}`, sid = SID) =>
  ev('tool_use', seq, { id, name: 'Read', input: { file_path: '/x' } }, sid);

function send(s: any, events: any[]) {
  for (const e of events) s._onAgentEvent(e);
}

function replay(s: any, events: any[], sid = SID) {
  s._onAgentEvent({ event: 'replay_begin', session_id: sid, count: events.length });
  send(s, events);
  s._onAgentEvent({ event: 'replay_end', session_id: sid });
}

function rows(sid = SID) {
  return db.select().from(schema.sessionMessages).all()
    .filter((r: any) => r.sessionId === sid)
    .sort((a: any, b: any) => a.id - b.id);
}

function isThinkingRow(r: any): boolean {
  if (r.role !== 'event') return false;
  try { return JSON.parse(r.content).type === 'thinking'; } catch { return false; }
}

function thinkingRows(sid = SID) {
  return rows(sid).filter(isThinkingRow).map((r: any) => ({
    id: r.id, text: JSON.parse(r.content).text as string, seq: r.seq, tsMs: r.tsMs,
  }));
}

/** The rendered transcript, ids/dates left out (they differ between runs). */
function rendered(sid: string) {
  const ordered = orderChronologically(rows(sid)).map((r: any) => ({
    id: r.id, role: r.role, content: r.content, createdAt: r.createdAt,
  }));
  return rebuildStateFromMessages(ordered, 'active', 'codex').messages
    .map((m: any) => ({ role: m.role, content: m.content, thinkingDelta: !!m.thinkingDelta }));
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  for (const id of ALL_SIDS) {
    db.insert(schema.agentSessions).values({ id, vpsId: VPS_ID, cwd: '/tmp', status: 'active', kind: 'codex' })
      .onConflictDoNothing().run();
  }
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();

  const realInsert = db.insert.bind(db);
  vi.spyOn(db, 'insert').mockImplementation(((table: any) => {
    if (failMessageInserts > 0 && table === schema.sessionMessages) {
      failMessageInserts--;
      const boom = () => { throw new Error('injected DB failure'); };
      return { values: () => ({ run: boom, onConflictDoNothing: () => ({ run: boom }) }) };
    }
    if (failPendingInserts > 0 && table === schema.sessionPendingQuestions) {
      failPendingInserts--;
      const boom = () => { throw new Error('injected DB failure'); };
      return { values: () => ({ run: boom, onConflictDoNothing: () => ({ run: boom }) }) };
    }
    return realInsert(table);
  }) as any);
  const realUpdate = db.update.bind(db);
  vi.spyOn(db, 'update').mockImplementation(((table: any) => {
    if (failMessageUpdates > 0 && table === schema.sessionMessages) {
      failMessageUpdates--;
      const boom = () => { throw new Error('injected DB failure'); };
      return { set: () => ({ where: () => ({ run: boom }) }) };
    }
    return realUpdate(table);
  }) as any);

  ({ SessionStream, getOrCreateStream } = await import('@/lib/server/agent/sessionOps'));
  ({ orderChronologically } = await import('@/lib/server/hub/messageOrder'));
  ({ rebuildStateFromMessages } = await import('@/app/sessionRebuild'));
});

beforeEach(() => {
  pool.client.resubscribe.mockClear();
  pool.cursors.clear();
});

afterEach(() => {
  vi.useRealTimers();
  failMessageInserts = 0;
  failMessageUpdates = 0;
  failPendingInserts = 0;
  for (const id of ALL_SIDS) {
    db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, id)).run();
  }
  db.delete(schema.sessionPendingQuestions).run();
  db.delete(schema.sessionScheduledResumes).run();
  db.update(schema.agentSessions).set({ lastSeenSeq: null, pendingAssistantMessageId: null }).run();
});

describe('boundaries (thinkingBoundaries.ts)', () => {
  it('closes on every event except the transparent ones; usage only when final; unknown types close', async () => {
    const { closesThinking, THINKING_TRANSPARENT_EVENTS } = await import('@/lib/server/agent/thinkingBoundaries');
    for (const event of THINKING_TRANSPARENT_EVENTS) expect(closesThinking({ event })).toBe(false);
    for (const event of ['tool_use', 'tool_result', 'assistant_text', 'stop', 'status', 'bg_task',
      'endpoint_usage', 'replay_gap', 'error', 'turn_error', 'effective_model', 'plan_progress', 'brand_new_event']) {
      expect(closesThinking({ event })).toBe(true);
    }
    // Both replay markers keep the block open (the replay-only guard needs it).
    expect(closesThinking({ event: 'replay_begin' })).toBe(false);
    expect(closesThinking({ event: 'replay_end' })).toBe(false);
    expect(closesThinking({ event: 'usage' })).toBe(false);
    expect(closesThinking({ event: 'usage', final: false })).toBe(false);
    expect(closesThinking({ event: 'usage', final: true })).toBe(true);
  });
});

describe('one row per block', () => {
  it.each(['codex', 'cursor'])('%s: 5 deltas + tool_use ⇒ one row stamped with the first delta, sorted before the tool', (kind) => {
    const s = mkStream({ kind });
    send(s, ['0', '.', '154', '.', '0'].map((t, i) => delta(1 + i, t)));
    expect(thinkingRows()).toEqual([]);                    // nothing persisted while open
    expect(s.getStreamingThinking()).toBe('0.154.0');
    expect(s._durableCursor()).toBe(0);                    // held below the open block
    send(s, [toolUse(6)]);
    const all = rows();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ role: 'event', content: JSON.stringify({ type: 'thinking', text: '0.154.0' }), seq: 1, tsMs: T0 + 1 });
    expect(orderChronologically(all).map((r: any) => r.role)).toEqual(['event', 'tool_use']);
    expect(s.getStreamingThinking()).toBe('');
    expect(s._durableCursor()).toBe(6);
  });

  it('Claude keeps one row and one immediate frame per thinking event', () => {
    const s = mkStream({ kind: 'claude' });
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    send(s, [delta(1, 'First block.'), delta(2, 'Second block.')]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['First block.', 1], ['Second block.', 2]]);
    // Each frame names its row (sync refonte C08, I15).
    const [first, second] = thinkingRows();
    expect(emitted.mock.calls.map(([e]) => e)).toEqual([
      { type: 'thinking', text: 'First block.', rowId: first.id },
      { type: 'thinking', text: 'Second block.', rowId: second.id },
    ]);
    expect(s.getStreamingThinking()).toBe('');
  });

  it('seq-less deltas (old agents) keep one row per event', () => {
    const s = mkStream();
    send(s, [ev('thinking', null, { text: 'a' }), ev('thinking', null, { text: 'b' })]);
    expect(thinkingRows().map((r: any) => r.text)).toEqual(['a', 'b']);
  });

  it('assistant_text closes the block; the next reasoning closes the text', () => {
    const s = mkStream();
    send(s, [delta(1, 'think '), delta(2, 'more'), ev('assistant_text', 3, { delta: 'Answer' }),
      delta(4, 'again'), ev('stop', 5, { subtype: 'success' })]);
    expect(orderChronologically(rows()).map((r: any) => [r.role, r.role === 'event' ? JSON.parse(r.content).text : r.content]))
      .toEqual([['event', 'think more'], ['assistant', 'Answer'], ['event', 'again']]);
    expect(rows().map((r: any) => r.seq)).toEqual([1, 3, 4]);   // ids follow chronology
  });

  it('bg_task, endpoint_usage, status and a final usage close the block', () => {
    const closers = [
      ev('bg_task', 11, { kind: 'started', task_id: 'bg-1', description: 'job' }),
      ev('endpoint_usage', 21, { request_id: 'r1', input_tokens: 1, output_tokens: 2, total_tokens: 3 }),
      ev('status', 31, { status: 'active' }),
      ev('usage', 41, { output_tokens: 5, final: true }),
    ];
    const s = mkStream();
    closers.forEach((closer, i) => {
      const base = 10 * (i + 1) - 2;
      send(s, [delta(base, `b${i}-`), delta(base + 1, 'x'), closer]);
    });
    send(s, [delta(50, 'tail'), toolUse(51)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([
      ['b0-x', 8], ['b1-x', 18], ['b2-x', 28], ['b3-x', 38], ['tail', 50],
    ]);
  });

  it('transparent events (and non-final usage) keep the block open', () => {
    const s = mkStream();
    const between = [
      ev('generation_progress', 2, { characters: 10 }),
      ev('tool_progress', 4, { tool_use_id: 'x', delta: 'out' }),
      ev('edit_progress', 6, { tool_use_id: 'x', file_path: '/f', diff: '', size: 0, truncated: false }),
      ev('bg_task_progress', 8, { task_id: 'bg' }),
      ev('tool_activity', 10, { kind: 'mcp', id: '1', status: 'running' }),
      ev('codex_signal', 12, { kind: 'filesystem', id: '1', status: 'idle' }),
      ev('rate_limit', 14, { status: 'allowed' }),
      ev('session_info', 16, { capabilities: ['x'] }),
      ev('model_changed', 18, { model: 'm', fallback_model: null }),
      ev('effort_changed', 20, { effort: null }),
      ev('mode_changed', 22, { mode: 'workspace-write' }),
      ev('session_id', 24, { claude_session_id: 'thread-x' }),
      ev('replay_end', null),
      ev('usage', 26, { output_tokens: 1 }),
    ];
    send(s, [delta(1, 'a')]);
    between.forEach((e, i) => send(s, [e, delta(e.seq != null ? (e.seq as number) + 1 : 100 + i, String(i))]));
    send(s, [toolUse(200)]);
    const texts = thinkingRows().map((r: any) => r.text);
    expect(texts).toEqual(['a' + between.map((_, i) => String(i)).join('')]);
    expect(thinkingRows()[0].seq).toBe(1);
  });

  it('a block past 256 KiB is cut into adjacent rows that render as one bubble', () => {
    const s = mkStream();
    const chunk = 'x'.repeat(64 * 1024);
    send(s, [delta(1, chunk), delta(2, chunk), delta(3, chunk), delta(4, chunk), delta(5, 'tail'), toolUse(6)]);
    const t = thinkingRows();
    expect(t.map((r: any) => [r.text.length, r.seq])).toEqual([[256 * 1024, 1], [4, 5]]);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toEqual([
      { role: 'thinking', content: chunk.repeat(4) + 'tail', thinkingDelta: true },
    ]);
  });

  it('live new-epoch deltas below the open block\'s last seq are kept', () => {
    const s = mkStream();
    send(s, [delta(500, 'old '), delta(501, 'epoch '), ev('thinking', 3, { text: 'new', ts: (T0 + 600) / 1000 })]);
    send(s, [ev('tool_use', 4, { id: 'n', name: 'Read', input: {}, ts: (T0 + 601) / 1000 })]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['old epoch new', 500]]);
  });
});

describe('I8: no row lands while a block is open', () => {
  it('a hub-originated user row flushes the block first', async () => {
    const s = mkStream();
    send(s, [delta(10, 'pondering')]);
    await s.sendUserMessage('next question');
    const all = rows();
    expect(all.map((r: any) => r.role)).toEqual(['event', 'user']);
    expect(JSON.parse(all[0].content).text).toBe('pondering');
    expect(s.getStreamingThinking()).toBe('');
  });

  it('persistExternal flushes first and returns the write\'s value', () => {
    const s = mkStream();
    send(s, [delta(10, 'a')]);
    const value = s.persistExternal(() => {
      expect(thinkingRows().map((r: any) => r.text)).toEqual(['a']);
      return 42;
    });
    expect(value).toBe(42);
  });

  it('an open Codex block + an async answer: thinking rows precede the answer and the resolution', async () => {
    const s = mkStream();
    const questions = [{ question: 'Which colour?', options: [{ label: 'Orange' }, { label: 'Purple' }] }];
    send(s, [ev('user_question', 700, { id: 'async-q', delivery: 'async', questions })]);
    send(s, [delta(701, 'still '), delta(702, 'thinking')]);
    // The answer starts a new turn whose reasoning streams in while the send
    // is in flight — the resolution transaction runs after it.
    s.sendUserMessage = vi.fn(async () => {
      send(s, [ev('thinking', 703, { text: 'new turn', ts: Date.now() / 1000 })]);
    });
    await s.respondQuestion('async-q', { 'Which colour?': 'Orange' });
    const all = rows().filter((r: any) => r.role !== 'async_question');
    const kinds = all.map((r: any) => r.role === 'event' ? JSON.parse(r.content).type + ':' + (JSON.parse(r.content).text ?? '') : r.role);
    expect(kinds).toEqual(['thinking:still thinking', 'user', 'thinking:new turn', 'interaction_resolved:']);
    expect(orderChronologically(all).map((r: any) => r.id)).toEqual(all.map((r: any) => r.id));
  });

  it('an open block + a scheduled-resume card and its delivery: every write lands after the block row', async () => {
    vi.useFakeTimers({ now: Date.now() });
    const s = getOrCreateStream(SCHED_SID);
    expect(s.kind).toBe('codex');
    const think = (seq: number, text: string) =>
      s._onAgentEvent({ event: 'thinking', session_id: SCHED_SID, seq, ts: Date.now() / 1000, text });
    const kinds = () => rows(SCHED_SID).map((r: any) => {
      if (r.role !== 'event') return r.role;
      const c = JSON.parse(r.content);
      return c.type === 'thinking' ? `thinking:${c.text}` : c.type;
    });
    const source = db.insert(schema.sessionMessages).values({
      sessionId: SCHED_SID, role: 'error', content: '{}', tsMs: Date.now(),
    }).run();
    think(900, 'before card');
    const { createScheduledResume, runScheduledResumesDue } = await import('@/lib/server/agent/scheduledResume');
    createScheduledResume({ sessionId: SCHED_SID, sourceMessageId: Number(source.lastInsertRowid), resetAt: Date.now() - 1 });
    expect(kinds()).toEqual(['error', 'thinking:before card', 'scheduled_resume', 'scheduled_resume_update']);

    think(901, 'before delivery');
    // Each delivery write gets its own open block, so each wrapper is proven
    // alone. Between the first card and the user row nothing can interleave
    // for real (synchronous code): the block is injected through the card's
    // publish. The send starts a new turn whose reasoning is still open when
    // the final card is written.
    const publish = s.publishScheduledResume.bind(s);
    let injected = false;
    s.publishScheduledResume = (...args: any[]) => {
      publish(...args);
      if (!injected) { injected = true; think(902, 'before user'); }
    };
    s.sendUserMessage = vi.fn(async () => { think(903, 'new turn'); });
    vi.setSystemTime(Date.now() + 121_000);
    await runScheduledResumesDue();
    expect(kinds()).toEqual([
      'error', 'thinking:before card', 'scheduled_resume', 'scheduled_resume_update',
      'thinking:before delivery', 'scheduled_resume_update',      // deliver's first card
      'thinking:before user', 'user',                              // deliver's user row
      'thinking:new turn', 'scheduled_resume_update',              // the final card
    ]);
  });
});

describe('sealed blocks and holdbacks', () => {
  it('a failed flush seals: cursor held at first−1, the boundary still persists, the retry releases it', () => {
    const s = mkStream();
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    failMessageInserts = 1;
    send(s, [toolUse(13)]);
    expect(thinkingRows()).toEqual([]);
    expect(rows().map((r: any) => r.role)).toEqual(['tool_use']);   // never blocks the boundary
    expect(s._durableCursor()).toBe(9);
    expect(s.getStreamingThinking()).toBe('');                      // sealed ≠ open

    failMessageInserts = 1;                                          // the retry at the next open fails too
    send(s, [delta(14, 'd'), delta(15, 'e')]);
    expect(thinkingRows()).toEqual([]);
    expect(s._durableCursor()).toBe(9);
    send(s, [ev('stop', 16, { subtype: 'success' })]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq, r.tsMs])).toEqual([
      ['abc', 10, T0 + 10], ['de', 14, T0 + 14],
    ]);
    expect(orderChronologically(rows()).map((r: any) => r.role === 'event' ? JSON.parse(r.content).text : r.role))
      .toEqual(['abc', 'tool_use', 'de']);
    expect(s.holdbacks.size).toBe(0);
    expect(s._durableCursor()).toBe(16);                             // released: the cursor advances
  });

  // S1X: past 50 sealed blocks the oldest is dropped from memory and left to
  // the RESTART replay (its holdback pins the persisted cursor below it); the
  // hub never re-subscribes live from the thinking lane.
  const capWarnings = (warn: any) => warn.mock.calls.map(([m]: any[]) => String(m))
    .filter((m: string) => m.startsWith('[thinking] retry cap'));
  const persistedCursor = (sid = SID) =>
    db.select().from(schema.agentSessions).all().find((r: any) => r.id === sid).lastSeenSeq;

  it('past 50 sealed blocks the oldest is dropped: its holdback stays, nothing is re-subscribed, one warning per drop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = mkStream();
      s.attach();
      failMessageInserts = Number.MAX_SAFE_INTEGER;
      for (let i = 0; i <= 50; i++) {
        send(s, [delta(100 + 2 * i, `b${i}`), ev('turn_error', 101 + 2 * i, { kind: 'overloaded' })]);
      }
      expect(s.thinkingRetry).toHaveLength(50);
      expect(s.thinkingRetry[0].since).toBe(102);
      expect(s.holdbacks.get('thinking:100')).toBe(100);           // kept
      expect(s._durableCursor()).toBe(99);
      expect(capWarnings(warn)).toEqual([`[thinking] retry cap: block 100 left to the restart replay (${SID})`]);
      // One more overflow drops the next oldest: one more warning, naming it.
      send(s, [delta(202, 'b51'), ev('turn_error', 203, { kind: 'overloaded' })]);
      expect(s.thinkingRetry).toHaveLength(50);
      expect(s.holdbacks.get('thinking:102')).toBe(102);
      expect(capWarnings(warn)).toHaveLength(2);
      expect(capWarnings(warn)[1]).toContain('block 102 left to the restart replay');
      // Never a live re-delivery: no resubscribe, and the reconnect cursor
      // stays on the frontier (nothing rewinds it).
      expect(pool.client.resubscribe).not.toHaveBeenCalled();
      expect(pool.cursors.get(SID)).toBe(203);
      // The DB recovers: the 50 entries still in memory land; the dropped
      // blocks keep their holdbacks, so the persisted cursor stays below them.
      failMessageInserts = 0;
      send(s, [ev('status', 204, { status: 'active' })]);
      expect(s.thinkingRetry).toHaveLength(0);
      expect(thinkingRows().map((r: any) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 104 + 2 * i));
      expect([...s.holdbacks.keys()].sort()).toEqual(['thinking:100', 'thinking:102']);
      expect(s._durableCursor()).toBe(99);
      expect(persistedCursor()).toBe(99);
      expect(pool.client.resubscribe).not.toHaveBeenCalled();
      expect(pool.cursors.get(SID)).toBe(204);
      expect(capWarnings(warn)).toHaveLength(2);                     // once per dropped block, never again
      s.detach();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([false, true])('a hub restart replays from the pinned cursor: the dropped block is rebuilt exactly once, rendered like the uninterrupted run (window cut mid-block: %s)', (cutMidBlock) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The agent's log: 51 two-delta reasoning blocks, each closed by a
      // turn error (no row of its own), then a tool call and the stop.
      const log = (sid: string) => {
        const out: any[] = [];
        for (let i = 0; i <= 50; i++) {
          const b = 100 + 3 * i;
          out.push(delta(b, `b${i}.`, sid), delta(b + 1, `${i};`, sid), ev('turn_error', b + 2, { kind: 'overloaded' }, sid));
        }
        out.push(toolUse(253, 't253', sid), ev('stop', 254, { subtype: 'success' }, sid));
        return out;
      };
      send(mkStream({ id: REF_SID, lastSeenSeq: 50 }), log(REF_SID));   // the uninterrupted run

      db.update(schema.agentSessions).set({ lastSeenSeq: 50 }).where(eq(schema.agentSessions.id, SID)).run();
      const events = log(SID);
      const s = mkStream({ lastSeenSeq: 50 });
      failMessageInserts = Number.MAX_SAFE_INTEGER;
      send(s, events.slice(0, 153));                                 // the 51 blocks: block 100 dropped
      failMessageInserts = 0;
      send(s, events.slice(153));                                    // the 50 others land; the stop persists the cursor
      expect(thinkingRows().map((r: any) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 103 + 3 * i));
      expect([...s.holdbacks.keys()]).toEqual(['thinking:100']);
      expect(persistedCursor()).toBe(99);                            // pinned below the dropped block
      expect(pool.client.resubscribe).not.toHaveBeenCalled();
      expect(capWarnings(warn)).toHaveLength(1);

      // The hub restarts: a fresh stream from the persisted cursor; the agent
      // replays its log after it (optionally cut by a disconnect right after
      // the dropped block's first delta, then resumed from the client cursor).
      const restarted = mkStream({ lastSeenSeq: persistedCursor() });
      restarted.attach();
      const after = events.filter((e) => e.seq > 99);
      if (cutMidBlock) {
        restarted._onAgentEvent({ event: 'replay_begin', session_id: SID, count: after.length });
        send(restarted, after.slice(0, 1));
        restarted._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
        expect(restarted.getStreamingThinking()).toBe('b0.');
        replay(restarted, after.filter((e) => e.seq > pool.cursors.get(SID)!));
      } else {
        replay(restarted, after);
      }
      expect(thinkingRows().filter((r: any) => r.seq === 100).map((r: any) => [r.text, r.tsMs])).toEqual([['b0.0;', T0 + 100]]);
      expect(thinkingRows()).toHaveLength(51);
      expect(rows().filter((r: any) => r.role === 'tool_use')).toHaveLength(1);
      expect(rendered(SID)).toEqual(rendered(REF_SID));
      expect(restarted.holdbacks.size).toBe(0);
      expect(restarted._durableCursor()).toBe(254);
      expect(persistedCursor()).toBe(254);
      // Replayed once more (attach + resubscribe): nothing is written twice.
      replay(restarted, after);
      expect(thinkingRows()).toHaveLength(51);
      expect(rendered(SID)).toEqual(rendered(REF_SID));
      expect(pool.client.resubscribe).not.toHaveBeenCalled();
      expect(capWarnings(warn)).toHaveLength(1);
      restarted.detach();
    } finally {
      warn.mockRestore();
    }
  });

  // No sealed entry is left to hold a dropped block's tail (`_sealedHolds`):
  // a window starting inside it lands the tail as its own row, and the
  // restart replay closes the rebuilt head against that row — two adjacent
  // rows, one bubble, nothing twice.
  it('an overlapping replay starting INSIDE a dropped block lands its tail; the restart writes the head beside it, rendered once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const log = (sid: string) => {
        const out: any[] = [delta(100, 'a', sid), delta(101, 'b', sid), delta(102, 'c', sid),
          ev('turn_error', 103, { kind: 'overloaded' }, sid)];
        for (let i = 0; i < 50; i++) out.push(delta(104 + 2 * i, `x${i};`, sid), ev('turn_error', 105 + 2 * i, { kind: 'overloaded' }, sid));
        out.push(toolUse(204, 't204', sid), ev('stop', 205, { subtype: 'success' }, sid));
        return out;
      };
      send(mkStream({ id: REF_SID, lastSeenSeq: 99 }), log(REF_SID));   // the uninterrupted run

      db.update(schema.agentSessions).set({ lastSeenSeq: 99 }).where(eq(schema.agentSessions.id, SID)).run();
      const events = log(SID);
      const s = mkStream({ lastSeenSeq: 99 });
      failMessageInserts = Number.MAX_SAFE_INTEGER;
      send(s, events.filter((e) => e.seq <= 203));                   // 'abc'@100 dropped
      failMessageInserts = 0;
      // A resubscribe whose cursor (100) was taken while 'abc' streamed is
      // answered only now: its window starts inside the dropped block.
      replay(s, events.filter((e) => e.seq > 100 && e.seq <= 203));
      send(s, events.filter((e) => e.seq > 203));
      expect(thinkingRows().filter((r: any) => r.seq <= 102).map((r: any) => [r.text, r.seq])).toEqual([['bc', 101]]);
      expect(thinkingRows()).toHaveLength(51);
      expect(persistedCursor()).toBe(99);                            // the head is still owed

      const restarted = mkStream({ lastSeenSeq: persistedCursor() });
      replay(restarted, events.filter((e) => e.seq > 99));
      expect(thinkingRows().filter((r: any) => r.seq <= 102).map((r: any) => [r.text, r.seq])).toEqual([['bc', 101], ['a', 100]]);
      expect(thinkingRows()).toHaveLength(52);
      expect(rendered(SID)).toEqual(rendered(REF_SID));
      expect(restarted.holdbacks.size).toBe(0);
      expect(pool.client.resubscribe).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // 51 one-delta blocks (100..200), each closed by a turn error with no row
  // of its own; with every insert failing, block 100 is dropped by the cap.
  const capOverflowLog = () => {
    const out: any[] = [];
    for (let i = 0; i <= 50; i++) out.push(delta(100 + 2 * i, `b${i}`), ev('turn_error', 101 + 2 * i, { kind: 'overloaded' }));
    return out;
  };

  it('a dropped block a replay rebuilds IN THIS PROCESS releases its holdback: the persisted cursor reaches the frontier', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = mkStream();
      s.attach();
      const events = [...capOverflowLog(), ev('status', 202, { status: 'active' })];
      failMessageInserts = Number.MAX_SAFE_INTEGER;
      send(s, events.filter((e) => e.seq <= 201));
      expect(capWarnings(warn)).toEqual([`[thinking] retry cap: block 100 left to the restart replay (${SID})`]);
      expect(s.holdbacks.get('thinking:100')).toBe(100);
      expect(s.thinkingRetry.some((e: any) => e.since === 100)).toBe(false);   // no other sealed entry holds it
      failMessageInserts = 0;
      send(s, events.filter((e) => e.seq > 201));                    // the 50 entries land
      expect(s.thinkingRetry).toHaveLength(0);
      expect([...s.holdbacks.keys()]).toEqual(['thinking:100']);
      expect(persistedCursor()).toBe(99);                            // pinned below the dropped block
      const frontier = 202;

      // An overlapping replay on the SAME stream, from the dropped block's
      // anchor to the frontier: it rebuilds the block, `_releaseThinking(100)`
      // drops the pin, everything else is deduped by identity.
      replay(s, events.filter((e) => e.seq >= 100 && e.seq <= frontier));
      expect(thinkingRows().filter((r: any) => r.seq === 100).map((r: any) => [r.text, r.tsMs])).toEqual([['b0', T0 + 100]]);
      expect(orderChronologically(rows()).filter(isThinkingRow).map((r: any) => r.seq))   // newest id, first by ts
        .toEqual(Array.from({ length: 51 }, (_, i) => 100 + 2 * i));
      expect(s.holdbacks.has('thinking:100')).toBe(false);
      expect(s.holdbacks.size).toBe(0);
      expect(s._durableCursor()).toBe(frontier);
      // Replayed seqs never write the cursor; the next landmark persists the
      // released one, no longer pinned.
      send(s, [ev('status', frontier + 1, { status: 'active' })]);
      expect(s._durableCursor()).toBe(frontier + 1);
      expect(persistedCursor()).toBe(frontier + 1);
      // Replayed once more: nothing is written twice, nothing is pinned again.
      replay(s, events.filter((e) => e.seq >= 100 && e.seq <= frontier));
      expect(thinkingRows()).toHaveLength(51);
      expect(s.holdbacks.size).toBe(0);
      expect(pool.client.resubscribe).not.toHaveBeenCalled();
      expect(capWarnings(warn)).toHaveLength(1);
      s.detach();
    } finally {
      warn.mockRestore();
    }
  });

  it('a dropped block a replay rebuilds while writes still fail is sealed again; a later overflow drops it with exactly one more warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blockWarnings = (since: number) => capWarnings(warn).filter((m: string) => m.includes(`block ${since} left`));
    try {
      const s = mkStream();
      s.attach();
      failMessageInserts = Number.MAX_SAFE_INTEGER;
      send(s, capOverflowLog());                                     // block 100 dropped
      expect(blockWarnings(100)).toHaveLength(1);
      // A replay rebuilds the dropped block alone: its insert fails, it is
      // sealed again as the NEWEST entry, so the cap drops the oldest (102).
      replay(s, capOverflowLog().filter((e) => e.seq <= 101));
      expect(s.thinkingRetry).toHaveLength(50);
      expect(s.thinkingRetry.at(-1)).toMatchObject({ since: 100, text: 'b0' });
      expect(s.thinkingRetry[0].since).toBe(104);
      expect(capWarnings(warn)).toHaveLength(2);
      expect(blockWarnings(102)).toHaveLength(1);
      expect(s.holdbacks.get('thinking:100')).toBe(100);
      expect(s.holdbacks.get('thinking:102')).toBe(102);
      expect(s._durableCursor()).toBe(99);
      // 50 more failing live blocks: the first 49 drop 104..200, the 50th
      // drops block 100 again — exactly one more warning naming it.
      for (let i = 0; i < 50; i++) {
        send(s, [delta(202 + 2 * i, `n${i}`), ev('turn_error', 203 + 2 * i, { kind: 'overloaded' })]);
      }
      expect(blockWarnings(100)).toHaveLength(2);
      expect(capWarnings(warn).at(-1)).toContain('block 100 left to the restart replay');
      expect(capWarnings(warn)).toHaveLength(2 + 50);
      expect(s.thinkingRetry.map((e: any) => e.since)).toEqual(Array.from({ length: 50 }, (_, i) => 202 + 2 * i));
      expect(s.holdbacks.get('thinking:100')).toBe(100);
      // The DB recovers: the 50 entries land; every dropped block stays pinned.
      failMessageInserts = 0;
      send(s, [ev('status', 302, { status: 'active' })]);
      expect(s.thinkingRetry).toHaveLength(0);
      expect(thinkingRows().map((r: any) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 202 + 2 * i));
      expect(s._durableCursor()).toBe(99);
      expect(persistedCursor()).toBe(99);
      expect(pool.client.resubscribe).not.toHaveBeenCalled();
      expect(capWarnings(warn)).toHaveLength(2 + 50);
      s.detach();
    } finally {
      warn.mockRestore();
    }
  });

  it('sealed failure + replay of the same block + live continuation: the text is persisted once (prefix-extend)', () => {
    const s = mkStream();
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    // A hub-side writer closes the block; its insert fails → sealed 'abcd'@10.
    failMessageInserts = 1;
    s._persist('user', 'interjection');
    expect(s.thinkingRetry.map((x: any) => x.text)).toEqual(['abcd']);
    // The block is re-delivered (the agent's block went on: 12 is part of it)
    // while the retries keep failing: the replay rebuilds it from 10.
    failMessageInserts = 2;   // the retries before the lookup and at the open
    replay(s, [delta(10, 'ab'), delta(11, 'cd')]);
    expect(s.getStreamingThinking()).toBe('abcd');
    send(s, [delta(12, 'ef')]);                                     // live continuation
    send(s, [toolUse(13)]);                                         // retry lands 'abcd', the buffer extends it
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcdef', 10]]);
    expect(s.holdbacks.size).toBe(0);
    const flushed = emitted.mock.calls.map(([e]) => e).filter((e: any) => e.type === 'thinking_flushed');
    expect(flushed.at(-1)).toMatchObject({ type: 'thinking_flushed', length: 6, content: 'abcdef' });
  });

  it('sealed failure + replay: the retry before the lookup lands the row and covers the replayed deltas', () => {
    const s = mkStream();
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    failMessageInserts = 1;
    send(s, [toolUse(12)]);
    replay(s, [delta(10, 'ab'), delta(11, 'cd'), toolUse(12)]);
    send(s, [delta(13, 'ef'), ev('stop', 14, { subtype: 'success' })]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcd', 10], ['ef', 13]]);
    expect(rows().filter((r: any) => r.role === 'tool_use')).toHaveLength(1);
  });

  it('a sealed block whose row appeared meanwhile is extended by its retry, never duplicated; a failed extend stays sealed', () => {
    const s = mkStream();
    send(s, [delta(20, 'ef'), delta(21, 'gh')]);
    failMessageInserts = 1;
    send(s, [toolUse(22)]);                                          // sealed 'efgh'@20
    expect(s.thinkingRetry.map((x: any) => x.text)).toEqual(['efgh']);
    // A replay rebuilt (part of) the block meanwhile: row 'ef'@20.
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'ef' }), seq: 20, tsMs: T0 + 20,
    }).run();
    failMessageUpdates = 1;                                          // the first extend fails: stays sealed
    s.flushThinking();
    expect(s.thinkingRetry).toHaveLength(1);
    expect(s._durableCursor()).toBe(19);
    s.flushThinking();                                               // retried: extends, no second row
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['efgh', 20]]);
    expect(s.holdbacks.size).toBe(0);
    expect(s._durableCursor()).toBe(22);
  });

  it('a failed replay prefix-extend seals the block and its retry extends the row', () => {
    const s = mkStream();
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    failMessageInserts = 1;
    s._persist('user', 'interjection');                              // sealed 'abcd'@10
    failMessageInserts = 2;
    replay(s, [delta(10, 'ab'), delta(11, 'cd')]);
    send(s, [delta(12, 'ef')]);
    failMessageUpdates = 1;                                          // the retry lands 'abcd', the extend fails
    send(s, [toolUse(13)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcd', 10]]);
    expect(s.thinkingRetry.map((x: any) => x.text)).toEqual(['abcdef']);
    expect(s._durableCursor()).toBe(9);
    s.flushThinking();
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcdef', 10]]);
    expect(s._durableCursor()).toBe(13);
  });

  it('a rebuilt copy of a sealed block that fails again replaces the entry (one entry per block); the cursor holds until it lands', () => {
    const s = mkStream();
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    failMessageInserts = 1;
    s._persist('user', 'interjection');                              // sealed 'abcd'@10
    failMessageInserts = 2;                                          // the retries before the lookup and at the open
    replay(s, [delta(10, 'ab'), delta(11, 'cd')]);
    send(s, [delta(12, 'ef')]);
    failMessageInserts = 2;                                          // the flush's retry and its own insert
    send(s, [toolUse(13)]);
    expect(s.thinkingRetry.map((x: any) => [x.text, x.since])).toEqual([['abcdef', 10]]);
    expect(s._durableCursor()).toBe(9);
    failMessageUpdates = 1;                                          // irrelevant now: no prefix row to extend
    s.flushThinking();
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcdef', 10]]);
    expect(s._durableCursor()).toBe(13);
  });

  it('two sealed entries for one block: the first landing keeps the holdback while the second waits', () => {
    const s = mkStream({ lastSeenSeq: 13 });
    // Whatever produced them (the merge above prevents it for prefix copies).
    s.thinkingRetry.push({ text: 'abcd', since: 10, tsMs: T0 + 10 }, { text: 'abcdef', since: 10, tsMs: T0 + 10 });
    s._holdBack('thinking:10', 10);
    failMessageUpdates = 1;                                          // 'abcd' inserts, the 'abcdef' extend fails
    s.flushThinking();
    expect(thinkingRows().map((r: any) => r.text)).toEqual(['abcd']);
    expect(s.thinkingRetry.map((x: any) => x.text)).toEqual(['abcdef']);
    expect(s._durableCursor()).toBe(9);
    s.flushThinking();
    expect(thinkingRows().map((r: any) => r.text)).toEqual(['abcdef']);
    expect(s.holdbacks.size).toBe(0);
    expect(s._durableCursor()).toBe(13);
  });

  it('a sealed retry finding a LONGER row of its block reuses it (no second row)', () => {
    const s = mkStream();
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    failMessageInserts = 1;
    s._persist('user', 'interjection');                              // sealed 'abcd'@10
    failMessageInserts = 3;                                          // both retries in the replay, then the flush's
    replay(s, [delta(10, 'ab'), delta(11, 'cd'), delta(12, 'ef')]);
    send(s, [toolUse(13)]);                                          // the rebuilt block lands 'abcdef'@10
    s.flushThinking();                                               // the sealed 'abcd' finds it
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcdef', 10]]);
    expect(s.thinkingRetry).toHaveLength(0);
    expect(s.holdbacks.size).toBe(0);
  });

  it('a replay-opened block whose row is already LONGER: no insert, `thinking_flushed` carries the row\'s length', () => {
    const s = mkStream();
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    send(s, [delta(10, 'ab'), delta(11, 'cd'), delta(12, 'ef')]);
    failMessageInserts = 1;
    s._persist('user', 'interjection');                              // sealed 'abcdef'@10
    failMessageInserts = 2;                                          // the retries before the lookup and at the open
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 2 });
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);                     // rebuilds 'abcd'
    s._persist('user', 'second');                                    // its retry lands 'abcdef', the block finds it
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    const t = thinkingRows();
    expect(t.map((r: any) => [r.text, r.seq])).toEqual([['abcdef', 10]]);
    const flushed = emitted.mock.calls.map(([e]) => e).filter((e: any) => e.type === 'thinking_flushed');
    expect(flushed.at(-1)).toEqual({ type: 'thinking_flushed', rowId: t[0].id, length: 6, replay: true });
    expect(s.holdbacks.size).toBe(0);
  });

  it('pins of events dropped behind a failing assistant flush share ONE key (the lowest seq)', () => {
    const s = mkStream();
    send(s, [ev('assistant_text', 9, { delta: 'Hi' })]);
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    send(s, Array.from({ length: 2000 }, (_, i) => delta(10 + i, 'x')));
    expect([...s.holdbacks.keys()].sort()).toEqual(['assistant:9', 'event']);
    expect(s.holdbacks.get('event')).toBe(9);                        // the buffer's anchor (`_pinEvent`)
    expect(s._durableCursor()).toBe(8);
    failMessageInserts = 0;
    send(s, [ev('stop', 3000, { subtype: 'success' })]);              // the flush lands
    expect([...s.holdbacks.keys()]).toEqual(['event']);
    expect(s._durableCursor()).toBe(8);
  });
});

describe('a replay window starting INSIDE a persisted row (overlapping resubscribe)', () => {
  it('Codex reasoning: a block closed live, then a burst from its middle ⇒ one row, nothing re-broadcast', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    // resumeSession resubscribes after 10 ('a' received); 11-13 arrive live
    // before the agent answers, and the block closes at 13.
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    const frames = emitted.mock.calls.length;
    replay(s, [delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    send(s, [ev('stop', 14, { subtype: 'success' })]);
    s._flushLiveBroadcast();
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abc', 10]]);
    expect(rows().filter((r: any) => r.role === 'tool_use')).toHaveLength(1);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toEqual([
      { role: 'thinking', content: 'abc', thinkingDelta: true },
    ]);
    expect(emitted.mock.calls.slice(frames).map(([e]: any[]) => e.type)
      .filter((t: string) => t === 'thinking' || t === 'thinking_flushed')).toEqual([]);
    expect(s._durableCursor()).toBe(14);
  });

  it('double replay whose second burst starts mid-block: the block rebuilt by the first is not written again', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    replay(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    replay(s, [delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abc', 10]]);
  });

  it('a row proved by the cover (persisted by an earlier process): a later burst from its middle writes nothing', () => {
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'abc' }), seq: 10, tsMs: T0 + 10,
    }).run();
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't13', name: 'Read', input: {} }),
      seq: 13, tsMs: T0 + 13,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    replay(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    replay(s, [delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    expect(rows()).toHaveLength(2);
  });

  it('a block cut by a hub writer, and a sealed block landed by its retry: a burst from inside either writes nothing', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    send(s, [delta(10, 'a'), delta(11, 'b')]);
    s.flushThinking();                                               // I8 cut: 'ab'@10
    send(s, [delta(12, 'c'), delta(13, 'd'), delta(14, 'e')]);
    failMessageInserts = 1;
    send(s, [toolUse(15)]);                                          // 'cde'@12 sealed
    send(s, [delta(16, 'f'), toolUse(17)]);                          // its retry lands it, then 'f'@16
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab', 10], ['cde', 12], ['f', 16]]);
    replay(s, [delta(13, 'd'), delta(14, 'e'), toolUse(15)]);        // inside the retried block
    replay(s, [delta(11, 'b'), delta(12, 'c'), delta(13, 'd'), delta(14, 'e'), toolUse(15)]);   // inside the cut one
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab', 10], ['cde', 12], ['f', 16]]);
    expect(rows().filter((r: any) => r.role === 'tool_use').map((r: any) => r.seq)).toEqual([15, 17]);
  });

  it('a block a window reopens from its anchor (its row was deleted meanwhile) keeps every delta: the span never cuts it', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();   // a rewind
    replay(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abc', 10]]);
  });

  it('a recreated log reusing the seqs (later ts) is new reasoning, never swallowed by the span', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    const later = (T0 + 60_000) / 1000;
    replay(s, [ev('thinking', 11, { text: 'new', ts: later }),
      ev('tool_use', 12, { id: 'n12', name: 'Read', input: {}, ts: later + 0.001 })]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abc', 10], ['new', 11]]);
  });

  it.each(['codex', 'claude'])('%s assistant text: a flush row closed live, then a burst from its middle ⇒ one row', (kind) => {
    const s = mkStream({ kind, lastSeenSeq: 9 });
    const text = (seq: number, delta: string) => ev('assistant_text', seq, { delta });
    send(s, [text(10, 'Hel'), text(11, 'lo '), text(12, 'there'), toolUse(13)]);
    replay(s, [text(11, 'lo '), text(12, 'there'), toolUse(13)]);
    // A window from the ANCHOR still accumulates the whole text (the
    // boundary's identity/prefix-extend needs it): the span only skips
    // deltas that would open a buffer mid-row.
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 4 });
    send(s, [text(10, 'Hel'), text(11, 'lo '), text(12, 'there')]);
    expect(s.getStreamingText()).toBe('Hello there');
    send(s, [toolUse(13)]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    send(s, [ev('stop', 14, { subtype: 'success' })]);
    expect(s.getStreamingText()).toBe('');
    expect(rows().filter((r: any) => r.role === 'assistant').map((r: any) => [r.content, r.seq]))
      .toEqual([['Hello there', 10]]);
  });

  it('assistant text: a row proved at a gated boundary (earlier process), then a burst from its middle ⇒ nothing written', () => {
    db.insert(schema.sessionMessages).values({ sessionId: SID, role: 'assistant', content: 'abc', seq: 10, tsMs: T0 + 10 }).run();
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't13', name: 'Read', input: {} }),
      seq: 13, tsMs: T0 + 13,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    const text = (seq: number, delta: string) => ev('assistant_text', seq, { delta });
    replay(s, [text(10, 'a'), text(11, 'b'), text(12, 'c'), toolUse(13)]);
    replay(s, [text(11, 'b'), text(12, 'c'), toolUse(13)]);
    send(s, [ev('stop', 14, { subtype: 'success' })]);
    expect(rows()).toHaveLength(2);
  });
});

describe('PersistedSpans (thinkingBoundaries.ts)', () => {
  it('covers the seqs after a span\'s anchor through its last delta, ts-matched; never the anchor itself', async () => {
    const { PersistedSpans } = await import('@/lib/server/agent/thinkingBoundaries');
    const spans = new PersistedSpans();
    spans.record(10, 12, 1000, 1002);
    spans.record(20, 20, 2000, 2000);                                // one delta: its own identity
    expect(spans.size).toBe(1);
    expect([9, 10, 11, 12, 13, 20].map((seq) => spans.covers(seq, null))).toEqual([false, false, true, true, false, false]);
    expect(spans.covers(11, 1001)).toBe(true);
    expect(spans.covers(11, 1003)).toBe(true);                       // ±1 ms rounding
    expect(spans.covers(11, 1004)).toBe(false);                      // a recreated log: later ts
    expect(spans.covers(11, 998)).toBe(false);
    spans.record(30, 32, null, null);                                // undated span
    expect(spans.covers(31, null)).toBe(true);
    expect(spans.covers(31, 3001)).toBe(false);                      // never swallows a dated event
  });

  it('grows a known span, keeps spans sorted, and is bounded by count (lowest seqs first) and age', async () => {
    const { PersistedSpans } = await import('@/lib/server/agent/thinkingBoundaries');
    const spans = new PersistedSpans(3, 1000);
    spans.record(50, 52, 50, 52, 0);
    spans.record(10, 11, 10, 11, 0);                                 // an older block re-delivered late
    spans.record(10, 14, 10, 14, 0);                                 // the same row, grown
    expect(spans.covers(14, 14)).toBe(true);
    expect(spans.covers(51, 51)).toBe(true);
    spans.record(30, 31, 30, 31, 0);
    spans.record(70, 71, 70, 71, 0);                                 // over the cap: 10 goes
    expect(spans.size).toBe(3);
    expect(spans.covers(14, 14)).toBe(false);
    expect([31, 51, 71].map((seq) => spans.covers(seq, seq))).toEqual([true, true, true]);
    spans.record(90, 91, 90, 91, 1500);                              // over the cap (30), then stale (50, 70)
    expect(spans.size).toBe(1);
    expect([31, 51, 71, 91].map((seq) => spans.covers(seq, seq))).toEqual([false, false, false, true]);
    const many = new PersistedSpans();
    for (let i = 0; i < 1000; i++) many.record(10 * i, 10 * i + 5, null, null);
    expect(many.covers(5005, null)).toBe(true);
    expect(many.covers(5007, null)).toBe(false);
  });
});

describe('an event dropped behind a failed assistant flush (order rule 16.3)', () => {
  it.each(['codex', 'claude'])('%s: it pins the cursor after the flush succeeds; the restart replay persists it once', (kind) => {
    const s = mkStream({ kind });
    send(s, [ev('assistant_text', 10, { delta: 'Hel' }), ev('assistant_text', 11, { delta: 'lo' })]);
    failMessageInserts = 1;
    send(s, [toolUse(12)]);                                          // flush fails ⇒ tool_use 12 dropped
    expect(rows()).toEqual([]);
    send(s, [ev('stop', 13, { subtype: 'success' })]);               // the retried flush succeeds
    expect(rows().map((r: any) => [r.role, r.seq])).toEqual([['assistant', 10]]);
    expect(s.holdbacks.has('assistant:10')).toBe(false);
    expect(s._durableCursor()).toBe(9);                              // pinned at the buffer's anchor
    const persisted = db.select({ c: schema.agentSessions.lastSeenSeq }).from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, SID)).get().c;
    expect(persisted).toBe(9);
    // Restart: the replay from the durable cursor writes tool_use 12 once.
    const s2 = mkStream({ kind, lastSeenSeq: persisted });
    replay(s2, [ev('assistant_text', 10, { delta: 'Hel' }), ev('assistant_text', 11, { delta: 'lo' }),
      toolUse(12), ev('stop', 13, { subtype: 'success' })]);
    expect(orderChronologically(rows()).map((r: any) => [r.role, r.seq])).toEqual([['assistant', 10], ['tool_use', 12]]);
    expect(s2._durableCursor()).toBe(13);
  });

  it('a Codex reasoning delta dropped there is rebuilt by the restart replay, in order', () => {
    const s = mkStream();
    send(s, [ev('assistant_text', 10, { delta: 'Hel' }), ev('assistant_text', 11, { delta: 'lo' })]);
    failMessageInserts = 1;
    send(s, [delta(12, 'LOST ')]);                                   // flush fails ⇒ the delta is dropped
    send(s, [delta(13, 'kept'), toolUse(14)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['kept', 13]]);
    expect(s._durableCursor()).toBe(9);
    const s2 = mkStream({ lastSeenSeq: 9 });
    replay(s2, [ev('assistant_text', 10, { delta: 'Hel' }), ev('assistant_text', 11, { delta: 'lo' }),
      delta(12, 'LOST '), delta(13, 'kept'), toolUse(14)]);
    expect(orderChronologically(thinkingRows()).map((r: any) => [r.text, r.seq])).toEqual([['LOST ', 12], ['kept', 13]]);
    expect(rows().filter((r: any) => r.role === 'assistant')).toHaveLength(1);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toEqual([
      { role: 'thinking', content: 'LOST kept', thinkingDelta: true },
    ]);
  });
});

describe('replay identity of delta reasoning', () => {
  it('crash mid-block: the replay rebuilds exactly one row', () => {
    const s = mkStream();
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    const cursor = s._durableCursor();
    expect(cursor).toBe(9);
    const s2 = mkStream({ lastSeenSeq: cursor });
    replay(s2, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    send(s2, [delta(13, 'd'), toolUse(14)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq, r.tsMs])).toEqual([['abcd', 10, T0 + 10]]);
  });

  it('SIGTERM partial + replay + live continuation: prefix row + adjacent remainder, rendered like the uninterrupted run', () => {
    const parts = ['Let ', 'me ', 'check', ' the ', 'file'];
    // Uninterrupted reference.
    const ref = mkStream({ id: REF_SID });
    send(ref, [...parts.map((t, i) => delta(10 + i, t, REF_SID)), toolUse(15, 't15', REF_SID)]);

    const s = mkStream();
    send(s, parts.slice(0, 3).map((t, i) => delta(10 + i, t)));
    s.flushPendingAssistant();                                       // SIGTERM: partial 'Let me check'@10
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['Let me check', 10]]);
    const s2 = mkStream({ lastSeenSeq: 9 });                         // the durable cursor never passed the block
    replay(s2, parts.slice(0, 4).map((t, i) => delta(10 + i, t)));
    send(s2, [delta(14, 'file'), toolUse(15)]);                      // live continuation
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['Let me check', 10], [' the file', 13]]);
    expect(rendered(SID)).toEqual(rendered(REF_SID));
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toHaveLength(1);
  });

  it('legacy per-delta rows + replay ⇒ zero inserts, no text broadcast (the window\'s first row is re-cut)', () => {
    const insert = (seq: number, text: string) => db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text }), seq, tsMs: T0 + seq,
    }).run();
    insert(10, 'a'); insert(11, 'b'); insert(12, 'c');
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't13', name: 'Read', input: {} }),
      seq: 13, tsMs: T0 + 13,
    }).run();
    const before = rows().length;
    const s = mkStream({ lastSeenSeq: 9 });
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    replay(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    s._flushLiveBroadcast();
    expect(rows()).toHaveLength(before);
    // Positional, no content (step review 3): one cut, not one per per-delta row.
    expect(emitted.mock.calls.map(([e]: any[]) => e).filter((e: any) => e.type === 'thinking' || e.type === 'thinking_flushed'))
      .toEqual([{ type: 'thinking_flushed', rowId: thinkingRows()[0].id, length: 1, replay: true }]);
  });

  it('a compacted merged row + replay of the same deltas ⇒ zero inserts', () => {
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'abc' }), seq: 10, tsMs: T0 + 10,
    }).run();
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't13', name: 'Read', input: {} }),
      seq: 13, tsMs: T0 + 13,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    replay(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    expect(rows()).toHaveLength(2);
    expect(s.getStreamingThinking()).toBe('');
  });

  it('a cover is positional: it never matches text after a boundary', () => {
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'abab' }), seq: 10, tsMs: T0 + 10,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    // Only 'ab' of the row is replayed before a boundary: the cover resets,
    // and the 'ab' after it is new reasoning.
    replay(s, [delta(10, 'ab'), toolUse(11), delta(12, 'ab'), toolUse(13)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abab', 10], ['ab', 12]]);
  });

  it('a cover is positional inside its row: it matches only from its start, never text found further in', () => {
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'aXb' }), seq: 10, tsMs: T0 + 10,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    // The rest of the row is 'Xb': a replayed 'b' does not start it — new reasoning.
    replay(s, [delta(10, 'a'), delta(11, 'b'), toolUse(12)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['aXb', 10], ['b', 11]]);
  });

  it('a cover moves forward in seq: the anchor replayed again inside one window restarts it, never consumes it', () => {
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'abab' }), seq: 10, tsMs: T0 + 10,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    replay(s, [delta(10, 'ab'), delta(10, 'ab'), delta(11, 'ab'), toolUse(12)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abab', 10]]);
  });

  it('a cover left by a cut re-delivery window never swallows the next window\'s new deltas', () => {
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'ab the' }), seq: 10, tsMs: T0 + 10,
    }).run();
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't14', name: 'Read', input: {} }),
      seq: 14, tsMs: T0 + 14,
    }).run();
    const s = mkStream({ lastSeenSeq: 20 });
    // A re-delivery of older events (overlapping resubscribe, reset replay) is cut
    // right after the row's first delta: the rest ' the' is left over.
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 5 });
    send(s, [delta(10, 'ab')]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
    expect(s.replayThinkingCover).toBe(' the');
    // The next window does not resume where the cut stopped (here it starts
    // at 21: a rotated log): ' the' at 21 is NEW reasoning.
    replay(s, [delta(21, ' the'), delta(22, ' end'), toolUse(23)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab the', 10], [' the end', 21]]);
  });

  it('a cut re-delivery window resumed where it stopped: the cover carries over, the row\'s tail is not written again', () => {
    // 'ab the' = deltas 10 and 12 (a rate_limit at 11 between them).
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'ab the' }), seq: 10, tsMs: T0 + 10,
    }).run();
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't14', name: 'Read', input: {} }),
      seq: 14, tsMs: T0 + 14,
    }).run();
    const s = mkStream({ lastSeenSeq: 20 });
    s.attach();
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 5 });
    send(s, [delta(10, 'ab')]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
    expect(pool.cursors.get(SID)).toBe(10);                          // the reconnect resumes after 10
    replay(s, [ev('rate_limit', 11, { status: 'allowed' }), delta(12, ' the'), toolUse(14),
      delta(21, ' the'), delta(22, ' end'), toolUse(23)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab the', 10], [' the end', 21]]);
    expect(pool.cursors.get(SID)).toBe(23);
    s.detach();
  });

  it('a hub-restart window cut mid-row: the next window resumes the cover (also through a transparent event), no duplicate', () => {
    // 'ab the' = deltas 10 and 12 (a rate_limit at 11 between them).
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'ab the' }), seq: 10, tsMs: T0 + 10,
    }).run();
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't14', name: 'Read', input: {} }),
      seq: 14, tsMs: T0 + 14,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 6 });
    send(s, [delta(10, 'ab'), ev('rate_limit', 11, { status: 'allowed' })]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
    // The reconnect resumes right after 11.
    replay(s, [delta(12, ' the'), toolUse(14), delta(15, 'next'), toolUse(16)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab the', 10], ['next', 15]]);
    expect(rows().filter((r: any) => r.role === 'tool_use').map((r: any) => r.seq)).toEqual([14, 16]);
  });

  it('attach + resubscribe double replay ⇒ no doubled text', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    const block = [delta(10, 'one '), delta(11, 'two '), delta(12, 'three')];
    replay(s, block);
    replay(s, block);
    send(s, [toolUse(13)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['one two three', 10]]);
    // The same range twice inside ONE window: the replay-only seq guard.
    const s2 = mkStream({ id: REF_SID, lastSeenSeq: 9 });
    replay(s2, [delta(10, 'one ', REF_SID), delta(11, 'two ', REF_SID), delta(10, 'one ', REF_SID),
      delta(11, 'two ', REF_SID), delta(12, 'three', REF_SID)], REF_SID);
    send(s2, [toolUse(13, 't13', REF_SID)]);
    expect(thinkingRows(REF_SID).map((r: any) => r.text)).toEqual(['one two three']);
  });

  it('a resubscribe replaying deltas the LIVE block already holds writes them once (replay_begin keeps it open)', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    // resumeSession's resubscribe: the agent re-sends what it had queued
    // live, plus one delta this hub had not received yet.
    replay(s, [delta(11, 'b'), delta(12, 'c'), delta(13, 'd')]);
    expect(s.getStreamingThinking()).toBe('abcd');
    expect(s.pendingThinkingFromReplay).toBe(true);                 // its flush goes through identity
    send(s, [ev('status', null, { status: 'thinking' })]);           // the agent's seq-less post-subscribe status
    send(s, [delta(14, 'e'), toolUse(15)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcd', 10], ['e', 14]]);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toEqual([
      { role: 'thinking', content: 'abcde', thinkingDelta: true },
    ]);
  });

  it('a re-delivery from an older seq closes the live block, then rebuilds the older one (the guard covers only the open block)', () => {
    const s = mkStream({ lastSeenSeq: 99 });
    send(s, [delta(300, 'live ')]);
    // An overlapping replay from an older seq (100) arrives while 300 is open.
    replay(s, [delta(100, 'old'), ev('turn_error', 101, { kind: 'overloaded' }), delta(300, 'live ')]);
    send(s, [delta(301, 'more'), toolUse(302)]);
    expect(orderChronologically(thinkingRows()).map((r: any) => [r.text, r.seq]))
      .toEqual([['old', 100], ['live ', 300], ['more', 301]]);
  });

  it('a replayed delta at a persisted row closes the open block: later uncovered deltas never join it out of order', () => {
    // 11 was never persisted; 12.. is a SIGTERM partial 'BC' of the block 12-14.
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'BC' }), seq: 12, tsMs: T0 + 12,
    }).run();
    const s = mkStream({ lastSeenSeq: 10 });
    replay(s, [delta(11, 'A'), delta(12, 'B'), delta(13, 'C'), delta(14, 'D'), toolUse(15)]);
    expect(orderChronologically(thinkingRows()).map((r: any) => [r.text, r.seq]))
      .toEqual([['A', 11], ['BC', 12], ['D', 14]]);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toEqual([
      { role: 'thinking', content: 'ABCD', thinkingDelta: true },
    ]);
  });

  it('a replay-opened block whose row DIVERGED meanwhile is inserted beside it, with a warning (a duplicate beats a loss)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = mkStream({ lastSeenSeq: 9 });
      s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
      send(s, [delta(10, 'ab'), delta(11, 'cd')]);                   // no row at 10 yet: the block opens
      db.insert(schema.sessionMessages).values({               // another writer's row appears meanwhile
        sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'xyz' }), seq: 10, tsMs: T0 + 10,
      }).run();
      send(s, [toolUse(12)]);
      s._onAgentEvent({ event: 'replay_end', session_id: SID });
      expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['xyz', 10], ['abcd', 10]]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[replay] thinking diverged at seq 10'));
    } finally {
      warn.mockRestore();
    }
  });

  it('a replay-opened block whose sealed copy lands at its flush: no insert, `thinking_flushed` names the existing row', () => {
    const s = mkStream();
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    failMessageInserts = 1;
    s._persist('user', 'interjection');                              // sealed 'abcd'@10
    failMessageInserts = 2;                                          // the retries before the lookup and at the open
    replay(s, [delta(10, 'ab'), delta(11, 'cd')]);
    expect(s.getStreamingThinking()).toBe('abcd');
    send(s, [toolUse(12)]);                                          // the retry lands 'abcd' = the block's text
    const t = thinkingRows();
    expect(t.map((r: any) => [r.text, r.seq])).toEqual([['abcd', 10]]);
    const flushed = emitted.mock.calls.map(([e]) => e).filter((e: any) => e.type === 'thinking_flushed');
    expect(flushed).toEqual([{ type: 'thinking_flushed', rowId: t[0].id, length: 4 }]);
    expect(s.holdbacks.size).toBe(0);
  });

  it('a replayed persisted delta while an assistant buffer is open: the buffer is dropped only if its flush row exists', () => {
    // Flush row present: no second assistant row.
    db.insert(schema.sessionMessages).values({ sessionId: SID, role: 'assistant', content: 'Hello', seq: 20, tsMs: T0 + 20 }).run();
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'x' }), seq: 22, tsMs: T0 + 22,
    }).run();
    const s = mkStream({ lastSeenSeq: 19 });
    replay(s, [ev('assistant_text', 20, { delta: 'Hel' }), ev('assistant_text', 21, { delta: 'lo' }), delta(22, 'x')]);
    expect(s.getStreamingText()).toBe('');
    expect(rows().filter((r: any) => r.role === 'assistant')).toHaveLength(1);

    // Flush row missing (it failed before the crash): the buffer is KEPT —
    // no early row at the replayed delta; the next boundary writes it, dated
    // from its first delta.
    db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.id, rows().find((r: any) => r.role === 'assistant').id)).run();
    const s2 = mkStream({ lastSeenSeq: 19 });
    replay(s2, [ev('assistant_text', 20, { delta: 'Hel' }), ev('assistant_text', 21, { delta: 'lo' }), delta(22, 'x')]);
    expect(rows().filter((r: any) => r.role === 'assistant')).toHaveLength(0);
    expect(s2.getStreamingText()).toBe('Hello');
    send(s2, [toolUse(23)]);
    expect(rows().filter((r: any) => r.role === 'assistant').map((r: any) => [r.content, r.seq])).toEqual([['Hello', 20]]);
    expect(thinkingRows()).toHaveLength(1);
  });
});

describe('broadcast lane and thinking_flushed', () => {
  it('N deltas within 25 ms ⇒ one `thinking` frame, then `thinking_flushed`, then the boundary', () => {
    vi.useFakeTimers();
    const s = mkStream();
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    send(s, ['0', '.', '154'].map((t, i) => delta(1 + i, t)));
    expect(emitted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25);
    expect(emitted.mock.calls.map(([e]) => e)).toEqual([{ type: 'thinking', text: '0.154' }]);
    send(s, [delta(4, '.'), delta(5, '0'), toolUse(6)]);
    const [row] = thinkingRows();
    expect(emitted.mock.calls.map(([e]) => e).slice(1)).toEqual([
      { type: 'thinking', text: '.0' },
      { type: 'thinking_flushed', rowId: row.id, length: 7 },
      expect.objectContaining({ type: 'tool_use', id: 't6' }),
    ]);
  });

  it('lane and replay switches flush first; replayed frames keep their tag', () => {
    const s = mkStream({ lastSeenSeq: 0 });
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    replay(s, [delta(1, 'old ')]);
    send(s, [delta(2, 'new'), ev('assistant_text', 3, { delta: 'Hi' })]);
    s._flushAssistantBroadcast();                                    // the alias still works
    const frames = emitted.mock.calls.map(([e]) => e);
    expect(frames).toEqual([
      // The replay reopens a block with no row (step review 3).
      { type: 'thinking_reopened', replay: true },
      { type: 'thinking', text: 'old ', replay: true },
      { type: 'thinking', text: 'new' },
      // A block a replay rebuilt carries its text at the cut (S1 review).
      { type: 'thinking_flushed', rowId: thinkingRows()[0].id, length: 7, content: 'old new' },
      { type: 'assistant_text', delta: 'Hi' },
    ]);
  });
});

describe('session GET', () => {
  it('returns the open block as `streamingThinking`', async () => {
    const s = getOrCreateStream(GET_SID);
    s._onAgentEvent({ event: 'thinking', session_id: GET_SID, seq: 5, ts: (T0 + 5) / 1000, text: 'half a ' });
    s._onAgentEvent({ event: 'thinking', session_id: GET_SID, seq: 6, ts: (T0 + 6) / 1000, text: 'thought' });
    const { GET } = await import('@/app/api/sessions/[id]/route');
    const get = async () => (await GET(new Request(`http://localhost/api/sessions/${GET_SID}?open=1`),
      { params: Promise.resolve({ id: GET_SID }) })).json();
    const open = await get();
    expect(open.streamingThinking).toBe('half a thought');
    expect(open.streamingThinkingTsMs).toBe(T0 + 5);                 // the open bubble's date
    expect(open.messages.filter(isThinkingRow)).toEqual([]);
    s._onAgentEvent({ event: 'tool_use', session_id: GET_SID, seq: 7, ts: (T0 + 7) / 1000, id: 'g', name: 'Read', input: {} });
    const closed = await get();
    expect(closed.streamingThinking).toBe('');
    expect(closed.messages.filter(isThinkingRow).map((r: any) => JSON.parse(r.content).text)).toEqual(['half a thought']);
  });
});

describe('session GET (step review)', () => {
  const getFrom = async (query: string) => {
    const { GET } = await import('@/app/api/sessions/[id]/route');
    return (await GET(new Request(`http://localhost/api/sessions/${GET_SID}${query}`),
      { params: Promise.resolve({ id: GET_SID }) })).json();
  };

  it('emits the lane coalescer\'s pending frame BEFORE the snapshot holding its text is built', async () => {
    vi.useFakeTimers({ now: Date.now() });
    const s = getOrCreateStream(GET_SID);
    const emitted = vi.spyOn(s, '_emitBroadcast');
    s._onAgentEvent({ event: 'thinking', session_id: GET_SID, seq: 105, ts: (T0 + 105) / 1000, text: '**Checking** ' });
    vi.advanceTimersByTime(25);
    s._onAgentEvent({ event: 'thinking', session_id: GET_SID, seq: 106, ts: (T0 + 106) / 1000, text: 'the ' });
    const frames = () => emitted.mock.calls.map(([e]) => e).filter((e: any) => e.type === 'thinking').map((e: any) => e.text);
    expect(frames()).toEqual(['**Checking** ']);                     // 'the ' still in the 25 ms lane
    const r = await getFrom('?open=1');
    expect(r.streamingThinking).toBe('**Checking** the ');
    expect(frames()).toEqual(['**Checking** ', 'the ']);             // its frame went out first
    vi.advanceTimersByTime(25);
    expect(frames()).toEqual(['**Checking** ', 'the ']);             // never twice
    s._onAgentEvent({ event: 'tool_use', session_id: GET_SID, seq: 107, ts: (T0 + 107) / 1000, id: 'g2', name: 'Read', input: {} });
    emitted.mockRestore();
  });

  it('an old bundle (no `open=1`) gets the open block as ONE synthetic row, last, that no cursor can take', async () => {
    const s = getOrCreateStream(GET_SID);
    s._onAgentEvent({ event: 'tool_use', session_id: GET_SID, seq: 110, ts: (T0 + 110) / 1000, id: 'g3', name: 'Read', input: {} });
    s._onAgentEvent({ event: 'thinking', session_id: GET_SID, seq: 111, ts: (T0 + 111) / 1000, text: '**Planning the fix**\n\n' });
    s._onAgentEvent({ event: 'thinking', session_id: GET_SID, seq: 112, ts: (T0 + 112) / 1000, text: 'I will read the file' });
    const legacy = await getFrom('');
    const last = legacy.messages.at(-1);
    expect(last).toMatchObject({ id: -1, role: 'event', tsMs: T0 + 111, createdAt: Math.floor((T0 + 111) / 1000) });
    expect(JSON.parse(last.content)).toEqual({ type: 'thinking', text: '**Planning the fix**\n\nI will read the file' });
    expect(legacy.maxMessageId).toBeGreaterThan(0);                  // the real cursor is untouched
    // What the old client renders: the rebuilt block, then its next live frame joins it.
    const { appendThinkingMessage } = await import('@/app/thinkingMessages');
    const shown = appendThinkingMessage(
      rebuildStateFromMessages(legacy.messages, 'thinking', 'codex').messages,
      { id: 'th1', role: 'thinking', content: ' and then patch it.', thinkingDelta: true, createdAt: 0 },
    ).filter((m: any) => m.role === 'thinking').map((m: any) => m.content);
    expect(shown).toEqual(['**Planning the fix**\n\nI will read the file and then patch it.']);
    // The legacy delta poll sees it too (so it reloads, as it did per delta).
    const delta = await getFrom(`?since=${legacy.maxMessageId}`);
    expect(delta.messages.map((m: any) => m.id)).toEqual([-1]);
    // A current client reads the field instead.
    const current = await getFrom('?open=1');
    expect(current.messages.some((m: any) => m.id === -1)).toBe(false);
    expect((await getFrom(`?since=${legacy.maxMessageId}&open=1`)).messages).toEqual([]);
    s._onAgentEvent({ event: 'tool_use', session_id: GET_SID, seq: 113, ts: (T0 + 113) / 1000, id: 'g4', name: 'Read', input: {} });
    expect((await getFrom('')).messages.some((m: any) => m.id === -1)).toBe(false);   // closed: a real row
  });
});

describe('step review: a failed assistant flush whose buffer runs on (16.3)', () => {
  const text = (seq: number, delta: string) => ev('assistant_text', seq, { delta });
  const assistantRows = () => orderChronologically(rows()).filter((r: any) => r.role === 'assistant')
    .map((r: any) => [r.content, r.seq]);
  const toolIds = () => rows().filter((r: any) => r.role === 'tool_use').map((r: any) => JSON.parse(r.content).id).sort();
  const persistedCursor = () => db.select({ c: schema.agentSessions.lastSeenSeq }).from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, SID)).get().c;

  it.each(['codex', 'claude'])('%s: the restart replays from the row\'s anchor and writes every row once', (kind) => {
    const log = [text(10, 'Hello '), text(11, 'world'), toolUse(12, 'tu1'), text(13, ' again'), toolUse(14, 'tu2'),
      text(16, 'Bye'), toolUse(17, 'tu3'), ev('stop', 18, { subtype: 'success' })];
    const s = mkStream({ kind });
    send(s, log.slice(0, 2));
    failMessageInserts = 1;
    send(s, log.slice(2));                                           // tool_use 12 dropped, ' again' joins the buffer
    expect(assistantRows()).toEqual([['Hello world again', 10], ['Bye', 16]]);
    expect(toolIds()).toEqual(['tu2', 'tu3']);
    // Never strictly inside the row [10..13]: a restart starts at its anchor.
    expect(s._durableCursor()).toBe(9);
    expect(persistedCursor()).toBe(9);
    const s2 = mkStream({ kind, lastSeenSeq: persistedCursor() });
    replay(s2, log);
    expect(assistantRows()).toEqual([['Hello world again', 10], ['Bye', 16]]);
    expect(toolIds()).toEqual(['tu1', 'tu2', 'tu3']);
    expect(s2._durableCursor()).toBe(18);
  });

  it.each(['codex', 'claude'])('%s: text after the dropped boundary closed by a stop: no duplicated tail', (kind) => {
    const log = [text(10, 'Hel'), text(11, 'lo'), toolUse(12), text(13, ' world'), ev('stop', 14, { subtype: 'success' })];
    const s = mkStream({ kind });
    send(s, log.slice(0, 2));
    failMessageInserts = 1;
    send(s, log.slice(2));
    expect(assistantRows()).toEqual([['Hello world', 10]]);
    const s2 = mkStream({ kind, lastSeenSeq: persistedCursor() });
    replay(s2, log);
    expect(orderChronologically(rows()).map((r: any) => [r.role, r.seq])).toEqual([['assistant', 10], ['tool_use', 12]]);
    expect(assistantRows()).toEqual([['Hello world', 10]]);
  });

  it('codex: a reasoning delta dropped there, then text: the restart rebuilds it without a second answer', () => {
    const log = [text(10, 'Hel'), text(11, 'lo'), delta(12, 'R'), text(13, ' world'), ev('stop', 14, { subtype: 'success' })];
    const s = mkStream();
    send(s, log.slice(0, 2));
    failMessageInserts = 1;
    send(s, log.slice(2));
    expect(assistantRows()).toEqual([['Hello world', 10]]);
    expect(thinkingRows()).toEqual([]);
    const s2 = mkStream({ lastSeenSeq: persistedCursor() });
    replay(s2, log);
    expect(assistantRows()).toEqual([['Hello world', 10]]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['R', 12]]);
  });

  it('a replayed stop whose live flush failed keeps the buffer: nothing is finalized there, as live', () => {
    const log = [text(10, 'A'), ev('stop', 11, { subtype: 'success' }), text(13, 'B'), toolUse(14)];
    const s = mkStream();
    send(s, log.slice(0, 1));
    failMessageInserts = 1;
    send(s, log.slice(1));                                           // the stop's flush fails; 'B' joins the buffer
    const [row] = rows().filter((r: any) => r.role === 'assistant');
    expect([row.content, row.assistantFinal]).toEqual(['AB', 0]);
    expect(s._durableCursor()).toBe(9);
    // A crash before the next stop: its row is still the pending one.
    db.update(schema.agentSessions).set({ pendingAssistantMessageId: row.id }).where(eq(schema.agentSessions.id, SID)).run();
    const s2 = mkStream({ lastSeenSeq: 9 });
    const emitted = vi.spyOn(s2, '_emitBroadcast').mockImplementation(() => {});
    replay(s2, log.slice(0, 2));
    expect(s2.getStreamingText()).toBe('A');                         // the row is longer: the buffer runs on
    expect(emitted.mock.calls.map(([e]) => e).find((e: any) => e.type === 'stop')).toMatchObject({ finalAssistantId: null });
    expect(rows().filter((r: any) => r.role === 'assistant').map((r: any) => r.assistantFinal)).toEqual([0]);
    replay(s2, log.slice(2));
    expect(assistantRows()).toEqual([['AB', 10]]);
  });

  it('a kept buffer runs on only while it spells its row: a replay with a hole never swallows the next answer', () => {
    // 'Hello'@10 flushed live at a stop; the next answer was never persisted
    // (the hub was down); the replayed log lost delta 11.
    const s = mkStream();
    send(s, [text(10, 'Hel'), text(11, 'lo'), ev('stop', 12, { subtype: 'success' })]);
    const s2 = mkStream({ lastSeenSeq: 9 });
    replay(s2, [text(10, 'Hel'), ev('stop', 12, { subtype: 'success' }), text(14, 'NEW'), ev('stop', 15, { subtype: 'success' })]);
    expect(assistantRows()).toEqual([['Hello', 10], ['NEW', 14]]);
  });

  it('a kept buffer whose row is a SIGTERM partial of it extends that row', () => {
    const log = [text(10, 'Hel'), text(11, 'lo'), toolUse(12), text(13, ' wor'), text(14, 'ld'), ev('stop', 15, { subtype: 'success' })];
    const s = mkStream();
    send(s, log.slice(0, 2));
    failMessageInserts = 1;
    send(s, log.slice(2, 4));                                        // tool_use 12 dropped, ' wor' joins
    s.flushPendingAssistant();                                       // SIGTERM: 'Hello wor'@10
    expect(assistantRows()).toEqual([['Hello wor', 10]]);
    expect(s._durableCursor()).toBe(9);
    const s2 = mkStream({ lastSeenSeq: 9 });
    replay(s2, log);
    expect(assistantRows()).toEqual([['Hello world', 10]]);
    expect(orderChronologically(rows()).map((r: any) => [r.role, r.seq])).toEqual([['assistant', 10], ['tool_use', 12]]);
  });

  it('a row write lost while a buffer is open pins the buffer\'s anchor: the restart writes no tail twice', () => {
    const log = [text(10, 'A'), ev('tool_result', 11, { tool_use_id: 'x', content: 'ok', is_error: false }),
      text(12, 'B'), toolUse(13)];
    const s = mkStream();
    send(s, log.slice(0, 1));
    failMessageInserts = 1;
    send(s, log.slice(1));                                           // the tool_result row fails
    expect(assistantRows()).toEqual([['AB', 10]]);
    expect(s._durableCursor()).toBe(9);
    const s2 = mkStream({ lastSeenSeq: s._durableCursor() });
    replay(s2, log);
    expect(assistantRows()).toEqual([['AB', 10]]);
    expect(orderChronologically(rows()).map((r: any) => [r.role, r.seq]))
      .toEqual([['assistant', 10], ['tool_result', 11], ['tool_use', 13]]);
  });
});

describe('step review 3: a kept buffer at a REPAIRED boundary, and the span of a kept buffer', () => {
  const text = (seq: number, delta: string) => ev('assistant_text', seq, { delta });
  const assistantRows = () => orderChronologically(rows()).filter((r: any) => r.role === 'assistant')
    .map((r: any) => [r.content, r.seq]);
  const toolIds = () => rows().filter((r: any) => r.role === 'tool_use').map((r: any) => JSON.parse(r.content).id).sort();
  const stop = (seq: number) => ev('stop', seq, { subtype: 'success' });

  // The dropped boundary's row was repaired (tu51 exists now), so a later
  // replay GATES it — inside the row 'A50;A52;'@50 its buffer ran on into.
  it.each(['codex', 'claude'])('%s: repaired in-process, then any restart replays from the anchor: no duplicated tail', (kind) => {
    const log = [text(50, 'A50;'), toolUse(51, 'tu51'), text(52, 'A52;'), toolUse(53, 'tu53'), text(54, 'X'), toolUse(55, 'tu55')];
    const s = mkStream({ kind });
    send(s, log.slice(0, 1));
    failMessageInserts = 1;
    send(s, log.slice(1, 4));                                        // tu51 dropped; 'A50;A52;'@50 at tu53
    expect(assistantRows()).toEqual([['A50;A52;', 50]]);
    replay(s, log.slice(0, 4));                                      // a re-delivery repairs tu51 (the row is longer: kept)
    expect(toolIds()).toEqual(['tu51', 'tu53']);
    expect(s._durableCursor()).toBe(49);                             // the `event` pin is never released in-process
    const s2 = mkStream({ kind, lastSeenSeq: s._durableCursor() });
    replay(s2, log);                                                 // tu51 is GATED now
    expect(assistantRows()).toEqual([['A50;A52;', 50], ['X', 54]]);
    expect(toolIds()).toEqual(['tu51', 'tu53', 'tu55']);
  });

  it.each(['codex', 'claude'])('%s: two quick restarts after a SIGTERM partial: the second keeps the buffer at the repaired boundary', (kind) => {
    const log = [text(50, 'A50;'), toolUse(51, 'tu51'), text(52, 'A52;')];
    const s = mkStream({ kind });
    send(s, log.slice(0, 1));
    failMessageInserts = 1;
    send(s, log.slice(1));                                           // tu51 dropped, 'A52;' joins
    s.flushPendingAssistant();                                       // SIGTERM: 'A50;A52;'@50
    expect(s._durableCursor()).toBe(49);
    const s1 = mkStream({ kind, lastSeenSeq: 49 });
    replay(s1, log);                                                 // restart 1 repairs tu51, keeps the buffer…
    expect(s1._durableCursor()).toBe(49);                            // …and crashes before the next boundary
    const s2 = mkStream({ kind, lastSeenSeq: 49 });
    replay(s2, log);
    send(s2, [toolUse(53, 'tu53'), stop(54)]);
    expect(assistantRows()).toEqual([['A50;A52;', 50]]);
    expect(toolIds()).toEqual(['tu51', 'tu53']);
  });

  it('codex: the repaired boundary is a reasoning delta (a persisted thinking row inside the kept buffer)', () => {
    const log = [text(50, 'A50;'), delta(51, 'R'), text(52, 'A52;')];
    const s = mkStream();
    send(s, log.slice(0, 1));
    failMessageInserts = 1;
    send(s, log.slice(1));                                           // R51 dropped behind the failed flush
    s.flushPendingAssistant();                                       // SIGTERM: 'A50;A52;'@50
    const s1 = mkStream({ lastSeenSeq: 49 });
    replay(s1, log);                                                 // restart 1 writes R@51, keeps the buffer, crashes
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['R', 51]]);
    const s2 = mkStream({ lastSeenSeq: 49 });
    replay(s2, log);
    send(s2, [toolUse(53, 'tu53'), stop(54)]);
    expect(assistantRows()).toEqual([['A50;A52;', 50]]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['R', 51]]);
  });

  // A kept buffer may extend its row only when that row is a SIGTERM partial:
  // a replayed delta with a row of its own starts ANOTHER persisted row.
  it.each(['codex', 'claude'])('%s: a kept buffer never runs past its complete row into another persisted row', (kind) => {
    const s = mkStream({ kind });
    send(s, [text(24, 'A24;')]);
    failMessageInserts = 1;
    send(s, [toolUse(25, 'tu25'), text(26, 'A26;'), toolUse(27, 'tu27'), text(28, 'A28;'), stop(29)]);
    expect(assistantRows()).toEqual([['A24;A26;', 24], ['A28;', 28]]);
    // The restart's log lost tu27 (a hole): nothing ends 'A24;A26;' before A28.
    const s2 = mkStream({ kind, lastSeenSeq: s._durableCursor() });
    replay(s2, [text(24, 'A24;'), toolUse(25, 'tu25'), text(26, 'A26;'), text(28, 'A28;'), stop(29)]);
    expect(assistantRows()).toEqual([['A24;A26;', 24], ['A28;', 28]]);
    expect(toolIds()).toEqual(['tu25', 'tu27']);
  });

  // The span of a buffer flushed at a replayed boundary OLDER than its last
  // delta: it must reach that delta's ts, or the re-delivered tail is new text.
  const spaced = (e: any) => ({ ...e, ts: (T0 + e.seq * 250) / 1000 });   // 250 ms apart
  it.each(['codex', 'claude'])('%s: a kept buffer flushed at an older replayed boundary: its tail is not written again', (kind) => {
    const log = [text(55, 'A55;'), toolUse(56, 'tu56'), ev('tool_result', 57, { tool_use_id: 'x', content: 'ok', is_error: false }),
      text(58, 'A58;')].map(spaced);
    const s = mkStream({ kind });
    send(s, log.slice(0, 1));
    failMessageInserts = 1;
    send(s, log.slice(1));                                           // tu56 dropped; the buffer runs on: 'A55;A58;'
    expect(assistantRows()).toEqual([]);
    replay(s, log);                                                  // an overlapping window while it is open
    expect(assistantRows()).toEqual([['A55;A58;', 55]]);
    send(s, [toolUse(59, 'tu59'), stop(60)].map(spaced));
    expect(assistantRows()).toEqual([['A55;A58;', 55]]);
    expect(toolIds()).toEqual(['tu56', 'tu59']);
  });

  it('codex: same, the older boundary being a dropped reasoning delta', () => {
    const log = [text(55, 'A55;'), delta(56, 'R'), ev('tool_result', 57, { tool_use_id: 'x', content: 'ok', is_error: false }),
      text(58, 'A58;')].map(spaced);
    const s = mkStream();
    send(s, log.slice(0, 1));
    failMessageInserts = 1;
    send(s, log.slice(1));
    replay(s, log);
    send(s, [toolUse(59, 'tu59'), stop(60)].map(spaced));
    expect(assistantRows()).toEqual([['A55;A58;', 55]]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['R', 56]]);
  });
});

describe('step review: a sealed block and a replay window starting inside it', () => {
  it('E1: the retry fails at the first replayed delta: its tail is not opened as a second block', () => {
    const s = mkStream();
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    failMessageInserts = 1;
    send(s, [toolUse(13)]);                                          // sealed 'abc'@10
    failMessageInserts = 1;
    replay(s, [delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    send(s, [ev('stop', 14, { subtype: 'success' })]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abc', 10]]);
    expect(s.holdbacks.size).toBe(0);
  });

  it('E2: writes keep failing through the window: one entry stays sealed, it lands once', () => {
    const s = mkStream();
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    failMessageInserts = 1;
    send(s, [toolUse(13)]);
    failMessageInserts = 100;
    replay(s, [delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    expect(s.thinkingRetry.map((e: any) => [e.text, e.since])).toEqual([['abc', 10]]);
    failMessageInserts = 0;
    send(s, [ev('status', 14, { status: 'active' }), ev('stop', 15, { subtype: 'success' })]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abc', 10]]);
    expect(s.holdbacks.size).toBe(0);
  });

  it('a delta of ANOTHER epoch (ts outside the sealed block) is new reasoning', () => {
    const s = mkStream();
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    failMessageInserts = 1;
    send(s, [toolUse(13)]);
    failMessageInserts = 1;
    replay(s, [{ ...delta(11, 'new'), ts: (T0 + 5000) / 1000 }, { ...toolUse(12, 'tz'), ts: (T0 + 5001) / 1000 }]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq]).sort()).toEqual([['abc', 10], ['new', 11]]);
  });
});

describe('step review: coalesced rows are dated by their first delta', () => {
  it('created_at = the first delta\'s second, for a flushed block and for a sealed one landing later', () => {
    const s = mkStream();
    send(s, [delta(10, 'a'), delta(11, 'b'), toolUse(12)]);
    failMessageInserts = 1;
    send(s, [delta(20, 'c'), toolUse(21)]);                          // sealed
    send(s, [ev('status', 22, { status: 'active' })]);               // its retry lands it
    const created = rows().filter(isThinkingRow).map((r: any) => [r.seq, r.createdAt]);
    expect(created).toEqual([[10, Math.floor((T0 + 10) / 1000)], [20, Math.floor((T0 + 20) / 1000)]]);
    // The tool rows keep the column default (insert time): an hour later.
    expect(rows().find((r: any) => r.role === 'tool_use').createdAt).toBeGreaterThan(Math.floor((T0 + 10) / 1000) + 3000);
    expect(rebuildStateFromMessages(orderChronologically(rows()), 'active', 'codex').messages
      .find((m: any) => m.role === 'thinking').createdAt).toBe(Math.floor((T0 + 10) / 1000));
  });
});

describe('step review: a replay window cut by a disconnect (synthetic replay_end)', () => {
  const cut = (s: any) => s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
  const begin = (s: any) => s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 1 });
  /** The reconnect: the agent replays its log after the client's cursor. */
  const reconnect = (s: any, log: any[]) => replay(s, log.filter((e) => e.seq > pool.cursors.get(SID)!));

  it.each(['codex', 'claude'])('%s: a cut inside an old answer\'s re-delivery: the buffer is completed, the next answer kept', (kind) => {
    const s = mkStream({ kind });
    s.attach();
    const log = [ev('assistant_text', 202, { delta: 'Hello ' }), ev('assistant_text', 203, { delta: 'world' }),
      toolUse(204), ev('tool_result', 205, { tool_use_id: 't204', content: 'ok', is_error: false })];
    send(s, log);                                                    // 'Hello world'@202 persisted live
    // An overlapping resubscribe re-delivers from 201 and is cut after 202.
    begin(s);
    send(s, [log[0]]);
    cut(s);
    expect(s.getStreamingText()).toBe('Hello ');
    expect(pool.cursors.get(SID)).toBe(202);
    reconnect(s, log);
    log.push(ev('assistant_text', 211, { delta: 'NEW' }), toolUse(212));
    send(s, log.slice(-2));
    expect(orderChronologically(rows()).filter((r: any) => r.role === 'assistant').map((r: any) => [r.content, r.seq]))
      .toEqual([['Hello world', 202], ['NEW', 211]]);
    s.detach();
  });

  it('a cut window that had reached the frontier keeps the frontier cursor; a pool swap resubscribes from the cut', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    s.attach();
    begin(s);
    send(s, [delta(10, 'a'), delta(11, 'b')]);                       // new events: the frontier moves
    cut(s);
    expect(s.replayCutSeq).toBe(null);
    expect(pool.cursors.get(SID)).toBe(11);
    send(s, [toolUse(12), ev('stop', 30, { subtype: 'success' })]);
    // A re-delivery of older events cut after 12, then the pool swaps the client.
    begin(s);
    send(s, [toolUse(12)]);
    cut(s);
    expect(pool.cursors.get(SID)).toBe(12);
    const subscribe = vi.spyOn(pool.client, 'subscribe');
    s.attachedClient = {};                                           // the old client is gone
    expect(s.attach()).toBe(true);
    expect(subscribe).toHaveBeenLastCalledWith(SID, expect.any(Function), { afterSeq: 12 });
    // A window running to its end puts the cursor back on the frontier.
    replay(s, [ev('stop', 30, { subtype: 'success' })]);
    expect(s.replayCutSeq).toBe(null);
    expect(pool.cursors.get(SID)).toBe(30);
    // So does any event past the frontier (the cut's range was behind it).
    begin(s);
    send(s, [toolUse(12)]);
    cut(s);
    expect(s.replayCutSeq).toBe(12);
    send(s, [ev('status', 31, { status: 'active' })]);
    expect(s.replayCutSeq).toBe(null);
    expect(pool.cursors.get(SID)).toBe(31);
    subscribe.mockRestore();
    s.detach();
  });

  // Finding 3: a resumed cut window cut again exactly at the frontier.
  it('a resumed cut window cut again AT the frontier puts the cursor back on the frontier', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    s.attach();
    const log = [toolUse(12), ev('tool_result', 13, { tool_use_id: 't12', content: 'ok', is_error: false }),
      ev('stop', 30, { subtype: 'success' })];
    send(s, log);
    expect(pool.cursors.get(SID)).toBe(30);
    begin(s);                                                        // an older re-delivery, cut after 12
    send(s, [log[0]]);
    cut(s);
    expect(pool.cursors.get(SID)).toBe(12);
    begin(s);                                                        // its resume, cut after the frontier's event
    send(s, log.slice(1));
    cut(s);
    expect(s.replayCutSeq).toBe(null);
    expect(pool.cursors.get(SID)).toBe(30);
    reconnect(s, log);                                               // nothing left to replay
    expect(pool.cursors.get(SID)).toBe(30);
    expect(rows().map((r: any) => [r.role, r.seq])).toEqual([['tool_use', 12], ['tool_result', 13]]);
    s.detach();
  });
});

// Second step review, finding 5 (G2): a hub-side cut (a hub writer, the
// post-subscribe seq-less `status`) splits a live block with no boundary in
// the agent's log; both halves sealed during a DB outage. A replay window
// from the first anchor must not run the open block through the second
// sealed anchor (its row would also hold the second half: 'abcdcd').
describe('step review 2: a replay block never runs through a SEALED block\'s anchor', () => {
  const thinkingJoined = () => rendered(SID).filter((m: any) => m.role === 'thinking').map((m: any) => m.content);

  function sealCutBlock(s: any) {
    send(s, [delta(10, 'a'), delta(11, 'b')]);
    failMessageInserts = 1;
    s._persist('user', 'hi');                                        // the hub cut: sealed 'ab'@10..11
    failMessageInserts = 3;                                          // 'cd': its open's retry, its flush's retry + insert
    send(s, [delta(12, 'c'), delta(13, 'd')]);
    s.flushThinking();                                               // sealed 'cd'@12..13
    expect(s.thinkingRetry.map((e: any) => [e.text, e.since, e.lastSeq])).toEqual([['ab', 10, 11], ['cd', 12, 13]]);
  }
  const window = [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), delta(13, 'd'), toolUse(14)];

  it('the DB recovers inside the window: two rows, rendered once', () => {
    const s = mkStream();
    sealCutBlock(s);
    failMessageInserts = 2;                                          // the window's first lookups still fail
    replay(s, window);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab', 10], ['cd', 12]]);
    expect(thinkingJoined()).toEqual(['abcd']);
    expect(s.holdbacks.size).toBe(0);
  });

  it('writes keep failing through the window: the entries stay apart and land once', () => {
    const s = mkStream();
    sealCutBlock(s);
    failMessageInserts = 100;
    replay(s, window);
    expect(s.thinkingRetry.map((e: any) => [e.text, e.since])).toEqual([['ab', 10], ['cd', 12]]);
    failMessageInserts = 0;
    s.flushThinking();
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab', 10], ['cd', 12]]);
    expect(thinkingJoined()).toEqual(['abcd']);
  });
});

// Second step review, findings 6 and 7: the browser's live reasoning, driven
// through the client's REAL lane (app/thinkingMessages.ts, the functions
// useSessionStream calls) with the hub's REAL frames, renders what a
// reload of the persisted rows renders.
describe('step review 2: live reasoning (client lane + hub frames) == reload', () => {
  type Browser = { lane: ThinkingLane; messages: Msg[]; n: number };
  const browser = (): Browser => ({ lane: createThinkingLane(), messages: [], n: 0 });
  const fragment = (b: Browser) => ({ id: `th${++b.n}`, createdAt: 0 });
  /** Frame types the hook turns into a transcript message (a placeholder here). */
  const RENDERED = new Set(['tool_use', 'tool_result', 'assistant_text', 'user_echo', 'blocking_error']);
  /** Frame types after which the hook closes the open bubble. */
  const closes = (f: any) => f.type === 'stop' || f.type === 'error' || (f.type === 'usage' && f.final);

  /** handleEvent's reasoning path, frame by frame. `commitEvery`: a delta is
   *  committed at once (the 80 ms timer firing between frames) or batched. */
  function receive(b: Browser, frames: any[], commitEvery = true) {
    for (const f of frames) {
      const committed = thinkingLaneBeforeFrame(b.lane, f.type, fragment(b));
      if (committed) b.messages = committed(b.messages);
      if (f.type === 'thinking') {
        thinkingLaneDelta(b.lane, f.text);
        if (commitEvery) b.messages = thinkingLaneCommit(b.lane, fragment(b))?.(b.messages) ?? b.messages;
      } else if (f.type === 'thinking_flushed') {
        b.messages = thinkingLaneFlushed(b.lane, f)(b.messages);
      } else if (f.type === 'thinking_reopened') {
        b.messages = thinkingLaneReopened(b.lane)(b.messages);
      } else if (RENDERED.has(f.type)) {
        b.messages = [...b.messages, { id: `x${++b.n}`, role: f.type, content: '', createdAt: 0 }];
      }
      if (closes(f)) b.messages = closeThinkingMessage(b.messages);
    }
    b.messages = thinkingLaneCommit(b.lane, fragment(b))?.(b.messages) ?? b.messages;
  }
  /** applyApiData's reasoning part: the GET's rows rebuilt + its open block.
   *  The GET first emits the lane's pending frame (S1 review §8): it reaches
   *  the browser ahead of the answer. */
  function snapshot(b: Browser, s: any, frames: any[]) {
    s.flushLiveBroadcasts();
    receive(b, frames.splice(0));
    const rebuilt = rebuildStateFromMessages(orderChronologically(rows()), 'active', 'codex').messages;
    b.messages = thinkingLaneSnapshot(b.lane, rebuilt, s.getStreamingThinking(), 0, maxRowId(rows()));
  }
  /** The GET's `maxMessageId` + its window's reasoning rows, as applyApiData passes them. */
  const maxRowId = (window: any[]) => Math.max(0, ...rows().map((r: any) => r.id), ...thinkingRowIds(window));
  /** Reasoning bubbles in order, any other message as one separator. */
  const view = (messages: Msg[]) => {
    const out: string[] = [];
    for (const m of messages) {
      if (m.role === 'thinking') out.push(m.content);
      else if (out.length && out[out.length - 1] !== '|') out.push('|');
    }
    while (out[out.length - 1] === '|') out.pop();
    return out;
  };
  const reload = () => view(rebuildStateFromMessages(orderChronologically(rows()), 'active', 'codex').messages);
  /** Every frame the stream(s) emit, in order. */
  function capture(...streams: any[]) {
    const frames: any[] = [];
    for (const s of streams) vi.spyOn(s, '_emitBroadcast').mockImplementation((e: any) => { frames.push(e); });
    return frames;
  }

  it.each([true, false])('a block, transparent events, a tool, a second block (commit per frame: %s)', (every) => {
    const s = mkStream();
    const frames = capture(s);
    send(s, [delta(10, 'Let '), ev('generation_progress', 11, { characters: 4 }), delta(12, 'me '),
      ev('usage', 13, { output_tokens: 2 }), delta(14, 'check'), toolUse(15),
      ev('tool_result', 16, { tool_use_id: 't15', content: 'ok', is_error: false }),
      delta(17, 'Done'), delta(18, '.'), ev('stop', 19, { subtype: 'success' })]);
    const b = browser();
    receive(b, frames, every);
    expect(view(b.messages)).toEqual(['Let me check', '|', 'Done.']);
    expect(view(b.messages)).toEqual(reload());
  });

  it('a block past 256 KiB (two adjacent rows) is one bubble live and reloaded', () => {
    const s = mkStream();
    const frames = capture(s);
    const chunk = 'x'.repeat(64 * 1024);
    send(s, [delta(1, chunk), delta(2, chunk), delta(3, chunk), delta(4, chunk), delta(5, 'tail'), toolUse(6)]);
    const b = browser();
    receive(b, frames);
    expect(view(b.messages)).toEqual([chunk.repeat(4) + 'tail']);
    expect(view(b.messages)).toEqual(reload());
  });

  it('a GET mid-block, then the rest of the block', () => {
    const s = mkStream();
    const frames = capture(s);
    send(s, [delta(10, 'Half '), delta(11, 'a ')]);
    const b = browser();
    receive(b, frames.splice(0));
    snapshot(b, s, frames);
    send(s, [delta(12, 'thought'), toolUse(13)]);
    receive(b, frames.splice(0));
    expect(view(b.messages)).toEqual(['Half a thought']);
    expect(view(b.messages)).toEqual(reload());
  });

  it('SIGTERM partial + restart replay + live continuation (with and without the reconnect GET)', () => {
    for (const withGet of [false, true]) {
      db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
      const s = mkStream();
      const frames = capture(s);
      send(s, [delta(10, 'Let '), delta(11, 'me '), delta(12, 'check')]);
      s.flushPendingAssistant();                                     // SIGTERM: 'Let me check'@10
      const b = browser();
      receive(b, frames.splice(0));
      const s2 = mkStream({ lastSeenSeq: 9 });
      const frames2 = capture(s2);
      if (withGet) snapshot(b, s2, frames2);
      replay(s2, [delta(10, 'Let '), delta(11, 'me '), delta(12, 'check'), delta(13, ' the')]);
      send(s2, [delta(14, ' file'), toolUse(15)]);
      receive(b, frames2);
      expect(view(b.messages)).toEqual(['Let me check the file']);
      expect(view(b.messages)).toEqual(reload());
    }
  });

  // Finding 6: the hub died without SIGTERM mid-block (no row); the restart
  // replay re-broadcasts the block this browser already shows.
  it('hard crash mid-block: the replayed block is not shown twice (with and without the reconnect GET)', () => {
    for (const withGet of [false, true]) {
      db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
      const s = mkStream();
      const frames = capture(s);
      send(s, [delta(10, 'Let '), delta(11, 'me '), delta(12, 'check')]);
      s._flushLiveBroadcast();                                       // the browser got them; then SIGKILL
      expect(s._durableCursor()).toBe(9);
      const b = browser();
      receive(b, frames.splice(0));
      const s2 = mkStream({ lastSeenSeq: s._durableCursor() });
      const frames2 = capture(s2);
      if (withGet) snapshot(b, s2, frames2);
      replay(s2, [delta(10, 'Let '), delta(11, 'me '), delta(12, 'check')]);
      send(s2, [delta(13, ' the file'), toolUse(14)]);
      receive(b, frames2);
      expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['Let me check the file', 10]]);
      expect(view(b.messages)).toEqual(['Let me check the file']);
      expect(view(b.messages)).toEqual(reload());
    }
  });

  // Step review 3: the SIGTERM handler's frames (the lane's last text, the
  // cut) never left the process; the browser kept the block as open text.
  it('SIGTERM whose cut never reached the browser: the restart re-cuts the persisted block (no GET applied, or a dropped one)', () => {
    for (const droppedGet of [false, true]) {
      db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
      const s = mkStream();
      const frames = capture(s);
      send(s, [delta(10, 'Let '), delta(11, 'me '), delta(12, 'check')]);
      s._flushLiveBroadcast();
      const b = browser();
      receive(b, frames.splice(0));                                  // the browser got the deltas…
      s.flushPendingAssistant();                                     // …never the SIGTERM flush's cut
      expect(frames.splice(0).map((f: any) => f.type)).toEqual(['thinking_flushed']);
      const s2 = mkStream({ lastSeenSeq: 9 });
      const frames2 = capture(s2);
      replay(s2, [delta(10, 'Let '), delta(11, 'me '), delta(12, 'check'), delta(13, ' the')]);
      if (droppedGet) s2.flushLiveBroadcasts();                      // a GET whose answer live frames made stale
      send(s2, [delta(14, ' file')]);
      s2._flushLiveBroadcast();
      receive(b, frames2.splice(0));
      expect(view(b.messages)).toEqual(['Let me check the file']);   // mid-block
      send(s2, [toolUse(15)]);
      receive(b, frames2.splice(0));
      expect(view(b.messages)).toEqual(['Let me check the file']);
      expect(view(b.messages)).toEqual(reload());
    }
  });

  it('hard crash mid-block: the replayed block is not shown twice BEFORE its cut either; an earlier block of the bubble stays', () => {
    const s = mkStream();
    const frames = capture(s);
    send(s, [delta(5, 'Plan. ')]);
    s.flushThinking();                                               // a hub writer's cut: 'Plan. '@5, same bubble
    send(s, [delta(10, 'Let '), delta(11, 'me '), delta(12, 'check')]);
    s._flushLiveBroadcast();                                         // the browser got them; then SIGKILL
    const b = browser();
    receive(b, frames.splice(0));
    expect(view(b.messages)).toEqual(['Plan. Let me check']);
    const s2 = mkStream({ lastSeenSeq: s._durableCursor() });
    const frames2 = capture(s2);
    replay(s2, [delta(10, 'Let '), delta(11, 'me '), delta(12, 'check')]);
    send(s2, [delta(13, ' the')]);
    s2._flushLiveBroadcast();
    receive(b, frames2.splice(0));
    expect(view(b.messages)).toEqual(['Plan. Let me check the']);
    send(s2, [delta(14, ' file'), toolUse(15)]);
    receive(b, frames2.splice(0));
    expect(view(b.messages)).toEqual(['Plan. Let me check the file']);
    expect(view(b.messages)).toEqual(reload());
  });

  // Final step review, finding 4: a hard crash whose persisted cursor sits
  // below an EARLIER persisted block. The restart re-cuts that block at its
  // anchor (content-less): it used to clear the lane's open text (the crashed
  // block), so the `thinking_reopened` that follows dropped nothing and the
  // replayed block was appended to the copy already on screen.
  it.each(['live only', 'GET mid-block before the crash', 'fresh view after the earlier cut'] as const)(
    'a restart re-cut of an EARLIER block leaves the open block to its reopen (%s)', (variant) => {
      const s = mkStream();
      const frames = capture(s);
      const b = browser();
      send(s, [delta(10, 'Plan '), delta(11, 'it. '), toolUse(12),
        ev('tool_result', 13, { tool_use_id: 't12', content: 'ok', is_error: false }),
        delta(14, 'Let '), delta(15, 'me ')]);
      if (variant === 'fresh view after the earlier cut') {
        frames.splice(0);                                            // this view mounts now: never saw A's cut
        snapshot(b, s, frames);
      } else {
        receive(b, frames.splice(0));
        if (variant === 'GET mid-block before the crash') snapshot(b, s, frames);
      }
      send(s, [delta(16, 'check')]);
      s._flushLiveBroadcast();                                       // the browser got them; then SIGKILL
      receive(b, frames.splice(0));
      expect(view(b.messages)).toEqual(['Plan it. ', '|', 'Let me check']);
      const s2 = mkStream({ lastSeenSeq: 9 });                       // the cursor never passed A
      const frames2 = capture(s2);
      replay(s2, [delta(10, 'Plan '), delta(11, 'it. '), toolUse(12),
        ev('tool_result', 13, { tool_use_id: 't12', content: 'ok', is_error: false }),
        delta(14, 'Let '), delta(15, 'me '), delta(16, 'check')]);
      expect(frames2.map((f: any) => f.type).slice(0, 2)).toEqual(['thinking_flushed', 'thinking_reopened']);
      send(s2, [delta(17, ' the file')]);
      s2._flushLiveBroadcast();
      receive(b, frames2.splice(0));
      expect(view(b.messages)).toEqual(['Plan it. ', '|', 'Let me check the file']);   // mid-block
      send(s2, [toolUse(18)]);
      receive(b, frames2.splice(0));
      expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['Plan it. ', 10], ['Let me check the file', 14]]);
      expect(view(b.messages)).toEqual(['Plan it. ', '|', 'Let me check the file']);
      expect(view(b.messages)).toEqual(reload());
    });

  it('a content-less cut of a row the lane never saw still cuts the open text (the lost-cut case)', () => {
    const lane = createThinkingLane();
    thinkingLaneDelta(lane, 'Let me check');
    let messages: Msg[] = thinkingLaneCommit(lane, { id: 'th1', createdAt: 0 })!([]);
    messages = thinkingLaneFlushed(lane, { rowId: 7 })(messages);
    expect(lane.open).toBe('');
    expect(messages).toMatchObject([{ id: 'm7', content: 'Let me check' }]);
    // The same re-cut again: known now, inert.
    thinkingLaneDelta(lane, 'Next');
    messages = thinkingLaneCommit(lane, { id: 'th2', createdAt: 0 })!(messages);
    const before = messages;
    expect(thinkingLaneFlushed(lane, { rowId: 7 })(messages)).toBe(before);
    expect(lane.open).toBe('Next');
    // With content it is a replay-rebuilt row: always applied.
    messages = thinkingLaneFlushed(lane, { rowId: 7, content: 'Next' })(messages);
    expect(lane.open).toBe('');
  });

  // Final review residual: a pinned restart cursor re-cuts rows far below the
  // window the view was seeded with. One monotonic id covers them all.
  it('a re-cut of a block OUTSIDE the view\'s window (pinned restart cursor) leaves the open block alone', () => {
    const s = mkStream();
    const frames = capture(s);
    const b = browser();
    const pairs = (from: number, n: number) => Array.from({ length: n }, (_, i) => [toolUse(from + 2 * i, `p${i}`),
      ev('tool_result', from + 2 * i + 1, { tool_use_id: `p${i}`, content: 'ok', is_error: false })]).flat();
    send(s, [delta(10, 'Old '), delta(11, 'block'), ...pairs(12, 101), delta(300, 'Let me check')]);
    frames.splice(0);
    // The view mounts now: its window (the newest 200 chat rows) misses A.
    s.flushLiveBroadcasts();
    const all = orderChronologically(rows());
    const window = all.slice(-200);
    expect(window.some(isThinkingRow)).toBe(false);
    const rebuilt = rebuildStateFromMessages(window, 'active', 'codex').messages;
    b.messages = thinkingLaneSnapshot(b.lane, rebuilt, s.getStreamingThinking(), 0, maxRowId(window));
    expect(view(b.messages)).toEqual(['Let me check']);
    // SIGKILL; the restart replays from a cursor pinned below A.
    const s2 = mkStream({ lastSeenSeq: 9 });
    const frames2 = capture(s2);
    replay(s2, [delta(10, 'Old '), delta(11, 'block'), ...pairs(12, 101), delta(300, 'Let me check')]);
    send(s2, [delta(301, ' the file'), toolUse(302)]);
    receive(b, frames2.splice(0));
    expect(view(b.messages)).toEqual(['Let me check the file']);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['Old block', 10], ['Let me check the file', 300]]);
  });

  it('the known row id is monotonic; non-reasoning and corrupt rows are not reasoning rows', () => {
    const lane = createThinkingLane();
    thinkingLaneSnapshot(lane, [], '', 0, 1000);
    thinkingLaneSnapshot(lane, [], '', 0, 400);                     // an older answer never lowers it
    expect(lane.known).toBe(1000);
    thinkingLaneFlushed(lane, { rowId: 5000 });
    expect(lane.known).toBe(5000);
    thinkingLaneDelta(lane, 'x');
    expect(thinkingLaneFlushed(lane, { rowId: 4999 })([])).toEqual([]);
    expect(lane.open).toBe('x');
    expect(thinkingRowIds([
      { id: 3, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'a' }) },
      { id: 1, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'b' }) },
      { id: 2, role: 'event', content: JSON.stringify({ type: 'bg_task', text: '"thinking"' }) },
      { id: 4, role: 'thinking', content: 'complete block' },
      { id: 5, role: 'event', content: '{"type":"thinking", broken' },
    ])).toEqual([1, 3]);
  });
});

describe('step review 3: the SIGTERM flush has time to reach the browsers', () => {
  it('the exit waits SHUTDOWN_DRAIN_MS; meanwhile no agent event is dispatched and no cursor is written', async () => {
    const ops = await import('@/lib/server/agent/sessionOps');
    const cursor = () => db.select({ c: schema.agentSessions.lastSeenSeq }).from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, SHUT_SID)).get().c;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const exit = vi.fn();
    const s = getOrCreateStream(SHUT_SID);
    try {
      const frames: any[] = [];
      vi.spyOn(s, '_emitBroadcast').mockImplementation((e: any) => { frames.push(e); });
      s._onAgentEvent(delta(10, 'Let ', SHUT_SID));
      s._onAgentEvent(delta(11, 'me', SHUT_SID));                    // the cursor's 2 s debounce is armed
      ops.gracefulShutdown('SIGTERM', exit);
      expect(exit).not.toHaveBeenCalled();                           // the frames below still have to leave
      expect(thinkingRows(SHUT_SID).map((r: any) => [r.text, r.seq])).toEqual([['Let me', 10]]);
      expect(frames.map((f) => f.type)).toEqual(['thinking', 'thinking_flushed']);
      s._onAgentEvent(delta(12, ' check', SHUT_SID));                // after the flush: left to the restart
      expect(s.getStreamingThinking()).toBe('');
      expect(frames).toHaveLength(2);
      vi.advanceTimersByTime(ops.SHUTDOWN_DRAIN_MS - 1);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(0);
      vi.advanceTimersByTime(5_000);                                 // the debounce fires: no cursor written
      expect(cursor()).toBeNull();
      ops.gracefulShutdown('SIGINT', exit);                          // a second signal exits at once
      expect(exit).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.__charon_shuttingDown = false;
      vi.useRealTimers();
      s.detach();
    }
  });
});

// Final step review, finding 1 (G2): a restart replay consuming a persisted
// row's cover has no block open, so nothing used to hold the durable cursor —
// the 2 s debounce persisted a seq strictly INSIDE the row, and the next
// restart replayed its tail with no row, cover or span of its own: a second
// row. The cover now holds the cursor at the row's anchor − 1.
describe('final review: a replay consuming a cover holds the durable cursor at the anchor', () => {
  const persistedCursor = (sid = SID) =>
    db.select().from(schema.agentSessions).all().find((r: any) => r.id === sid).lastSeenSeq;
  const words = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `w${from + i} `).join('');
  const deltas = (from: number, to: number, sid = SID) =>
    Array.from({ length: to - from + 1 }, (_, i) => delta(from + i, `w${from + i} `, sid));
  /** The process dies: its pending cursor debounce never runs. */
  const crash = (s: any) => {
    if (s.persistSeqTimer) clearTimeout(s.persistSeqTimer);
    s.persistSeqTimer = null;
    s.detach();
  };

  it('the debounce fires mid-cover: anchor − 1 is persisted, and a second restart writes the row once', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Process A: the block [10..20] and a tool call, persisted; the DB cursor
    // is still 9 (A died before its debounce ran).
    const a = mkStream({ lastSeenSeq: 9 });
    send(a, [...deltas(10, 20), toolUse(21)]);
    expect(thinkingRows().map((r: any) => [r.seq, r.text])).toEqual([[10, words(10, 20)]]);
    crash(a);
    db.update(schema.agentSessions).set({ lastSeenSeq: 9 }).where(eq(schema.agentSessions.id, SID)).run();
    // Process B replays from 9; the cover consumes 11.. and the debounce fires.
    const b = mkStream({ lastSeenSeq: 9 });
    b._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 12 });
    send(b, deltas(10, 15));
    expect(b.replayThinkingCover).toBe(words(16, 20));
    expect(b._durableCursor()).toBe(9);
    vi.advanceTimersByTime(2000);
    expect(persistedCursor()).toBe(9);                               // was 15: strictly inside the row
    // …B dies here. Process C replays from the persisted cursor.
    crash(b);
    const c = mkStream({ lastSeenSeq: persistedCursor() });
    replay(c, [...deltas(10, 20), toolUse(21)].filter((e: any) => e.seq > persistedCursor()));
    expect(thinkingRows().map((r: any) => [r.seq, r.text])).toEqual([[10, words(10, 20)]]);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking').map((m: any) => m.content)).toEqual([words(10, 20)]);
    // The cover ran out at 20: the hold is released, the cursor follows.
    expect(c._durableCursor()).toBe(21);
  });

  it('a carried cover (window cut mid-row) keeps holding until it runs out', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = mkStream({ lastSeenSeq: 9 });
    send(a, [...deltas(10, 20), toolUse(21)]);
    crash(a);
    const b = mkStream({ lastSeenSeq: 9 });
    b._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 12 });
    send(b, deltas(10, 13));
    b._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });   // the connection dropped
    vi.advanceTimersByTime(60_000);                                  // the reconnect backoff
    expect(b._durableCursor()).toBe(9);
    expect(persistedCursor()).toBeNull();                            // nothing past 9 was ever written
    replay(b, [...deltas(14, 20), toolUse(21)]);                     // resumed where it stopped
    expect(b.replayThinkingCover).toBeNull();
    expect(b._durableCursor()).toBe(21);
    expect(thinkingRows().map((r: any) => [r.seq, r.text])).toEqual([[10, words(10, 20)]]);
  });

  it('gracefulShutdown variant: the SIGTERM partial [10..15], a replay cut by a debounce, a third process', async () => {
    const ops = await import('@/lib/server/agent/sessionOps');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    db.update(schema.agentSessions).set({ lastSeenSeq: 9 }).where(eq(schema.agentSessions.id, SHUT_SID)).run();
    const exit = vi.fn();
    const s1 = getOrCreateStream(SHUT_SID);
    try {
      vi.spyOn(s1, '_emitBroadcast').mockImplementation(() => {});
      send(s1, deltas(10, 15, SHUT_SID));
      ops.gracefulShutdown('SIGTERM', exit);                          // writes the partial row, cursor stays 9
      vi.advanceTimersByTime(ops.SHUTDOWN_DRAIN_MS);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      globalThis.__charon_shuttingDown = false;
      crash(s1);
    }
    expect(thinkingRows(SHUT_SID).map((r: any) => [r.seq, r.text])).toEqual([[10, words(10, 15)]]);
    expect(persistedCursor(SHUT_SID)).toBe(9);
    // Process 2: replays 10..12 (the cover of the partial), the debounce fires.
    const s2 = mkStream({ id: SHUT_SID, lastSeenSeq: 9 });
    s2._onAgentEvent({ event: 'replay_begin', session_id: SHUT_SID, count: 12 });
    send(s2, deltas(10, 12, SHUT_SID));
    vi.advanceTimersByTime(2000);
    expect(persistedCursor(SHUT_SID)).toBe(9);                       // was 12
    crash(s2);
    // Process 3: from the persisted cursor; the partial is covered, the rest
    // becomes the adjacent row, rendered as the uninterrupted block.
    const s3 = mkStream({ id: SHUT_SID, lastSeenSeq: persistedCursor(SHUT_SID) });
    replay(s3, [...deltas(10, 20, SHUT_SID), toolUse(21, 't21', SHUT_SID)], SHUT_SID);
    expect(thinkingRows(SHUT_SID).map((r: any) => [r.seq, r.text])).toEqual([[10, words(10, 15)], [16, words(16, 20)]]);
    expect(rendered(SHUT_SID).filter((m: any) => m.role === 'thinking').map((m: any) => m.content))
      .toEqual([words(10, 20)]);
  });
});

describe('S1 final review: holdbacks inside a kept buffer, and an older boundary replayed over a live buffer', () => {
  const text = (seq: number, d: string) => ev('assistant_text', seq, { delta: d });
  const assistantRows = () => orderChronologically(rows()).filter((r: any) => r.role === 'assistant')
    .map((r: any) => [r.content, r.seq]);
  const questions = [{ question: 'Which colour?', options: [{ label: 'Orange' }] }];

  // Process 1 merges 'Hello world'@10 through ONE failed flush (at @11): the
  // `event` pin holds the cursor at 9. Process 2 replays inside that kept
  // buffer and loses a write there; it must not let the cursor reach 10.
  it.each(['sealed reasoning block', 'pending question insert'] as const)(
    'a write lost inside a replay-kept buffer holds its anchor: the next restart writes the row once (%s)', (variant) => {
      const boundary = variant === 'sealed reasoning block'
        ? delta(11, 'Hmm')
        : ev('user_question', 11, { id: 'q-kept', delivery: 'async', questions });
      const log = [text(10, 'Hello '), boundary, text(12, 'world'), toolUse(13), ev('stop', 14, { subtype: 'success' })];
      const s = mkStream();
      send(s, log.slice(0, 1));
      failMessageInserts = 1;
      send(s, log.slice(1));
      expect(assistantRows()).toEqual([['Hello world', 10]]);
      expect(s._durableCursor()).toBe(9);
      const s2 = mkStream({ lastSeenSeq: 9 });
      if (variant === 'sealed reasoning block') failMessageInserts = 100;
      else failPendingInserts = 1;
      replay(s2, log);
      failMessageInserts = 0;
      expect(s2._durableCursor()).toBe(9);                           // never strictly inside [10..12]
      const s3 = mkStream({ lastSeenSeq: s2._durableCursor() });
      replay(s3, log);
      expect(assistantRows()).toEqual([['Hello world', 10]]);
      if (variant === 'sealed reasoning block') {
        expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['Hmm', 11]]);
      } else {
        expect(rows().filter((r: any) => r.role === 'async_question').map((r: any) => r.seq)).toEqual([11]);
      }
    });

  it.each(['codex', 'claude'])('%s: an overlapping replay of an OLDER stop never cuts the live answer', (kind) => {
    const s = mkStream({ kind });
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    const stop = ev('stop', 87, { subtype: 'success' });
    const st1 = ev('status', 88, { status: 'thinking' });
    const st2 = ev('status', 89, { status: 'thinking' });
    send(s, [text(85, 'the'), text(86, 'x'), stop, st1, st2, text(90, 'ab')]);
    expect(assistantRows()).toEqual([['thex', 85]]);
    emitted.mockClear();
    // A resubscribe with cursor 86 re-delivers 87..90, cut after the stop.
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 4 });
    send(s, [stop, st1, st2]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
    expect(assistantRows()).toEqual([['thex', 85]]);                // no partial 'ab'@90
    expect(s.getStreamingText()).toBe('ab');
    expect(emitted.mock.calls.map(([e]: any[]) => e.type)).not.toContain('stop');
    expect(s._durableCursor()).toBe(89);                             // still held at the live buffer
    replay(s, [text(90, 'ab')]);
    send(s, [text(91, 'x'), text(92, 'the'), toolUse(93)]);
    expect(assistantRows()).toEqual([['thex', 85], ['abxthe', 90]]);
    // A restart from wherever the cursor stood writes nothing twice.
    const s2 = mkStream({ kind, lastSeenSeq: 89 });
    replay(s2, [text(90, 'ab'), text(91, 'x'), text(92, 'the'), toolUse(93)]);
    send(s2, [ev('stop', 94, { subtype: 'success' })]);
    expect(assistantRows()).toEqual([['thex', 85], ['abxthe', 90]]);
  });
});
