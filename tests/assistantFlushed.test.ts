import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// The hub cuts assistant bubbles (sync refonte C08, I7): every event of
// `ASSISTANT_FLUSH_EVENTS` (lib/assistantBoundaries.ts) flushes the open
// `assistant_text` buffer into its row and announces it as ONE
// `assistant_flushed{rowId,length,tsMs,model}` — after the buffer's last
// coalesced delta, before the boundary's own frame. A failed flush announces
// nothing; a replayed boundary that proves the text persisted announces
// `duplicate:true`. Harness: a real migrated SQLite DB (hermetic), the
// SessionStream driven through `_onAgentEvent`, frames read off
// `_emitBroadcast`, message-row inserts failed on demand.

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

const VPS_ID = 'flushvps';
const SID = 'f'.repeat(32);
const T0 = Date.now() - 3_600_000;   // agent event clock: an hour ago

let db: any;
let schema: any;
let SessionStream: any;
let ASSISTANT_FLUSH_EVENTS: readonly string[];
let failMessageInserts = 0;

function mkStream(kind = 'claude', lastSeenSeq: number | null = null) {
  return new SessionStream({
    id: SID, vpsId: VPS_ID, vpsName: 'test', name: null,
    status: 'active', permissionMode: 'normal', nativeSessionId: null,
    kind, lastSeenSeq,
  }) as any;
}

/** Agent event with the agent's `ts` (unix SECONDS) = T0 + seq ms. */
function ev(event: string, seq: number | null, extra: Record<string, unknown> = {}) {
  return { event, session_id: SID, ...(seq != null ? { seq, ts: (T0 + seq) / 1000 } : {}), ...extra };
}
const text = (seq: number | null, delta: string) => ev('assistant_text', seq, { delta });

function send(s: any, events: any[]) {
  for (const e of events) s._onAgentEvent(e);
}

function replay(s: any, events: any[]) {
  s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: events.length });
  send(s, events);
  s._onAgentEvent({ event: 'replay_end', session_id: SID });
}

function rows(role?: string) {
  return db.select().from(schema.sessionMessages).all()
    .filter((r: any) => r.sessionId === SID && (role == null || r.role === role))
    .sort((a: any, b: any) => a.id - b.id);
}

function spyFrames(s: any) {
  const spy = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
  return () => spy.mock.calls.map(([f]: any[]) => f);
}

/** One boundary event per type, at `seq` (its own frame type, when it has one). */
function boundary(type: string, seq: number): { event: any; frame: string | null } {
  switch (type) {
    case 'structured_output': return { event: ev(type, seq, { value: { ok: true } }), frame: type };
    case 'thinking': return { event: ev(type, seq, { text: 'A complete block.' }), frame: type };
    case 'tool_use': return { event: ev(type, seq, { id: `t${seq}`, name: 'Read', input: { file_path: '/x' } }), frame: type };
    case 'permission_request':
      return { event: ev(type, seq, { id: `p${seq}`, tool: 'Read', input: {}, expires_at: Math.floor(Date.now() / 1000) + 600 }), frame: type };
    case 'user_question':
      return { event: ev(type, seq, { id: `q${seq}`, questions: [{ question: 'Which?', options: [{ label: 'A' }] }] }), frame: type };
    case 'exit_plan_request': return { event: ev(type, seq, { id: `x${seq}`, plan: 'the plan' }), frame: type };
    case 'stop': return { event: ev(type, seq, { subtype: 'success' }), frame: type };
    case 'compaction': return { event: ev(type, seq, { trigger: 'auto', pre_tokens: 10, post_tokens: 2 }), frame: type };
    case 'external_message': return { event: ev(type, seq, { origin: 'peer', text: 'hello', message_id: 'pm1', from: '@a' }), frame: type };
    case 'peer_message_status':
      return { event: ev(type, seq, { message_id: 'pm2', conversation_id: 'c1', status: 'accepted' }), frame: type };
    case 'plan_update': return { event: ev(type, seq, { id: 'plan1', steps: [{ step: 'one', status: 'pending' }] }), frame: type };
    case 'plan_progress': return { event: ev(type, seq, { id: 'plan1', text: '1. one' }), frame: type };
    default: throw new Error(`no fixture for ${type}`);
  }
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  db.insert(schema.agentSessions).values({ id: SID, vpsId: VPS_ID, cwd: '/tmp', status: 'active' })
    .onConflictDoNothing().run();
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

  ({ SessionStream } = await import('@/lib/server/agent/sessionOps'));
  ({ ASSISTANT_FLUSH_EVENTS } = await import('@/lib/assistantBoundaries'));
});

beforeEach(() => {
  pool.client.call = async () => ({ ok: true });
});

afterEach(() => {
  failMessageInserts = 0;
  db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
  db.delete(schema.sessionPendingQuestions).run();
  db.delete(schema.sessionPendingPermissions).run();
  db.update(schema.agentSessions).set({
    lastSeenSeq: null, pendingAssistantMessageId: null, lastStopNotifiedSeq: null, effectiveModel: null,
  }).run();
});

describe('assistant_flushed at every hub boundary', () => {
  it('the list is the client legacy list plus the five new hub boundaries', async () => {
    const { isAssistantFlushEvent } = await import('@/lib/assistantBoundaries');
    expect([...ASSISTANT_FLUSH_EVENTS].sort()).toEqual([
      'compaction', 'exit_plan_request', 'external_message', 'peer_message_status', 'permission_request',
      'plan_progress', 'plan_update', 'stop', 'structured_output', 'thinking', 'tool_use', 'user_question',
    ]);
    expect(isAssistantFlushEvent('tool_use')).toBe(true);
    expect(isAssistantFlushEvent('tool_result')).toBe(false);
    expect(isAssistantFlushEvent('effective_model')).toBe(false);   // on CHANGE only
  });

  it.each([
    'structured_output', 'thinking', 'tool_use', 'permission_request', 'user_question', 'exit_plan_request',
    'stop', 'compaction', 'external_message', 'peer_message_status', 'plan_update', 'plan_progress',
  ])('%s: ONE assistant_flushed naming the row, after the text and before its own frame', (type) => {
    const s = mkStream();
    s.effectiveModel = 'claude-x';
    const frames = spyFrames(s);
    const { event, frame } = boundary(type, 3);
    send(s, [text(1, 'Hello '), text(2, 'world'), event]);
    const all = frames();
    const flushed = all.filter((f: any) => f.type === 'assistant_flushed');
    expect(flushed).toHaveLength(1);
    const [row] = rows('assistant');
    expect(row.content).toBe('Hello world');
    expect(flushed[0]).toEqual({
      type: 'assistant_flushed', rowId: row.id, length: 11, tsMs: T0 + 1, model: 'claude-x',
    });
    const at = all.indexOf(flushed[0]);
    // After the coalesced text frame …
    expect(all.findLastIndex((f: any) => f.type === 'assistant_text')).toBeLessThan(at);
    expect(all.filter((f: any) => f.type === 'assistant_text').map((f: any) => f.delta).join('')).toBe('Hello world');
    // … and before the boundary's own frame.
    if (frame) expect(all.findIndex((f: any) => f.type === frame)).toBeGreaterThan(at);
  });

  it('a delta provider\'s reasoning delta cuts the text before its block opens', () => {
    const s = mkStream('codex');
    const frames = spyFrames(s);
    send(s, [text(1, 'Answer so far'), ev('thinking', 2, { text: 'more reasoning' }), ev('tool_use', 3, { id: 't', name: 'Read', input: {} })]);
    const types = frames().map((f: any) => f.type);
    expect(types.indexOf('assistant_flushed')).toBe(1);
    expect(types.filter((t: string) => t === 'assistant_flushed')).toHaveLength(1);
    expect(types.indexOf('thinking')).toBeGreaterThan(1);
  });

  it('an effective_model CHANGE is a boundary, null → X included; the same model is not', () => {
    const s = mkStream();
    const frames = spyFrames(s);
    send(s, [text(1, 'old model text'), ev('effective_model', 2, { model: 'claude-a' })]);
    expect(frames().map((f: any) => f.type)).toEqual(['assistant_text', 'assistant_flushed', 'effective_model']);
    expect(frames()[1]).toMatchObject({ rowId: rows('assistant')[0].id, model: null });
    send(s, [text(3, 'more'), ev('effective_model', 4, { model: 'claude-a' })]);
    expect(frames().filter((f: any) => f.type === 'assistant_flushed')).toHaveLength(1);
  });

  it('stop{finalAssistantId} is the id the last assistant_flushed named', () => {
    const s = mkStream();
    const frames = spyFrames(s);
    send(s, [text(1, 'First.'), boundary('tool_use', 2).event,
      ev('tool_result', 3, { tool_use_id: 't2', content: 'ok', is_error: false }),
      text(4, 'Second.'), ev('stop', 5, { subtype: 'success' })]);
    const flushed = frames().filter((f: any) => f.type === 'assistant_flushed');
    expect(flushed.map((f: any) => f.length)).toEqual([6, 7]);
    const stop = frames().find((f: any) => f.type === 'stop');
    expect(stop.finalAssistantId).toBe(flushed[1].rowId);
    expect(rows('assistant').map((r: any) => [r.id, r.assistantFinal])).toEqual([[flushed[0].rowId, 0], [flushed[1].rowId, 1]]);
  });

  it('nothing to flush ⇒ nothing announced', () => {
    const s = mkStream();
    const frames = spyFrames(s);
    send(s, [boundary('tool_use', 1).event, boundary('compaction', 2).event]);
    expect(frames().some((f: any) => f.type === 'assistant_flushed')).toBe(false);
  });

  it('a failed flush announces nothing; the retry announces the whole text once', () => {
    const s = mkStream();
    const frames = spyFrames(s);
    send(s, [text(1, 'Hello ')]);
    failMessageInserts = 1;
    send(s, [boundary('compaction', 2).event]);
    expect(frames().some((f: any) => f.type === 'assistant_flushed')).toBe(false);
    expect(frames().some((f: any) => f.type === 'compaction')).toBe(false);   // order-preserving stop
    send(s, [text(3, 'world'), boundary('tool_use', 4).event]);
    const flushed = frames().filter((f: any) => f.type === 'assistant_flushed');
    expect(flushed).toEqual([{ type: 'assistant_flushed', rowId: rows('assistant')[0].id, length: 11, tsMs: T0 + 1, model: null }]);
  });

  it('a replay-gated boundary drops a persisted buffer as duplicate:true (no text re-sent)', () => {
    const live = mkStream();
    send(live, [text(1, 'Hello '), text(2, 'world'), boundary('tool_use', 3).event]);
    const [row] = rows('assistant');
    const s = mkStream('claude', 0);
    const frames = spyFrames(s);
    replay(s, [text(1, 'Hello '), text(2, 'world'), boundary('tool_use', 3).event]);
    expect(frames().filter((f: any) => f.type === 'assistant_text')).toEqual([]);
    expect(frames().filter((f: any) => f.type === 'assistant_flushed')).toEqual([{
      type: 'assistant_flushed', rowId: row.id, length: 11, tsMs: T0 + 1, model: null, duplicate: true, replay: true,
    }]);
    expect(rows('assistant')).toHaveLength(1);
  });

  it('every gated boundary of the new five drops a persisted buffer the same way', () => {
    for (const type of ['compaction', 'external_message', 'peer_message_status', 'plan_update']) {
      const live = mkStream();
      send(live, [text(1, 'Before it.'), boundary(type, 2).event]);
      const [row] = rows('assistant');
      const s = mkStream('claude', 0);
      const frames = spyFrames(s);
      replay(s, [text(1, 'Before it.'), boundary(type, 2).event]);
      expect(frames().filter((f: any) => f.type === 'assistant_flushed').map((f: any) => [f.rowId, f.duplicate]))
        .toEqual([[row.id, true]]);
      expect(rows('assistant')).toHaveLength(1);
      db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
    }
  });

  it('the legacy content path (seq-less agent) announces rowId null + duplicate, or the extended row', () => {
    db.insert(schema.sessionMessages).values({ sessionId: SID, role: 'assistant', content: 'Done.', tsMs: T0 }).run();
    const s = mkStream();
    const frames = spyFrames(s);
    replay(s, [text(null, 'Done.'), ev('tool_use', null, { id: 'legacy', name: 'Read', input: {} })]);
    expect(frames().filter((f: any) => f.type === 'assistant_flushed')).toEqual([
      expect.objectContaining({ rowId: null, length: 5, duplicate: true }),
    ]);
    db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
    const partial = Number(db.insert(schema.sessionMessages).values({ sessionId: SID, role: 'assistant', content: 'Hel', tsMs: T0 }).run().lastInsertRowid);
    const s2 = mkStream();
    const frames2 = spyFrames(s2);
    replay(s2, [text(null, 'Hello'), ev('tool_use', null, { id: 'legacy2', name: 'Read', input: {} })]);
    expect(frames2().filter((f: any) => f.type === 'assistant_flushed')).toEqual([
      expect.objectContaining({ rowId: partial, length: 5, content: 'Hello' }),
    ]);
    expect(rows('assistant').map((r: any) => r.content)).toEqual(['Hello']);
  });
});
