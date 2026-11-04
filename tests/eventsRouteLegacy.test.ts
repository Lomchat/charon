import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The LEGACY SSE body (no `proto=2`): `lib/server/sync/legacyEvents.ts`, today's
// connect snapshot verbatim (statuses, unread + bg counts, pendings, ONE
// `pending_snapshot`, installs, derived VPS keys) written into the pull-driven
// outbox, then live bus frames once the route marked the connection live.
// The golden test was written against the route BEFORE the C12 refactor and
// must pass unchanged after it. The other tests are C05's legacy-route tests
// (ported from eventConnectionsIdentity.test.ts).

const bus = vi.hoisted(() => {
  const subs = new Set<(ev: any) => void>();
  return {
    subs,
    markSessionRead: vi.fn(),
    streams: new Map<string, { status: string; runningBgTaskCount(): number }>(),
    noticesThrow: false,
    installs: [] as Array<{ id: string; vpsId: string; vpsName: string; status: string }>,
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  subscribeGlobalSessionEvents: (cb: (ev: any) => void) => {
    bus.subs.add(cb);
    return () => { bus.subs.delete(cb); };
  },
  setSessionFocusChecker: () => {},
  markSessionRead: bus.markSessionRead,
  peekStream: (id: string) => bus.streams.get(id) ?? null,
  sweepExpiredInteractions: () => 0,
}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({ userId: 'test-user' })) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: vi.fn() }));
vi.mock('@/lib/server/install/installSession', () => ({
  subscribeInstallBus: () => () => {},
  listInstalls: () => bus.installs,
}));
vi.mock('@/lib/server/hub/modelNotices', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/server/hub/modelNotices')>();
  return {
    ...real,
    getModelNotices: () => {
      if (bus.noticesThrow) throw new Error('notices read failed');
      return real.getModelNotices();
    },
  };
});

import { focusCountFor, isBeingWatched } from '@/lib/server/agent/eventConnections';
import { currentRev, publish } from '@/lib/server/sync/syncBus';

type Frame = Record<string, any>;
type RawFrame = { id: string | null; data: Frame };

/** Read an SSE body until `until(frames)` holds (or the stream ends). */
async function readRaw(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (frames: RawFrame[]) => boolean,
): Promise<{ frames: RawFrame[]; done: boolean }> {
  const decoder = new TextDecoder();
  let buf = '';
  const frames: RawFrame[] = [];
  for (let i = 0; i < 400; i++) {
    const next = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);
    if (next === 'timeout') throw new Error(`SSE read timed out after ${frames.length} frames`);
    if (next.done) return { frames, done: true };
    buf += decoder.decode(next.value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let id: string | null = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) id = line.slice(4);
        if (line.startsWith('data: ')) frames.push({ id, data: JSON.parse(line.slice(6)) });
      }
    }
    if (until(frames)) return { frames, done: false };
  }
  throw new Error('SSE read: too many chunks');
}

async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (frames: Frame[]) => boolean,
): Promise<{ frames: Frame[]; done: boolean }> {
  const r = await readRaw(reader, (raw) => until(raw.map((f) => f.data)));
  return { frames: r.frames.map((f) => f.data), done: r.done };
}

const hasHeartbeat = (frames: Frame[]) => frames.some((f) => f.type === 'heartbeat');

describe('GET /api/events (legacy body)', () => {
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
    bus.streams.clear();
    db.delete(schema.sessionPendingPermissions).run();
    db.delete(schema.sessionPendingQuestions).run();
    db.delete(schema.agentSessions).run();
    db.delete(schema.vps).run();
  });

  const open = (conn: string, extra = '') => {
    const ac = new AbortController();
    const res = GET(new Request(`http://localhost/api/events?conn=${conn}&focus=S1&focusSeq=1${extra}`, {
      signal: ac.signal,
    }));
    return { ac, res };
  };

  it('golden: the legacy connect snapshot, frame by frame (no ids), then a heartbeat stamped E.R', async () => {
    db.insert(schema.vps).values([
      { id: 'vps-g1', name: 'g1', ip: '127.0.0.1', sshUser: 'root', agentStatus: 'ok', agentVersion: '0.103.0',
        agentPyzSha: 'abc', cursorAvailable: 1, codexLoggedIn: 1 },
    ]).run();
    const session = (id: string, createdAt: number, extra: Record<string, unknown>) => db.insert(schema.agentSessions)
      .values({ id, vpsId: 'vps-g1', cwd: '/tmp', name: id, status: 'active', createdAt, ...extra }).run();
    session('G-a', 1, { unreadStop: 1 });
    session('G-b', 2, { status: 'sleeping' });
    session('G-c', 3, { status: 'background' });
    session('G-arch', 4, { archived: 1, unreadStop: 1 });
    bus.streams.set('G-c', { status: 'background', runningBgTaskCount: () => 1 });
    db.insert(schema.sessionPendingPermissions).values([
      { id: 'gp-1', sessionId: 'G-a', toolName: 'Bash', toolInput: '{"command":"ls"}', expiresAt: 4_000_000_000 },
    ]).run();
    db.insert(schema.sessionPendingQuestions).values([
      { id: 'gq-1', sessionId: 'G-a', kind: 'question', payload: '[{"question":"go?","options":[]}]', createdAt: 100 },
      { id: 'gq-2', sessionId: 'G-c', kind: 'async_question', payload: '[{"question":"later?","options":[]}]', createdAt: 101 },
      { id: 'gx-1', sessionId: 'G-b', kind: 'exit_plan', payload: '{"plan":"the plan"}', createdAt: 102 },
    ]).run();
    bus.installs = [
      { id: 'inst-1', vpsId: 'vps-g1', vpsName: 'g1', status: 'running' },
      { id: 'inst-2', vpsId: 'vps-g1', vpsName: 'g1', status: 'done' },
    ];
    try {
      const { ac, res } = open('route-golden-conn');
      const reader = (await res).body!.getReader();
      const { frames } = await readRaw(reader, (fs) => fs.some((f) => f.data.type === 'heartbeat'));
      const hb = frames.findIndex((f) => f.data.type === 'heartbeat');
      expect(hb).toBe(frames.length - 1);
      const { epoch, rev } = currentRev();
      expect(frames[hb].id).toBe(`${epoch}.${rev}`);
      const snap = frames.slice(0, hb);
      expect(snap.every((f) => f.id === null)).toBe(true);
      const data = snap.map((f) => f.data);
      expect(data[0]).toMatchObject({ type: 'model_notices' });
      expect(data.slice(1)).toEqual([
        {
          type: 'vps_status', sessionId: 'vps-g1', agentStatus: 'ok',
          ...Object.fromEntries(Object.entries(data[1]).filter(([k]) => !['type', 'sessionId', 'agentStatus'].includes(k))),
        },
        { type: 'status', sessionId: 'G-a', status: 'active' },
        { type: 'status', sessionId: 'G-b', status: 'sleeping' },
        { type: 'status', sessionId: 'G-c', status: 'background' },
        { type: 'session_unread', sessionId: 'G-a', unread: true },
        { type: 'session_bg_tasks', sessionId: 'G-c', running: 1 },
        { type: 'permission_request', sessionId: 'G-a', id: 'gp-1', tool: 'Bash', input: { command: 'ls' }, expiresAt: 4_000_000_000 },
        { type: 'user_question', sessionId: 'G-a', id: 'gq-1', questions: [{ question: 'go?', options: [] }], createdAt: 100, snapshot: true },
        { type: 'user_question', sessionId: 'G-c', id: 'gq-2', questions: [{ question: 'later?', options: [] }], delivery: 'async', createdAt: 101, snapshot: true },
        { type: 'exit_plan_request', sessionId: 'G-b', id: 'gx-1', plan: 'the plan' },
        {
          type: 'pending_snapshot', sessionId: 'pending',
          permissions: [{ id: 'gp-1', sessionId: 'G-a' }],
          questions: [{ id: 'gq-1', sessionId: 'G-a' }, { id: 'gq-2', sessionId: 'G-c', delivery: 'async' }],
          exitPlans: [{ id: 'gx-1', sessionId: 'G-b' }],
        },
        { type: 'install_started', installId: 'inst-1', vpsId: 'vps-g1', vpsName: 'g1', status: 'running' },
      ]);
      // The derived cursor keys (§14.52) ride the VPS frame.
      expect(data[1]).toMatchObject({ agentVersion: '0.103.0', agentPyzSha: 'abc', cursorAvailable: 1, codexLoggedIn: 1 });
      expect(data[1]).not.toHaveProperty('agentLastSeenAt');
      expect(data[1]).not.toHaveProperty('ip');
      // Live bus frames follow, stamped with their own id.
      const r = publish({ type: 'status', sessionId: 'G-a', status: 'thinking' });
      const live = await readRaw(reader, (fs) => fs.some((f) => f.data.type === 'status' && f.data.status === 'thinking'));
      expect(live.frames.find((f) => f.data.status === 'thinking')!.id).toBe(`${epoch}.${r}`);
      ac.abort();
      await reader.cancel();
    } finally {
      bus.installs = [];
    }
  });

  it('a reconnect on the same conn ends the previous stream and stays registered', async () => {
    const first = open('route-identity-conn');
    const r1 = (await first.res).body!.getReader();
    await readFrames(r1, hasHeartbeat);
    expect(focusCountFor('S1')).toBe(1);

    const second = open('route-identity-conn');
    const r2 = (await second.res).body!.getReader();
    await readFrames(r2, hasHeartbeat);
    // The superseded stream ENDS (its heartbeat with it) …
    const rest = await readFrames(r1, () => false);
    expect(rest.done).toBe(true);
    // … and its abort, arriving late, does not unregister the new one.
    first.ac.abort();
    expect(focusCountFor('S1')).toBe(1);
    publish({ type: 'assistant_text', sessionId: 'S1', delta: 'live' });
    const live = await readFrames(r2, (f) => f.some((x) => x.type === 'assistant_text'));
    expect(live.frames.find((x) => x.type === 'assistant_text')).toMatchObject({ delta: 'live' });

    await r2.cancel();
    expect(focusCountFor('S1')).toBe(0);
  });

  it('snapshots derived VPS keys, skips archived rows, sends unread + bg counts and ONE pending_snapshot', async () => {
    db.insert(schema.vps).values({
      id: 'vps-a', name: 'a', ip: '127.0.0.1', sshUser: 'root', agentStatus: 'ok',
      cursorAvailable: 1, cursorSdkVersion: '1.2.3', cursorLoggedIn: 1, codexLoggedIn: 0,
    }).run();
    const session = (id: string, extra: Record<string, unknown>) => db.insert(schema.agentSessions).values({
      id, vpsId: 'vps-a', cwd: '/tmp', name: id, status: 'active', ...extra,
    }).run();
    session('S-live', { unreadStop: 1 });
    session('S-arch', { unreadStop: 1, archived: 1, status: 'sleeping' });
    session('S-bg', { status: 'background' });
    session('S-read', { unreadStop: 0 });
    bus.streams.set('S-bg', { status: 'background', runningBgTaskCount: () => 2 });
    bus.streams.set('S-read', { status: 'thinking', runningBgTaskCount: () => 0 });
    bus.streams.set('S-arch', { status: 'sleeping', runningBgTaskCount: () => 3 });

    db.insert(schema.sessionPendingPermissions).values([
      { id: 'perm-1', sessionId: 'S-live', toolName: 'Bash', toolInput: '{"command":"ls"}' },
      { id: 'perm-done', sessionId: 'S-live', toolName: 'Bash', toolInput: '{}', status: 'allowed' },
    ]).run();
    db.insert(schema.sessionPendingQuestions).values([
      { id: 'q-async', sessionId: 'S-live', kind: 'async_question', payload: '[{"question":"why?"}]' },
      { id: 'q-block', sessionId: 'S-read', kind: 'question', payload: '[{"question":"ok?"}]' },
      { id: 'plan-1', sessionId: 'S-bg', kind: 'exit_plan', payload: '{"plan":"do it"}' },
    ]).run();

    const { ac, res } = open('route-snapshot-conn', '&attentive=0');
    const reader = (await res).body!.getReader();
    const { frames } = await readFrames(reader, hasHeartbeat);
    ac.abort();

    const vpsStatus = frames.find((f) => f.type === 'vps_status' && f.sessionId === 'vps-a');
    expect(vpsStatus).toMatchObject({
      agentStatus: 'ok', cursorAvailable: 1, cursorSdkVersion: '1.2.3', cursorLoggedIn: 1, codexLoggedIn: 0,
    });

    const statuses = frames.filter((f) => f.type === 'status');
    expect(statuses.map((f) => [f.sessionId, f.status]).sort()).toEqual([
      ['S-bg', 'background'], ['S-live', 'active'], ['S-read', 'thinking'],
    ]);
    const unread = frames.filter((f) => f.type === 'session_unread');
    expect(unread).toEqual([{ type: 'session_unread', sessionId: 'S-live', unread: true }]);
    const bg = frames.filter((f) => f.type === 'session_bg_tasks');
    expect(bg).toEqual([{ type: 'session_bg_tasks', sessionId: 'S-bg', running: 2 }]);
    const lastStatus = frames.lastIndexOf(statuses[statuses.length - 1]);
    expect(frames.indexOf(unread[0])).toBeGreaterThan(lastStatus);
    expect(frames.indexOf(bg[0])).toBeGreaterThan(lastStatus);

    const snapshots = frames.filter((f) => f.type === 'pending_snapshot');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      type: 'pending_snapshot', sessionId: 'pending',
      permissions: [{ id: 'perm-1', sessionId: 'S-live' }],
      questions: expect.arrayContaining([
        { id: 'q-async', sessionId: 'S-live', delivery: 'async' },
        { id: 'q-block', sessionId: 'S-read' },
      ]),
      exitPlans: [{ id: 'plan-1', sessionId: 'S-bg' }],
    });
    expect(snapshots[0].questions).toHaveLength(2);
    // After every pending replay.
    const lastReplay = Math.max(...frames
      .map((f, i) => (['permission_request', 'user_question', 'exit_plan_request'].includes(f.type) ? i : -1)));
    expect(lastReplay).toBeGreaterThan(-1);
    expect(frames.indexOf(snapshots[0])).toBeGreaterThan(lastReplay);
  });

  it('a request aborted before start() registers nothing and ends its stream (no zombie conn)', async () => {
    // The tab closed/reloaded during the handler's async prologue (hub stall):
    // Next aborts the signal first and never cancels the destroyed body.
    const ac = new AbortController();
    ac.abort();
    const res = await GET(new Request('http://localhost/api/events?conn=route-aborted-conn&focus=SX&focusSeq=1&visible=1', {
      signal: ac.signal,
    }));
    const reader = res.body!.getReader();
    const rest = await readFrames(reader, () => false);
    expect(rest).toEqual({ frames: [], done: true });
    expect(focusCountFor('SX')).toBe(0);
    expect(isBeingWatched('SX')).toBe(false);
    publish({ type: 'assistant_text', sessionId: 'SX', delta: 'nobody' });
    expect(focusCountFor('SX')).toBe(0);
  });

  // An unregistered (attended) conn leaves only the bounded 12 s grace of
  // §14.47 behind — never a registration that keeps "watching".
  const afterGrace = () => vi.setSystemTime(Date.now() + 13_000);

  it('an abort during the snapshot window reaches the unregister (listener added right after registering)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const ac = new AbortController();
      const res = await GET(new Request('http://localhost/api/events?conn=route-abort-mid-conn&focus=SY&focusSeq=1', {
        signal: ac.signal,
      }));
      expect(focusCountFor('SY')).toBe(1);
      ac.abort();
      expect(focusCountFor('SY')).toBe(0);
      afterGrace();
      expect(isBeingWatched('SY')).toBe(false);
      await res.body!.cancel().catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throw while building the snapshot ends the stream AND unregisters it', async () => {
    bus.noticesThrow = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await GET(new Request('http://localhost/api/events?conn=route-throw-conn&focus=SZ&focusSeq=1'));
      const reader = res.body!.getReader();
      const rest = await readFrames(reader, () => false);
      expect(rest.done).toBe(true);
      expect(rest.frames.some((f) => f.type === 'heartbeat')).toBe(false);
      expect(focusCountFor('SZ')).toBe(0);
      afterGrace();
      expect(isBeingWatched('SZ')).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      bus.noticesThrow = false;
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('a pending gate larger than 512 KiB still ends in pending_snapshot + live (snapshot exempt from backpressure)', async () => {
    db.insert(schema.vps).values({ id: 'vps-big', name: 'big', ip: '127.0.0.1', sshUser: 'root' }).run();
    db.insert(schema.agentSessions).values({ id: 'S-big', vpsId: 'vps-big', cwd: '/tmp', name: 'b', status: 'active' }).run();
    const content = 'x'.repeat(600_000);
    db.insert(schema.sessionPendingPermissions).values([
      { id: 'perm-big', sessionId: 'S-big', toolName: 'Write', toolInput: JSON.stringify({ file_path: '/a', content }) },
      { id: 'perm-small', sessionId: 'S-big', toolName: 'Bash', toolInput: '{"command":"ls"}' },
    ]).run();
    const { ac, res } = open('route-big-gate-conn', '&attentive=0');
    const reader = (await res).body!.getReader();
    const { frames, done } = await readFrames(reader, hasHeartbeat);
    expect(done).toBe(false);
    expect(frames.find((f) => f.id === 'perm-big')?.input.content).toHaveLength(600_000);
    expect(frames.find((f) => f.type === 'pending_snapshot')?.permissions).toHaveLength(2);
    expect(focusCountFor('S1')).toBe(1);

    // Live backpressure still applies BEYOND the snapshot: a consumer that
    // stops reading is closed once > OUTBOX_LIVE_MAX (4 MiB) of live frames
    // pile up in its outbox (C12; it was the stream's 512 KiB HWM before).
    let published = 0;
    for (let i = 0; i < 200 && focusCountFor('S1') === 1; i++) {
      publish({ type: 'assistant_text', sessionId: 'S1', delta: 'y'.repeat(64 * 1024) });
      published++;
    }
    expect(focusCountFor('S1')).toBe(0);
    expect(published * 64 * 1024).toBeGreaterThan(4 << 20);
    ac.abort();
  });

  it('an empty pending set still sends ONE (empty) pending_snapshot', async () => {
    const { ac, res } = open('route-empty-conn');
    const reader = (await res).body!.getReader();
    const { frames } = await readFrames(reader, hasHeartbeat);
    ac.abort();
    expect(frames.filter((f) => f.type === 'pending_snapshot')).toEqual([
      { type: 'pending_snapshot', sessionId: 'pending', permissions: [], questions: [], exitPlans: [] },
    ]);
  });
});
