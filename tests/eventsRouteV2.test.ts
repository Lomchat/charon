import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The proto-2 SSE (sync refonte C12, CLAUDE.md §9): `since` (header beats
// query) ⇒ resume from the ring under the connection's CURRENT focus, else an
// EXPLICIT resync whose only id-carrying frame is `sync_snapshot_end` (E.R).
// One synchronous tick from registration to `live`; a failure closes the
// stream before its end frame and unregisters it.

const h = vi.hoisted(() => ({
  streams: new Map<string, { status: string; runningBgTaskCount(): number }>(),
  installs: [] as Array<{ id: string; vpsId: string; vpsName: string; status: string }>,
  summariesThrow: false,
  sweeps: 0,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  subscribeGlobalSessionEvents: () => () => {},
  setSessionFocusChecker: () => {},
  markSessionRead: () => {},
  peekStream: (id: string) => h.streams.get(id) ?? null,
  listStreams: () => [],
  sweepExpiredInteractions: () => { h.sweeps++; return 0; },
}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({ userId: 'test-user' })) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: vi.fn() }));
vi.mock('@/lib/server/install/installSession', () => ({
  subscribeInstallBus: () => () => {},
  listInstalls: () => h.installs,
}));
vi.mock('@/lib/server/sync/sessionSummaries', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/server/sync/sessionSummaries')>();
  return {
    ...real,
    reconcileAllSummaries: () => {
      if (h.summariesThrow) throw new Error('summary builder failed');
      return real.reconcileAllSummaries();
    },
  };
});

import { connectionFocusOf, focusCountFor, pushHeartbeatTo, setConnectionFocus } from '@/lib/server/agent/eventConnections';
import { currentRev, epoch, publish, syncStats } from '@/lib/server/sync/syncBus';

type RawFrame = { id: string | null; data: Record<string, any> };

let db: any;
let schema: any;
let GET: (req: Request) => Promise<Response>;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  ({ GET } = await import('@/app/api/events/route'));
});

beforeEach(() => {
  h.streams.clear();
  h.installs = [];
  h.summariesThrow = false;
  db.delete(schema.sessionPendingPermissions).run();
  db.delete(schema.sessionPendingQuestions).run();
  db.delete(schema.agentSessions).run();
  db.delete(schema.vps).run();
});

const open: Array<{ ac: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.ac.abort();
    await o.reader.cancel().catch(() => {});
  }
  vi.useRealTimers();
});

async function connect(conn: string, query = '', headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await GET(new Request(`http://localhost/api/events?conn=${conn}&proto=2${query}`, {
    signal: ac.signal, headers,
  }));
  const reader = res.body!.getReader();
  const entry = { ac, reader, res, buf: '', frames: [] as RawFrame[] };
  open.push(entry);
  return entry;
}

/** Read until `until(frames)` holds, or the stream ends. */
async function read(
  c: { reader: ReadableStreamDefaultReader<Uint8Array>; buf: string; frames: RawFrame[] },
  until: (frames: RawFrame[]) => boolean,
): Promise<{ frames: RawFrame[]; done: boolean }> {
  const dec = new TextDecoder();
  for (let i = 0; i < 2000; i++) {
    if (until(c.frames)) return { frames: c.frames, done: false };
    const next = await Promise.race([
      c.reader.read(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000)),
    ]);
    if (next === 'timeout') throw new Error(`SSE read timed out: ${JSON.stringify(c.frames.map((f) => f.data.type))}`);
    if (next.done) return { frames: c.frames, done: true };
    c.buf += dec.decode(next.value, { stream: true });
    let cut: number;
    while ((cut = c.buf.indexOf('\n\n')) >= 0) {
      const block = c.buf.slice(0, cut);
      c.buf = c.buf.slice(cut + 2);
      let id: string | null = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) id = line.slice(4);
        if (line.startsWith('data: ')) c.frames.push({ id, data: JSON.parse(line.slice(6)) });
      }
    }
  }
  throw new Error('too many chunks');
}

const type = (t: string) => (fs: RawFrame[]) => fs.some((f) => f.data.type === t);
const types = (fs: RawFrame[]) => fs.map((f) => f.data.type);
const revOf = (id: string | null) => (id ? Number(id.split('.')[1]) : null);
const sinceNow = () => `${epoch()}.${currentRev().rev}`;

describe('resync (first connect)', () => {
  it('hello → summaries → vps → installs → notices → E.R + snapshot_end, no id before it, then a heartbeat', async () => {
    db.insert(schema.vps).values({ id: 'vps-1', name: 'one', ip: '127.0.0.1', sshUser: 'root', agentStatus: 'ok', agentVersion: '0.103.0' }).run();
    db.insert(schema.agentSessions).values([
      { id: 'S-a', vpsId: 'vps-1', cwd: '/tmp', name: 'a', status: 'active', unreadStop: 1 },
      { id: 'S-arch', vpsId: 'vps-1', cwd: '/tmp', name: 'arch', status: 'sleeping', archived: 1 },
    ]).run();
    db.insert(schema.sessionPendingQuestions).values(
      { id: 'q-1', sessionId: 'S-a', kind: 'async_question', payload: '[]' },
    ).run();
    h.installs = [
      { id: 'i-run', vpsId: 'vps-1', vpsName: 'one', status: 'running' },
      { id: 'i-done', vpsId: 'vps-1', vpsName: 'one', status: 'done' },
    ];
    const resyncsBefore = syncStats().resyncs.first ?? 0;
    const c = await connect('v2-first-conn-1');
    const { frames } = await read(c, type('heartbeat'));
    expect(types(frames)).toEqual([
      'sync_hello', 'sync_summaries', 'sync_vps', 'sync_installs', 'model_notices', 'sync_snapshot_end', 'heartbeat',
    ]);
    const end = frames[5];
    const R = end.data.rev;
    expect(end.id).toBe(`${epoch()}.${R}`);
    expect(frames.slice(0, 5).every((f) => f.id === null)).toBe(true);
    expect(frames[0].data).toEqual({
      type: 'sync_hello', proto: 2, mode: 'resync', reason: 'first', epoch: epoch(), rev: R, buildId: expect.any(String),
    });
    expect(revOf(frames[6].id)!).toBeGreaterThanOrEqual(R);
    const sessions = frames[1].data.sessions;
    expect(sessions.map((s: any) => s.id)).toEqual(['S-a']);
    expect(sessions[0]).toMatchObject({ id: 'S-a', liveStatus: 'active', pendingAsync: 1, pendingBlocking: 0, attention: 'question' });
    expect(Array.isArray(sessions[0].gates)).toBe(true);
    expect(sessions[0]).not.toHaveProperty('providerConfig');
    expect(frames[2].data.vps).toEqual([expect.objectContaining({ id: 'vps-1', agentStatus: 'ok', agentVersion: '0.103.0' })]);
    expect(frames[2].data.vps[0]).not.toHaveProperty('ip');
    expect(frames[3].data.running).toEqual([{ installId: 'i-run', vpsId: 'vps-1', vpsName: 'one', status: 'running' }]);
    expect(h.sweeps).toBeGreaterThan(0);
    expect(syncStats().resyncs.first).toBe(resyncsBefore + 1);
    expect(focusCountFor('none')).toBe(0);
  });

  it('the snapshot reflects every frame ≤ R; a frame published after it arrives live with rev > R', async () => {
    db.insert(schema.vps).values({ id: 'vps-2', name: 'two', ip: '127.0.0.1', sshUser: 'root' }).run();
    db.insert(schema.agentSessions).values({ id: 'S-b', vpsId: 'vps-2', cwd: '/tmp', name: 'b', status: 'active' }).run();
    // Persist then publish (I1): the frame's rev is ≤ the snapshot's R.
    db.update(schema.agentSessions).set({ status: 'sleeping' }).run();
    const before = publish({ type: 'status', sessionId: 'S-b', status: 'sleeping' });
    const c = await connect('v2-first-conn-2', '&focus=S-b&focusSeq=1');
    await read(c, type('heartbeat'));
    const end = c.frames.find((f) => f.data.type === 'sync_snapshot_end')!;
    expect(end.data.rev).toBeGreaterThanOrEqual(before);
    expect(c.frames[1].data.sessions[0]).toMatchObject({ id: 'S-b', status: 'sleeping', liveStatus: 'sleeping' });
    // Nothing ≤ R is replayed on top of the snapshot.
    expect(c.frames.some((f) => f.data.type === 'status')).toBe(false);
    const after = publish({ type: 'assistant_text', sessionId: 'S-b', delta: 'live' });
    await read(c, (fs) => fs.some((f) => f.data.type === 'assistant_text'));
    const live = c.frames.find((f) => f.data.type === 'assistant_text')!;
    expect(live.id).toBe(`${epoch()}.${after}`);
    expect(after).toBeGreaterThan(end.data.rev);
  });

  it('a throwing summary builder closes the stream with no sync_snapshot_end and unregisters the conn', async () => {
    h.summariesThrow = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = await connect('v2-throw-conn-1', '&focus=S-t&focusSeq=1');
      const { frames, done } = await read(c, () => false);
      expect(done).toBe(true);
      expect(types(frames)).not.toContain('sync_snapshot_end');
      expect(types(frames)).not.toContain('heartbeat');
      expect(frames.every((f) => f.id === null)).toBe(true);
      expect(focusCountFor('S-t')).toBe(0);
      expect(pushHeartbeatTo('v2-throw-conn-1')).toBe(false);
      expect(warn.mock.calls.some((args) => String(args[0]).includes('[sync] snapshot error'))).toBe(true);
      expect(syncStats().closes['snapshot-error']).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resume', () => {
  it('returns exactly the frames > since that reach the CURRENT focus, then replay_end, then live', async () => {
    const first = await connect('v2-resume-conn-1', '&focus=S1&focusSeq=1');
    await read(first, type('heartbeat'));
    first.ac.abort();
    const since = sinceNow();
    const fromRev = currentRev().rev;
    const r1 = publish({ type: 'assistant_text', sessionId: 'S1', delta: 'old focus' });
    const r2 = publish({ type: 'assistant_text', sessionId: 'S2', delta: 'new focus' });
    const r3 = publish({ type: 'status', sessionId: 'S3', status: 'thinking' });            // low
    const r4 = publish({ type: 'tool_use', sessionId: 'S2', id: 't', name: 'Read', input: {} });
    expect([r1, r2, r3, r4]).toEqual([fromRev + 1, fromRev + 2, fromRev + 3, fromRev + 4]);
    const resumesBefore = syncStats().resumes;

    // Reconnect focused on S2: S1's frame is not owed to it.
    const c = await connect('v2-resume-conn-1', `&focus=S2&focusSeq=2&since=${since}`);
    await read(c, type('heartbeat'));
    expect(types(c.frames)).toEqual(['sync_hello', 'assistant_text', 'status', 'tool_use', 'sync_replay_end', 'heartbeat']);
    expect(c.frames[0].data).toEqual({
      type: 'sync_hello', proto: 2, mode: 'resume', epoch: epoch(), rev: r4, from: fromRev, buildId: expect.any(String),
    });
    expect(c.frames[0].id).toBeNull();
    expect(c.frames.slice(1, 4).map((f) => f.id)).toEqual([r2, r3, r4].map((r) => `${epoch()}.${r}`));
    expect(c.frames[1].data.delta).toBe('new focus');
    expect(c.frames[4]).toEqual({ id: null, data: { type: 'sync_replay_end', rev: r4 } });
    expect(revOf(c.frames[5].id)).toBe(r4);
    expect(syncStats().resumes).toBe(resumesBefore + 1);

    const r5 = publish({ type: 'assistant_text', sessionId: 'S2', delta: 'after' });
    await read(c, (fs) => fs.some((f) => f.data.delta === 'after'));
    expect(c.frames[c.frames.length - 1].id).toBe(`${epoch()}.${r5}`);
  });

  it('superseding a conn that took a NEWER focus: the stream inherits it and resumes under it (W2 review)', async () => {
    const first = await connect('v2-resume-conn-sup', '&focus=S1&focusSeq=1');
    await read(first, type('heartbeat'));
    const since = sinceNow();
    // The window GET for S2 lands on the OLD (still registered) conn first.
    expect(setConnectionFocus('v2-resume-conn-sup', 'S2', 2, true, { routingOnly: true }).applied).toBe(true);
    publish({ type: 'assistant_text', sessionId: 'S1', delta: 'stale focus' });
    publish({ type: 'assistant_text', sessionId: 'S2', delta: 'owed to S2' });
    // The new stream's URL still says S1/1.
    const c = await connect('v2-resume-conn-sup', `&focus=S1&focusSeq=1&since=${since}`);
    await read(c, type('heartbeat'));
    expect(connectionFocusOf('v2-resume-conn-sup')).toBe('S2');
    const deltas = c.frames.filter((f) => f.data.type === 'assistant_text').map((f) => f.data.delta);
    expect(deltas).toEqual(['owed to S2']);
  });

  it('the Last-Event-ID header beats the query', async () => {
    const since = sinceNow();
    const r = publish({ type: 'status', sessionId: 'S9', status: 'active' });
    const c = await connect('v2-header-conn-1', `&since=1.1`, { 'last-event-id': since });
    await read(c, type('heartbeat'));
    expect(c.frames[0].data).toMatchObject({ type: 'sync_hello', mode: 'resume', from: Number(since.split('.')[1]) });
    expect(c.frames.find((f) => f.data.type === 'status')!.id).toBe(`${epoch()}.${r}`);
    // And a bad header falls back to the query.
    const d = await connect('v2-header-conn-2', `&since=${since}`, { 'last-event-id': 'garbage' });
    await read(d, type('heartbeat'));
    expect(d.frames[0].data).toMatchObject({ mode: 'resume' });
  });

  it('since === now resumes with nothing to replay', async () => {
    const c = await connect('v2-now-conn-1', `&since=${sinceNow()}`);
    await read(c, type('heartbeat'));
    expect(types(c.frames)).toEqual(['sync_hello', 'sync_replay_end', 'heartbeat']);
  });
});

describe('explicit resync reasons', () => {
  async function helloOf(conn: string, query: string) {
    const c = await connect(conn, query);
    await read(c, type('heartbeat'));
    const end = c.frames.findIndex((f) => f.data.type === 'sync_snapshot_end');
    expect(end).toBeGreaterThan(0);
    // No id on any frame before the end frame.
    expect(c.frames.slice(0, end).every((f) => f.id === null)).toBe(true);
    expect(c.frames[end].id).toBe(`${epoch()}.${c.frames[end].data.rev}`);
    return c.frames[0].data;
  }

  it('foreign epoch', async () => {
    expect(await helloOf('v2-epoch-conn-1', `&since=${epoch() - 1}.5`)).toMatchObject({ mode: 'resync', reason: 'epoch' });
  });

  it('future rev', async () => {
    expect(await helloOf('v2-future-conn-1', `&since=${epoch()}.${currentRev().rev + 10}`))
      .toMatchObject({ mode: 'resync', reason: 'future' });
  });

  it('cap: the owed frames exceed RESUME_MAX_BYTES (another focus resumes)', async () => {
    const since = sinceNow();
    const big = 'z'.repeat(250 << 10);       // under the 256 KiB ring stub threshold
    for (let i = 0; i < 70; i++) publish({ type: 'assistant_text', sessionId: 'S-cap', delta: big });
    expect(await helloOf('v2-cap-conn-1', `&focus=S-cap&focusSeq=1&since=${since}`))
      .toMatchObject({ mode: 'resync', reason: 'cap' });
    const other = await connect('v2-cap-conn-2', `&focus=S-other&focusSeq=1&since=${since}`);
    await read(other, type('heartbeat'));
    expect(other.frames[0].data).toMatchObject({ mode: 'resume' });
  });

  it('gap: the ring no longer holds since+1', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const since = sinceNow();
    publish({ type: 'status', sessionId: 'S-gap', status: 'active' });
    vi.setSystemTime(Date.now() + 16 * 60_000);           // past RING_MAX_AGE_MS
    publish({ type: 'status', sessionId: 'S-gap', status: 'thinking' });
    expect(await helloOf('v2-gap-conn-1', `&since=${since}`)).toMatchObject({ mode: 'resync', reason: 'gap' });
  });

  it('no proto=2 ⇒ the legacy body (no sync_hello)', async () => {
    const ac = new AbortController();
    const res = await GET(new Request('http://localhost/api/events?conn=v2-legacy-conn-1&since=1.1', { signal: ac.signal }));
    const c = { reader: res.body!.getReader(), buf: '', frames: [] as RawFrame[] };
    open.push({ ac, reader: c.reader });
    await read(c, type('heartbeat'));
    expect(types(c.frames)).not.toContain('sync_hello');
    expect(types(c.frames)).toContain('pending_snapshot');
  });
});

describe('heartbeats come from the registry', () => {
  it('an unregistered conn gets none; a live one gets id E.<currentRev>', async () => {
    expect(pushHeartbeatTo('v2-nobody-conn')).toBe(false);
    const c = await connect('v2-hb-conn-1');
    await read(c, type('heartbeat'));
    const n = c.frames.length;
    const r = publish({ type: 'status', sessionId: 'S-hb', status: 'active' });
    expect(pushHeartbeatTo('v2-hb-conn-1')).toBe(true);
    await read(c, (fs) => fs.length >= n + 2);
    expect(c.frames[n + 1]).toMatchObject({ id: `${epoch()}.${r}`, data: { type: 'heartbeat' } });
    c.ac.abort();
    expect(pushHeartbeatTo('v2-hb-conn-1')).toBe(false);
  });
});
