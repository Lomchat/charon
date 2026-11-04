import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// The window GET as a stamped snapshot (sync refonte C12, G5, I1/I2):
// `?conn=&focusSeq=` applies the SSE connection's focus INSIDE the GET
// (routing only), the lane coalescer is flushed before any read, and `sync`
// (read last, same tick) splits the world: every frame ≤ sync is reflected by
// the body, every frame > sync reaches the connection. `streamingToolOutput`
// mirrors the running tools' `tool_progress` (I6 `covered`).

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

const VPS_ID = 'focusvps';
const SID = 'f'.repeat(32);
const OTHER = 'c'.repeat(32);
const T0 = Date.now() - 3_600_000;

let db: any;
let schema: any;
let getOrCreateStream: any;
let conns: typeof import('@/lib/server/agent/eventConnections');
let bus: typeof import('@/lib/server/sync/syncBus');
let GET: typeof import('@/app/api/sessions/[id]/route').GET;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  for (const id of [SID, OTHER]) {
    db.insert(schema.agentSessions).values({ id, vpsId: VPS_ID, cwd: '/tmp', status: 'active' }).onConflictDoNothing().run();
  }
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ({ getOrCreateStream } = await import('@/lib/server/agent/sessionOps'));
  conns = await import('@/lib/server/agent/eventConnections');
  bus = await import('@/lib/server/sync/syncBus');
  ({ GET } = await import('@/app/api/sessions/[id]/route'));
});

const unregs: Array<() => void> = [];
afterEach(() => {
  for (const u of unregs.splice(0)) u();
  db.delete(schema.sessionMessages).run();
});

let seqN = 100;
function ev(event: string, extra: Record<string, unknown> = {}) {
  const seq = ++seqN;
  return { event, session_id: SID, seq, ts: (T0 + seq) / 1000, ...extra };
}

type Received = { rev: number; data: Record<string, any> };
/** A live raw connection (as the events route registers one) recording frames. */
function liveConn(connId: string, focus: string | null = OTHER) {
  const got: Received[] = [];
  const dec = new TextDecoder();
  unregs.push(conns.registerConnection({
    connId, initialFocus: focus, initialFocusSeq: 1,
    push: (chunk) => {
      const text = dec.decode(chunk);
      const id = /^id: \d+\.(\d+)$/m.exec(text);
      const data = /^data: (.*)$/m.exec(text);
      if (id && data) got.push({ rev: Number(id[1]), data: JSON.parse(data[1]) });
    },
  }));
  conns.markConnectionLive(connId);
  return got;
}

async function windowGet(query = '') {
  const res = await GET(new Request(`http://localhost/api/sessions/${SID}?open=1${query}`),
    { params: Promise.resolve({ id: SID }) });
  return res.json();
}

describe('atomic focus inside the window GET', () => {
  it('applies the focus (routing only), stamps sync; a frame before is in the snapshot, one after reaches the conn', async () => {
    const s = getOrCreateStream(SID);
    const got = liveConn('focus-conn-0001');
    // Before the GET: persisted row + its frame (this conn is focused elsewhere).
    s._onAgentEvent(ev('tool_use', { id: 'tu-before', name: 'Read', input: {} }));
    expect(got.some((f) => f.data.type === 'tool_use')).toBe(false);
    const body = await windowGet('&conn=focus-conn-0001&focusSeq=2');
    expect(body.focus).toEqual({ applied: true, focused: true, focusSeq: 2 });
    expect(body.sync).toEqual(bus.currentRev());
    expect(body.messages.some((m: any) => m.role === 'tool_use' && m.content.includes('tu-before'))).toBe(true);
    expect(conns.focusCountFor(SID)).toBe(1);
    // After: reaches the connection, rev > sync.
    s._onAgentEvent(ev('tool_use', { id: 'tu-after', name: 'Read', input: {} }));
    const after = got.find((f) => f.data.type === 'tool_use' && f.data.id === 'tu-after');
    expect(after).toBeDefined();
    expect(after!.rev).toBeGreaterThan(body.sync.rev);
    // Routing only: the GET is no presence report (no read-ack).
    const stale = await windowGet('&conn=focus-conn-0001&focusSeq=1');
    expect(stale.focus).toEqual({ applied: false, focused: true, focusSeq: 1 });
  });

  it('a stream superseding the conn keeps a NEWER focus the window GET applied to the old one (W2 review)', async () => {
    const s = getOrCreateStream(SID);
    liveConn('focus-conn-0005', OTHER);                       // the old stream (URL seq 1)
    const body = await windowGet('&conn=focus-conn-0005&focusSeq=2');
    expect(body.focus).toEqual({ applied: true, focused: true, focusSeq: 2 });
    const got = liveConn('focus-conn-0005', OTHER);           // the new stream, its URL still at seq 1
    expect(conns.connectionFocusOf('focus-conn-0005')).toBe(SID);
    s._onAgentEvent(ev('tool_use', { id: 'tu-superseded', name: 'Read', input: {} }));
    expect(got.some((f) => f.data.type === 'tool_use' && f.data.id === 'tu-superseded')).toBe(true);
    // A newer URL focus still wins over the old stream's.
    liveConn('focus-conn-0005', OTHER);
    unregs.push(conns.registerConnection({ connId: 'focus-conn-0005', initialFocus: OTHER, initialFocusSeq: 3 }));
    expect(conns.connectionFocusOf('focus-conn-0005')).toBe(OTHER);
  });

  it('an older focusSeq for another session never steals the focus; an unknown conn is not focused', async () => {
    liveConn('focus-conn-0002', OTHER);
    conns.setConnectionFocus('focus-conn-0002', OTHER, 5);
    const body = await windowGet('&conn=focus-conn-0002&focusSeq=4');
    expect(body.focus).toEqual({ applied: false, focused: false, focusSeq: 4 });
    expect(conns.focusCountFor(SID)).toBe(0);
    const unknown = await windowGet('&conn=focus-conn-none&focusSeq=9');
    expect(unknown.focus).toEqual({ applied: false, focused: false, focusSeq: 9 });
  });

  it('no conn ⇒ no focus field (still stamped); ?before= is lean + sync and applies no focus', async () => {
    liveConn('focus-conn-0003', OTHER);
    const body = await windowGet();
    expect(body).not.toHaveProperty('focus');
    expect(body.sync.epoch).toBe(bus.epoch());
    db.insert(schema.sessionMessages).values([
      { sessionId: SID, role: 'user', content: 'u1', tsMs: T0 + 1 },
      { sessionId: SID, role: 'user', content: 'u2', tsMs: T0 + 2 },
    ]).run();
    const win = await windowGet('&limit=1');
    const older = await windowGet(`&before=${win.oldestChatId}&limit=1&conn=focus-conn-0003&focusSeq=7`);
    expect(Object.keys(older).sort()).toEqual(['hasMore', 'messages', 'oldestChatId', 'sync']);
    expect(conns.focusCountFor(SID)).toBe(0);
  });
});

describe('coalesced text and the snapshot stamp', () => {
  it('text never sits both in streamingText and in a frame > sync', async () => {
    const s = getOrCreateStream(SID);
    const got = liveConn('focus-conn-0004', SID);
    s._onAgentEvent(ev('assistant_text', { delta: 'Hello ' }));
    s._onAgentEvent(ev('assistant_text', { delta: 'world' }));
    // Held by the 25 ms lane coalescer: no frame yet.
    expect(got.some((f) => f.data.type === 'assistant_text')).toBe(false);
    const body = await windowGet('&conn=focus-conn-0004&focusSeq=2');
    expect(body.streamingText).toBe('Hello world');
    // The GET flushed it BEFORE reading: its frame is ≤ sync (a client drops it).
    const early = got.filter((f) => f.data.type === 'assistant_text');
    expect(early.map((f) => f.data.delta).join('')).toBe('Hello world');
    expect(early.every((f) => f.rev <= body.sync.rev)).toBe(true);
    s._onAgentEvent(ev('assistant_text', { delta: '!' }));
    s.flushLiveBroadcasts();
    const later = got.filter((f) => f.data.type === 'assistant_text' && f.rev > body.sync.rev);
    expect(later.map((f) => f.data.delta)).toEqual(['!']);
    s._onAgentEvent(ev('tool_use', { id: 'tu-cut', name: 'Read', input: {} }));
  });
});

describe('delta GET (?since=) and the lane coalescer (W2 review)', () => {
  it('publishes the pending deltas\' frame before a ?since= response returns its streamingText', async () => {
    const s = getOrCreateStream(SID);
    const got = liveConn('focus-conn-0006', SID);
    s._onAgentEvent(ev('assistant_text', { delta: 'Hello ' }));
    s._onAgentEvent(ev('assistant_text', { delta: 'world' }));
    expect(got.some((f) => f.data.type === 'assistant_text')).toBe(false);
    const res = await GET(new Request(`http://localhost/api/sessions/${SID}?since=0`),
      { params: Promise.resolve({ id: SID }) });
    const body = await res.json();
    expect(body.streamingText).toBe('Hello world');
    // Already out as a frame: the client's revision guard sees it and drops the snapshot text.
    expect(got.filter((f) => f.data.type === 'assistant_text').map((f) => f.data.delta).join('')).toBe('Hello world');
    s.flushLiveBroadcasts();
    expect(got.filter((f) => f.data.type === 'assistant_text').map((f) => f.data.delta).join('')).toBe('Hello world');
    s._onAgentEvent(ev('tool_use', { id: 'tu-cut2', name: 'Read', input: {} }));
  });
});

describe('streamingToolOutput (I6 covered)', () => {
  it('mirrors tool_progress, tail-bounded per tool, and empties on tool_result', async () => {
    const s = getOrCreateStream(SID);
    s._onAgentEvent(ev('tool_use', { id: 'tu-run', name: 'Bash', input: { command: 'make' } }));
    s._onAgentEvent(ev('tool_progress', { tool_use_id: 'tu-run', delta: 'line 1\n' }));
    s._onAgentEvent(ev('tool_progress', { tool_use_id: 'tu-run', delta: 'line 2\n' }));
    let body = await windowGet();
    expect(body.streamingToolOutput).toEqual([{ toolUseId: 'tu-run', text: 'line 1\nline 2\n', truncated: false }]);

    // Tail bound: the last 64 KiB, flagged.
    s._onAgentEvent(ev('tool_progress', { tool_use_id: 'tu-run', delta: 'x'.repeat(70 * 1024) + 'END' }));
    body = await windowGet();
    const [out] = body.streamingToolOutput;
    expect(out.text.length).toBe(64 * 1024);
    expect(out.text.endsWith('END')).toBe(true);
    expect(out.truncated).toBe(true);

    s._onAgentEvent(ev('tool_result', { tool_use_id: 'tu-run', content: 'done', is_error: false }));
    body = await windowGet();
    expect(body.streamingToolOutput).toEqual([]);
  });

  it('keeps ≤ 8 tools (least recently updated evicted); stop clears', async () => {
    const s = getOrCreateStream(SID);
    for (let i = 0; i < 10; i++) s._onAgentEvent(ev('tool_progress', { tool_use_id: `t${i}`, delta: `o${i}` }));
    s._onAgentEvent(ev('tool_progress', { tool_use_id: 't2', delta: '+' }));
    const body = await windowGet();
    expect(body.streamingToolOutput.map((o: any) => o.toolUseId)).toEqual(['t3', 't4', 't5', 't6', 't7', 't8', 't9', 't2']);
    expect(body.streamingToolOutput.at(-1).text).toBe('o2+');
    s._onAgentEvent(ev('stop', { subtype: 'success' }));
    expect(s.getStreamingToolOutput()).toEqual([]);
    db.update(schema.agentSessions).set({ status: 'active', unreadStop: 0 }).where(eq(schema.agentSessions.id, SID)).run();
  });

  it('a non-live status clears it', () => {
    const s = getOrCreateStream(SID);
    s._onAgentEvent(ev('tool_progress', { tool_use_id: 'tz', delta: 'z' }));
    expect(s.getStreamingToolOutput()).toHaveLength(1);
    s._onAgentEvent(ev('status', { status: 'sleeping' }));
    expect(s.getStreamingToolOutput()).toEqual([]);
    s._onAgentEvent(ev('status', { status: 'active' }));
  });

  it('a hub-originated non-live status (failed force-stop, restart) clears it too (W2 review)', () => {
    const s = getOrCreateStream(SID);
    s._onAgentEvent(ev('tool_progress', { tool_use_id: 'tl', delta: 'partial' }));
    s.applyLocalStatus('active');
    expect(s.getStreamingToolOutput()).toHaveLength(1);
    s.applyLocalStatus('sleeping');
    expect(s.getStreamingToolOutput()).toEqual([]);
    s._onAgentEvent(ev('status', { status: 'active' }));
  });
});
