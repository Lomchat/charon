import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const auth = vi.hoisted(() => ({ ok: true }));
vi.mock('@/lib/server/session', () => ({
  requireApiSession: async () => (auth.ok
    ? { userId: 'u' }
    : new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })),
}));
// The route tests below run the real handlers against the hermetic DB; nothing
// may reach an agent, a push service or Telegram.
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: async () => {} }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: async () => {},
  sendQuestionToTelegram: async () => {},
  markInteractionResolvedInTelegram: async () => {},
  sendPlainToTelegram: async () => {},
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {},
    call: async () => ({ status: 'active' }),
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

type LoopLagModule = typeof import('@/lib/server/perf/loopLag');

// A histogram stand-in (nanoseconds, sampling interval INCLUDED, like
// monitorEventLoopDelay): the real one would make "silence" depend on how
// busy this test process happens to be.
function fakeHistogram(maxMs = 20.1, p50Ms = 20.05, p99Ms = 20.09) {
  return {
    count: 3000,
    max: maxMs * 1e6,
    percentile: (p: number) => (p >= 99 ? p99Ms : p50Ms) * 1e6,
    reset: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  };
}

async function load(): Promise<LoopLagModule> {
  return import('@/lib/server/perf/loopLag');
}

const state = () => (globalThis as any).__charonLoopLag;

describe('loop lag monitor', () => {
  afterEach(async () => {
    (await load()).stopLoopLagMonitor();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('warns ONCE on a stall, naming the timeSection that caused it', async () => {
    vi.useFakeTimers();
    const m = await load();
    let t = 1_000_000;
    const warn = vi.fn();
    m.startLoopLagMonitor({ now: () => t, warn, histogram: fakeHistogram() });

    t += 500; vi.advanceTimersByTime(500);
    expect(warn).not.toHaveBeenCalled();

    // A fast section first, then the one that blocks the loop for 1.5 s.
    m.timeSection('agent:status', () => { t += 5; });
    const out = m.timeSection('agent:thinking', () => { t += 1_500; return 42; });
    expect(out).toBe(42);
    vi.advanceTimersByTime(500);

    const stalls = warn.mock.calls.map((c) => c[0] as string).filter((s) => s.startsWith('[eventloop] stall'));
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatch(/^\[eventloop\] stall 1505ms; recent: agent:thinking 1500ms$/);
    // The section itself crossed the 250 ms line too.
    expect(warn).toHaveBeenCalledWith('[perf] agent:thinking 1500.0ms');

    // The next regular tick is quiet again.
    t += 500; vi.advanceTimersByTime(500);
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[eventloop] stall'))).toHaveLength(1);
    expect(m.loopLagSnapshot().stalls1h).toBe(1);
  });

  it('names the last section when none of the stall was recorded as slow', async () => {
    vi.useFakeTimers();
    const m = await load();
    let t = 0;
    const warn = vi.fn();
    m.startLoopLagMonitor({ now: () => t, warn, histogram: fakeHistogram() });
    m.timeSection('session list GET', () => { t += 20; });
    t += 1_200; // unwrapped work after it
    vi.advanceTimersByTime(500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[eventloop] stall 1220ms; recent: none slow (last section: session list GET)');
  });

  it('stays silent below every threshold', async () => {
    vi.useFakeTimers();
    const m = await load();
    let t = 0;
    const warn = vi.fn();
    const h = fakeHistogram(150, 20.1, 60);
    m.startLoopLagMonitor({ now: () => t, warn, histogram: h });

    for (let i = 0; i < 240; i += 1) {
      // Each tick: a section under the ring threshold, a slow-but-not-warned
      // one, and a gap of exactly 1000 ms (not ABOVE the stall threshold).
      m.timeSection('fast', () => { t += 50; });
      if (i % 40 === 0) m.timeSection('medium', () => { t += 150; });
      t += i % 2 ? 300 : 1_000 - 50 - (i % 40 === 0 ? 150 : 0);
      vi.advanceTimersByTime(500);
    }
    expect(warn).not.toHaveBeenCalled();
    // 60 s windows elapsed and were reset without a summary line (max 130 ms).
    expect(h.reset).toHaveBeenCalled();
    const snap = m.loopLagSnapshot();
    expect(snap.slow.every((s) => s.label === 'medium' && s.ms === 150)).toBe(true);
    expect(snap.slow.length).toBe(6);
    expect(snap.stalls1h).toBe(0);
  });

  it('summarises a 60 s window whose max exceeds 200 ms, then resets it', async () => {
    vi.useFakeTimers();
    const m = await load();
    let t = 0;
    const warn = vi.fn();
    const h = fakeHistogram(340.0, 20.5, 90.3);
    m.startLoopLagMonitor({ now: () => t, warn, histogram: h });
    m.timeSection('fold:tokens', () => { t += 180; });
    for (let i = 0; i < 120; i += 1) { t += 500; vi.advanceTimersByTime(500); }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[eventloop] 60s p50=0.5 p99=70.3 max=320ms slow=[fold:tokens 180ms]');
    expect(h.reset).toHaveBeenCalledTimes(1);
    // The snapshot reports lag (sampling interval removed).
    expect(m.loopLagSnapshot()).toMatchObject({ p50: 0.5, p99: 70.3, max: 320 });
  });

  it('starting twice arms ONE monitor', async () => {
    vi.useFakeTimers();
    const m = await load();
    const h1 = fakeHistogram();
    m.startLoopLagMonitor({ histogram: h1 });
    const first = { ...state() };
    expect(vi.getTimerCount()).toBe(2);
    m.startLoopLagMonitor({ histogram: fakeHistogram() });
    expect(vi.getTimerCount()).toBe(2);
    expect(state().driftTimer).toBe(first.driftTimer);
    expect(state().summaryTimer).toBe(first.summaryTimer);
    expect(state().histogram).toBe(h1);
    expect(h1.enable).toHaveBeenCalledTimes(1);
  });

  it('a vi.resetModules() twin shares the same state and timers', async () => {
    vi.useFakeTimers();
    const a = await load();
    let t = 0;
    const warn = vi.fn();
    a.startLoopLagMonitor({ now: () => t, warn, histogram: fakeHistogram() });
    vi.resetModules();
    const b = await load();
    expect(b).not.toBe(a);
    b.startLoopLagMonitor({ histogram: fakeHistogram() });
    expect(vi.getTimerCount()).toBe(2);
    b.timeSection('twin', () => { t += 120; });
    expect(a.loopLagSnapshot().slow.map((s) => s.label)).toEqual(['twin']);
    a.noteSlowSection('first-copy', 400);
    expect(b.loopLagSnapshot().slow.map((s) => s.label)).toEqual(['twin', 'first-copy']);
    expect(warn).toHaveBeenCalledWith('[perf] first-copy 400.0ms');
  });

  it('never keeps the process alive: both timers are unref', async () => {
    const m = await load();
    m.startLoopLagMonitor({ warn: () => {} });
    const st = state();
    expect(st.driftTimer.hasRef()).toBe(false);
    expect(st.summaryTimer.hasRef()).toBe(false);
    expect(st.histogram).not.toBeNull();
  });

  it('timeSection rethrows, still records, and the ring keeps the last 32', async () => {
    const m = await load();
    let t = 0;
    vi.useFakeTimers();
    m.startLoopLagMonitor({ now: () => t, warn: () => {}, histogram: fakeHistogram() });
    expect(() => m.timeSection('boom', () => { t += 300; throw new Error('x'); })).toThrow('x');
    expect(m.loopLagSnapshot().slow).toEqual([{ label: 'boom', ms: 300, at: 300 }]);
    for (let i = 0; i < 40; i += 1) m.noteSlowSection(`s${i}`, 101);
    const slow = m.loopLagSnapshot().slow;
    expect(slow).toHaveLength(32);
    expect(slow[0].label).toBe('s8');
    expect(slow[31].label).toBe('s39');
    m.noteSlowSection('ignored', 100);
    expect(m.loopLagSnapshot().slow.at(-1)!.label).toBe('s39');
  });

  it('counts stalls over the last hour only', async () => {
    vi.useFakeTimers();
    const m = await load();
    let t = 0;
    m.startLoopLagMonitor({ now: () => t, warn: () => {}, histogram: fakeHistogram() });
    t += 2_000; vi.advanceTimersByTime(500);
    expect(m.loopLagSnapshot().stalls1h).toBe(1);
    t += 3_600_000;
    expect(m.loopLagSnapshot().stalls1h).toBe(0);
  });

  it('GET /api/perf serves the snapshot behind the session gate', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = await load();
    m.noteSlowSection('session GET abc window', 300);
    expect(quiet).toHaveBeenCalledWith('[perf] session GET abc window 300.0ms');
    const { GET } = await import('@/app/api/perf/route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      loop: {
        p50: 0, p99: 0, max: 0, stalls1h: 0,
        slow: [{ label: 'session GET abc window', ms: 300, at: expect.any(Number) }],
      },
      // The sync bus numbers (C11): shape only here, tests/syncBus.test.ts pins them.
      sync: expect.objectContaining({ epoch: expect.any(Number), rev: expect.any(Number) }),
    });
    auth.ok = false;
    try {
      expect((await GET()).status).toBe(401);
    } finally {
      auth.ok = true;
      quiet.mockRestore();
    }
  });

  it('is inert during next build', async () => {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    vi.useFakeTimers();
    const m = await load();
    m.startLoopLagMonitor({ histogram: fakeHistogram() });
    expect(vi.getTimerCount()).toBe(0);
    expect(state()?.started ?? false).toBe(false);
  });
});

// The three route wraps: their labels are what `journalctl | grep '\[perf\]'`
// and the stall attribution print, and ONE line per slow request is the
// metric the rollout counts (`grep -c '\[perf\] session GET'`).
describe('route sections carry their journal labels', () => {
  const VPS_ID = 'perfvps';
  const SID = 'e'.repeat(32);
  type SessionGet = typeof import('@/app/api/sessions/[id]/route').GET;
  type ListGet = typeof import('@/app/api/sessions/route').GET;
  type EventsGet = typeof import('@/app/api/events/route').GET;
  let sessionGet: SessionGet;
  let listGet: ListGet;
  let eventsGet: EventsGet;
  let restorePrepare: (() => void) | null = null;

  beforeAll(async () => {
    const dbMod = await import('@/lib/db');
    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
    migrate(dbMod.db, { migrationsFolder: './drizzle' });
    dbMod.db.insert(dbMod.vpsFolders).values({ id: 'default', name: 'default', position: 0 })
      .onConflictDoNothing().run();
    dbMod.db.insert(dbMod.vps).values({ id: VPS_ID, name: 'perf-vps', ip: '127.0.0.1', sshUser: 'root' })
      .onConflictDoNothing().run();
    dbMod.db.insert(dbMod.agentSessions).values({
      id: SID, vpsId: VPS_ID, cwd: '/tmp', name: 'perf', status: 'sleeping',
    }).onConflictDoNothing().run();
    ({ GET: sessionGet } = await import('@/app/api/sessions/[id]/route'));
    ({ GET: listGet } = await import('@/app/api/sessions/route'));
    ({ GET: eventsGet } = await import('@/app/api/events/route'));
  });

  afterEach(async () => {
    restorePrepare?.();
    restorePrepare = null;
    (await load()).stopLoopLagMonitor();
    vi.useRealTimers();
  });

  /** Monitor whose clock advances 300 ms per SQL statement prepared: a section
   *  is slow exactly when the route's DB work runs INSIDE it (a wrap around
   *  nothing, or none at all, prints no line). Only the monitor's own interval
   *  timers are faked, so they never tick. */
  async function sqlClockMonitor() {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const m = await load();
    let t = 0;
    const warn = vi.fn();
    m.startLoopLagMonitor({ now: () => t, warn, histogram: fakeHistogram() });
    const sqlite = (globalThis as any)._sqlite;
    const real = sqlite.prepare;
    sqlite.prepare = function (this: unknown, ...args: unknown[]) {
      t += 300;
      return real.apply(this, args);
    };
    restorePrepare = () => { sqlite.prepare = real; };
    const perfLines = () => warn.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith('[perf] '));
    return { m, perfLines };
  }

  it('session GET: `[perf] session GET <id> window|delta <ms>ms`, one line per request', async () => {
    const { m, perfLines: allPerfLines } = await sqlClockMonitor();
    // The row folds the GET reads are timed as NESTED `fold:<key>` sections
    // (sessionRowCache.ts); their lazily prepared statements make them "slow"
    // under this clock. The request itself still prints exactly one line.
    const perfLines = () => allPerfLines().filter((l) => !l.startsWith('[perf] fold:'));
    const get = (query: string) => sessionGet(
      new Request(`http://localhost/api/sessions/${SID}${query}`),
      { params: Promise.resolve({ id: SID }) },
    );
    const line = (mode: string) => new RegExp(`^\\[perf\\] session GET ${SID} ${mode} [\\d.]+ms$`);

    expect((await get('')).status).toBe(200);
    expect(perfLines()).toHaveLength(1);
    expect(perfLines()[0]).toMatch(line('window'));

    expect((await get('?since=12')).status).toBe(200);
    expect(perfLines()).toHaveLength(2);
    expect(perfLines()[1]).toMatch(line('delta'));

    // A non-numeric cursor is a window read in the body, so in the label too.
    expect((await get('?since=abc')).status).toBe(200);
    expect(perfLines()).toHaveLength(3);
    expect(perfLines()[2]).toMatch(line('window'));

    expect(m.loopLagSnapshot().slow.map((s) => s.label).filter((l) => !l.startsWith('fold:'))).toEqual([
      `session GET ${SID} window`, `session GET ${SID} delta`, `session GET ${SID} window`,
    ]);
  });

  it('session list GET and SSE start are timed under their own labels', async () => {
    const { m, perfLines } = await sqlClockMonitor();

    const list = await listGet(new Request('http://localhost/api/sessions'));
    expect(list.status).toBe(200);
    expect((await list.json()).sessions.map((s: { id: string }) => s.id)).toContain(SID);
    expect(perfLines()).toHaveLength(1);
    expect(perfLines()[0]).toMatch(/^\[perf\] session list GET [\d.]+ms$/);

    // ReadableStream runs start() inside the constructor: the section is over
    // by the time the handler returns.
    const sse = await eventsGet(new Request('http://localhost/api/events?conn=perf-conn-1'));
    expect(sse.status).toBe(200);
    expect(perfLines()).toHaveLength(2);
    expect(perfLines()[1]).toMatch(/^\[perf\] SSE start [\d.]+ms$/);
    await sse.body!.cancel();

    expect(m.loopLagSnapshot().slow.map((s) => s.label)).toEqual(['session list GET', 'SSE start']);
  });
});
