// The sync bus (C11): revisions, ring, encode-once fan-out, summary dirty set,
// the connection registry's router + heartbeat, and the legacy SSE route
// riding on it. Pure parts run on fresh module copies (`vi.resetModules()`)
// with the `globalThis` state wiped; the route part uses the hermetic DB.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
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
// The route only needs peekStream; the real sessionOps is loaded with
// `vi.importActual` where it is the subject.
vi.mock('@/lib/server/agent/sessionOps', () => ({
  peekStream: () => undefined,
}));

type Bus = typeof import('@/lib/server/sync/syncBus');
type Conns = typeof import('@/lib/server/agent/eventConnections');

const G = globalThis as Record<string, unknown>;
const dec = new TextDecoder();
const text = (c: Uint8Array) => dec.decode(c);

/** Every `id:`/`data:` frame of an SSE byte string. */
function frames(s: string): Array<{ id: string | null; data: Record<string, unknown> }> {
  return s.split('\n\n').filter((b) => b.trim()).map((block) => {
    let id: string | null = null;
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    return { id, data: JSON.parse(data) as Record<string, unknown> };
  });
}

function wipeGlobals(): void {
  const hb = G._eventConnectionsHeartbeat as { timer: ReturnType<typeof setInterval> | null } | undefined;
  if (hb?.timer) clearInterval(hb.timer);
  for (const k of ['__charonSync', '__charonConns', '_eventConnectionsHeartbeat']) delete G[k];
}

async function freshBus(): Promise<Bus> {
  vi.resetModules();
  return import('@/lib/server/sync/syncBus');
}

/** A fresh bus + registry pair (the same module graph). */
async function freshRegistry(): Promise<{ bus: Bus; conns: Conns }> {
  vi.resetModules();
  const bus = await import('@/lib/server/sync/syncBus');
  const conns = await import('@/lib/server/agent/eventConnections');
  return { bus, conns };
}

const all = () => true;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('sync bus (pure)', () => {
  beforeEach(() => { wipeGlobals(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('@/lib/server/sync/frameRouting');
    wipeGlobals();
  });

  it('keeps ONE strictly monotonic revision across module copies', async () => {
    const a = await freshBus();
    const b = await freshBus();
    expect(a).not.toBe(b);
    const revs = [
      a.publish({ type: 'status', sessionId: 's1', status: 'active' }),
      b.publish({ type: 'status', sessionId: 's1', status: 'thinking' }),
      a.publish({ type: 'tabs_changed', sessionId: 'tabs' }),
      b.publish({ type: 'assistant_text', sessionId: 's1', delta: 'x' }),
    ];
    expect(revs).toEqual([1, 2, 3, 4]);
    expect(a.currentRev()).toEqual(b.currentRev());
    expect(a.currentRev().rev).toBe(4);
    expect(a.epoch()).toBe(b.epoch());
    // Both copies read the same ring.
    expect(a.replayFrom(0, all, 1 << 20)).toHaveLength(4);
    expect(b.replayFrom(2, all, 1 << 20)).toHaveLength(2);
  });

  it('stamps `id: <epoch>.<rev>` on the event exactly as emitted (no field added)', async () => {
    const bus = await freshBus();
    const ev = { type: 'status', sessionId: 's1', status: 'active' };
    const seen: Uint8Array[] = [];
    bus.subscribeFrames((f) => { seen.push(f.chunk); });
    const rev = bus.publish(ev);
    expect(text(seen[0])).toBe(`id: ${bus.epoch()}.${rev}\ndata: ${JSON.stringify(ev)}\n\n`);
    expect(ev).toEqual({ type: 'status', sessionId: 's1', status: 'active' });
    // A frame without sessionId (installs, model notices) stays without one.
    const inst = { type: 'install_started', installId: 'i', vpsId: 'v', vpsName: 'n', status: 'running' };
    bus.publish(inst);
    expect(frames(text(seen[1]))[0].data).toEqual(inst);
  });

  it('charges a per-frame overhead: tiny frames evict by the charged size, the stats report it', async () => {
    vi.stubEnv('CHARON_SYNC_RING_MB', '1');
    const bus = await freshBus();
    let payload = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) bus.publish({ type: 'assistant_text', sessionId: 's1', delta: 'x' });
    for (const c of bus.replayFrom(bus.currentRev().rev - bus.syncStats().ringFrames, () => true, 64 << 20) ?? []) {
      payload += c.byteLength;
    }
    const st = bus.syncStats();
    // ~85 B payloads: payload-only accounting kept ≈ 12 000 of them (≈ 4 MiB
    // of real heap under a 1 MiB cap); charged, ≈ 1 MiB / 405 B.
    expect(bus.RING_FRAME_OVERHEAD).toBeGreaterThanOrEqual(256);
    expect(st.ringFrames).toBeLessThan((1 << 20) / 300);
    expect(st.ringBytes).toBe(payload + st.ringFrames * bus.RING_FRAME_OVERHEAD);
    expect(st.ringBytes).toBeLessThanOrEqual(1 << 20);
    expect(st.ringBytes + Math.ceil(payload / st.ringFrames) + bus.RING_FRAME_OVERHEAD).toBeGreaterThan(1 << 20);
  });

  it('ring env sizes: large / fractional / bad values never collapse the ring (no int32 shift)', async () => {
    for (const [mb, bytes] of [['2048', 1024 * 1048576], ['4096', 1024 * 1048576], ['0.5', 32 * 1048576],
      ['-3', 32 * 1048576], ['abc', 32 * 1048576], ['64', 64 * 1048576], ['1.5', 1.5 * 1048576]] as const) {
      vi.stubEnv('CHARON_SYNC_RING_MB', mb);
      vi.stubEnv('CHARON_SYNC_RING_MIN', '-1');
      const bus = await freshBus();
      expect(bus.RING_MAX_BYTES).toBe(bytes);
      expect(bus.RING_MAX_AGE_MS).toBe(15 * 60_000);
    }
  });

  it('evicts the ring by bytes', async () => {
    vi.stubEnv('CHARON_SYNC_RING_MB', '1');
    const bus = await freshBus();
    expect(bus.RING_MAX_BYTES).toBe(1 << 20);
    const big = 'x'.repeat(200 * 1024); // under the 256 KiB stub threshold
    for (let i = 0; i < 6; i++) bus.publish({ type: 'tool_progress', sessionId: 's1', delta: big });
    const st = bus.syncStats();
    expect(st.ringBytes).toBeLessThanOrEqual(1 << 20);
    expect(st.ringFrames).toBe(5);
    expect(st.oldestRev).toBe(2);
    expect(st.stubs).toBe(0);
    // since=0 needs rev 1, evicted: a gap; since=1 is the oldest resumable point.
    expect(bus.replayFrom(0, all, 64 << 20)).toBeNull();
    expect(bus.replayFrom(1, all, 64 << 20)).toHaveLength(5);
  });

  it('evicts the ring by age, on publish and on read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-15T10:00:00Z');
    vi.setSystemTime(t0);
    const bus = await freshBus();
    for (let i = 0; i < 3; i++) bus.publish({ type: 'status', sessionId: 's1', status: 'active' });
    vi.setSystemTime(t0 + bus.RING_MAX_AGE_MS - 1);
    bus.publish({ type: 'status', sessionId: 's2', status: 'active' }); // rev 4
    expect(bus.syncStats().ringFrames).toBe(4);
    vi.setSystemTime(t0 + bus.RING_MAX_AGE_MS + 1);
    bus.publish({ type: 'status', sessionId: 's3', status: 'active' }); // rev 5 evicts 1..3
    expect(bus.syncStats()).toMatchObject({ ringFrames: 2, oldestRev: 4 });
    expect(bus.replayFrom(2, all, 1 << 20)).toBeNull();
    expect(bus.replayFrom(3, all, 1 << 20)).toHaveLength(2);
    // Nothing published for a while: a read still applies the age bound.
    vi.setSystemTime(t0 + 2 * bus.RING_MAX_AGE_MS + 10);
    expect(bus.replayFrom(3, all, 1 << 20)).toBeNull();
    expect(bus.replayFrom(5, all, 1 << 20)).toEqual([]);
    expect(bus.syncStats()).toMatchObject({ ringFrames: 0, oldestRev: 6 });
  });

  it('a burst eviction compacts the ring ONCE (no per-1024-frame array copies), index intact', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-15T10:00:00Z');
    vi.setSystemTime(t0);
    const bus = await freshBus();
    const N = 40_000;
    for (let i = 0; i < N / 2; i++) bus.publish({ type: 'status', sessionId: 's1', status: 'active' });
    vi.setSystemTime(t0 + 10 * 60_000);
    for (let i = 0; i < N / 2; i++) bus.publish({ type: 'status', sessionId: 's2', status: 'active' });
    expect(bus.syncStats().ringFrames).toBe(N);

    // The quiet spell is over: ONE publish expires the older half.
    vi.setSystemTime(t0 + bus.RING_MAX_AGE_MS + 1);
    const S = (globalThis as any).__charonSync;
    let ringCopies = 0;
    for (const m of ['slice', 'splice'] as const) {
      const orig = Array.prototype[m] as (...a: unknown[]) => unknown;
      vi.spyOn(Array.prototype, m).mockImplementation(function (this: unknown[], ...args: unknown[]) {
        if (this === S.ring) ringCopies++;
        return orig.apply(this, args);
      } as any);
    }
    const rev = bus.publish({ type: 'status', sessionId: 's3', status: 'active' });
    vi.restoreAllMocks();
    expect(ringCopies).toBeLessThanOrEqual(1);
    expect(S.head).toBe(0);
    expect(bus.syncStats()).toMatchObject({ ringFrames: N / 2 + 1, oldestRev: N / 2 + 1 });
    // The O(1) rev index still lands on the right frames after the compaction.
    expect(bus.replayFrom(N / 2 - 1, all, 1 << 30)).toBeNull();
    const tail = bus.replayFrom(rev - 2, all, 1 << 30)!;
    expect(tail.map((c) => frames(text(c))[0].id)).toEqual([`${bus.epoch()}.${rev - 1}`, `${bus.epoch()}.${rev}`]);
    expect(bus.replayFrom(N / 2, all, 1 << 30)).toHaveLength(N / 2 + 1);
  });

  it('fans an oversized frame out in full but rings a session_resync stub', async () => {
    const bus = await freshBus();
    const live: Uint8Array[] = [];
    bus.subscribeFrames((f) => { live.push(f.chunk); });
    const content = 'y'.repeat(300 * 1024);
    const rev = bus.publish({ type: 'edit_snapshot', sessionId: 's1', content });
    expect(live[0].byteLength).toBeGreaterThan(bus.RING_FRAME_MAX_BYTES);
    expect(frames(text(live[0]))[0].data.content).toBe(content);

    const kept: Array<{ type: string; route: string; sessionId: string | null }> = [];
    const replay = bus.replayFrom(rev - 1, (f) => { kept.push(f); return true; }, 1 << 20)!;
    expect(replay).toHaveLength(1);
    expect(text(replay[0])).toBe(`id: ${bus.epoch()}.${rev}\ndata: `
      + `{"type":"session_resync","sessionId":"s1","reason":"large_frame"}\n\n`);
    // The stub keeps the original frame's route and session (resume filter).
    expect(kept[0]).toMatchObject({ type: 'session_resync', route: 'focused', sessionId: 's1' });
    expect(bus.syncStats()).toMatchObject({ stubs: 1, ringFrames: 1 });
    expect(bus.syncStats().ringBytes).toBe(replay[0].byteLength + bus.RING_FRAME_OVERHEAD);
  });

  it('replayFrom: exact filtered tail, [] when current, null on gap / future / cap', async () => {
    const bus = await freshBus();
    bus.publish({ type: 'assistant_text', sessionId: 'A', delta: '1' }); // 1
    bus.publish({ type: 'assistant_text', sessionId: 'B', delta: '2' }); // 2
    bus.publish({ type: 'status', sessionId: 'B', status: 'active' });   // 3 (low)
    bus.publish({ type: 'assistant_text', sessionId: 'A', delta: '4' }); // 4
    bus.publish({ type: 'assistant_text', sessionId: 'B', delta: '5' }); // 5
    const focusedOnA = (f: { route: string; sessionId: string | null }) =>
      f.route === 'low' || f.sessionId === 'A';
    const out = bus.replayFrom(1, focusedOnA, 1 << 20)!;
    expect(out.map((c) => frames(text(c))[0].id)).toEqual([`${bus.epoch()}.3`, `${bus.epoch()}.4`]);
    expect(bus.replayFrom(5, all, 1 << 20)).toEqual([]);
    expect(bus.replayFrom(6, all, 1 << 20)).toBeNull();        // future
    expect(bus.replayFrom(-1, all, 1 << 20)).toBeNull();
    const total = bus.replayFrom(0, all, 1 << 20)!.reduce((n, c) => n + c.byteLength, 0);
    expect(bus.replayFrom(0, all, total)).toHaveLength(5);
    expect(bus.replayFrom(0, all, total - 1)).toBeNull();      // over the cap
    // The cap counts only what the filter keeps.
    expect(bus.replayFrom(0, (f) => f.sessionId === 'A', 400)).toHaveLength(2);
  });

  it('coalesces summary marks into ONE provider call per tick', async () => {
    const bus = await freshBus();
    const provider = vi.fn();
    bus.setSummaryProvider(provider);
    bus.publish({ type: 'status', sessionId: 's1', status: 'active' });
    bus.publish({ type: 'session_unread', sessionId: 's1', unread: true });
    bus.publish({ type: 'permission_request', sessionId: 's2', id: 'p', tool: 'Bash', input: {} });
    bus.publish({ type: 'vps_status', sessionId: 'v1', agentStatus: 'ok' });
    bus.publish({ type: 'assistant_text', sessionId: 's3', delta: 'not a trigger' });
    bus.markSummaryDirty('s4');
    expect(provider).not.toHaveBeenCalled();
    await tick();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith(['s1', 's2', 's4'], ['v1']);
    // A list ping may carry a VPS id (reorder): both sets get it.
    bus.publish({ type: 'session_list_changed', sessionId: 'v2' });
    await tick();
    expect(provider).toHaveBeenLastCalledWith(['v2'], ['v2']);
    expect(provider).toHaveBeenCalledTimes(2);
    await tick();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('flushSummaryNow publishes synchronously and leaves nothing for the tick', async () => {
    const bus = await freshBus();
    const provider = vi.fn((ids: string[]) => {
      for (const id of ids) bus.publish({ type: 'session_summary', sessionId: id, summary: { id } });
    });
    bus.setSummaryProvider(provider);
    const seen: string[] = [];
    bus.subscribeFrames((f) => { seen.push(`${f.type}:${f.sessionId}`); });
    bus.publish({ type: 'status', sessionId: 's1', status: 'active' });
    bus.flushSummaryNow('s1');
    expect(seen).toEqual(['status:s1', 'session_summary:s1']);
    expect(provider).toHaveBeenCalledWith(['s1'], []);
    await tick();
    expect(provider).toHaveBeenCalledTimes(1);
    // flushSummaries is the synchronous flush of the whole dirty set.
    bus.markSummaryDirty('s2');
    bus.markVpsSummariesDirty('v1');
    bus.flushSummaries();
    expect(provider).toHaveBeenLastCalledWith(['s2'], ['v1']);
    await tick();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('sessionRevOf advances for low and focused frames (summary included), not internal', async () => {
    vi.resetModules();
    vi.doMock('@/lib/server/sync/frameRouting', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/server/sync/frameRouting')>();
      return { ...actual, routeOf: (t: string) => (t === 'test_internal' ? 'internal' : actual.routeOf(t)) };
    });
    const bus = await import('@/lib/server/sync/syncBus');
    expect(bus.sessionRevOf('s1')).toBe(0);
    const low = bus.publish({ type: 'status', sessionId: 's1', status: 'active' });
    expect(bus.sessionRevOf('s1')).toBe(low);
    const focused = bus.publish({ type: 'assistant_text', sessionId: 's1', delta: 'x' });
    expect(bus.sessionRevOf('s1')).toBe(focused);
    const summary = bus.publish({ type: 'session_summary', sessionId: 's1', summary: null });
    expect(bus.sessionRevOf('s1')).toBe(summary);
    const internal = bus.publish({ type: 'test_internal', sessionId: 's1' });
    expect(internal).toBe(summary + 1);
    expect(bus.sessionRevOf('s1')).toBe(summary);
    expect(bus.sessionRevOf('other')).toBe(0);
  });

  it('syncStats reports rates, conns and the resume/resync/close counters', async () => {
    const bus = await freshBus();
    bus.publish({ type: 'status', sessionId: 's1', status: 'active' });
    bus.publish({ type: 'status', sessionId: 's2', status: 'active' });
    bus.recordResume();
    bus.recordResync('gap');
    bus.recordResync('gap');
    bus.recordClose('outbox');
    bus.setConnStatsProvider(() => ({ conns: 3, outboxBytes: 42 }));
    const st = bus.syncStats();
    expect(st).toMatchObject({
      rev: 2, ringFrames: 2, oldestRev: 1, framesPerMin: 2, stubs: 0, conns: 3, outboxBytes: 42,
      resumes: 1, resyncs: { gap: 2 }, closes: { outbox: 1 },
    });
    expect(st.bytesPerMin + 2 * bus.RING_FRAME_OVERHEAD).toBe(st.ringBytes);
  });
});

describe('revisions and summary keys (browser-safe modules)', () => {
  it('parseRev / formatRev / cmpRev', async () => {
    const { parseRev, formatRev, cmpRev, isNewer } = await import('@/lib/sync/rev');
    expect(parseRev('1792058400000.42')).toEqual({ epoch: 1792058400000, rev: 42 });
    expect(formatRev({ epoch: 5, rev: 0 })).toBe('5.0');
    for (const bad of [null, undefined, '', '5', '5.', '.5', '5.5.5', '-1.2', '1.2x', ' 1.2', '99999999999999999.1']) {
      expect(parseRev(bad as string | null | undefined)).toBeNull();
    }
    expect(cmpRev(null, null)).toBe(0);
    expect(cmpRev(null, { epoch: 1, rev: 0 })).toBe(-1);
    expect(cmpRev({ epoch: 1, rev: 0 }, null)).toBe(1);
    expect(cmpRev({ epoch: 2, rev: 1 }, { epoch: 1, rev: 99 })).toBe(1);
    expect(cmpRev({ epoch: 2, rev: 1 }, { epoch: 2, rev: 3 })).toBe(-1);
    expect(isNewer({ epoch: 2, rev: 3 }, { epoch: 2, rev: 3 })).toBe(false);
    expect(isNewer({ epoch: 2, rev: 4 }, { epoch: 2, rev: 3 })).toBe(true);
  });

  it('summaryKey is key-order stable and ignores the volatile keys only', async () => {
    const { summaryKey } = await import('@/lib/sessionSummary');
    type S = Parameters<typeof summaryKey>[0];
    const a = { id: 's', name: 'n', gates: [{ id: 'g', kind: 'permission', title: 'Bash' }], lastSeenSeq: 1,
      lastActivityMs: 10, endpoint: { b: 1, a: 2 } } as unknown as S;
    const b = { endpoint: { a: 2, b: 1 }, lastActivityMs: 99, lastSeenSeq: 7,
      gates: [{ title: 'Bash', kind: 'permission', id: 'g' }], name: 'n', id: 's', extra: undefined } as unknown as S;
    expect(summaryKey(a)).toBe(summaryKey(b));
    expect(summaryKey({ ...a, name: 'other' } as S)).not.toBe(summaryKey(a));
    expect(summaryKey({ ...a, gates: [] } as S)).not.toBe(summaryKey(a));
  });
});

describe('connection registry on the bus (router + heartbeat)', () => {
  beforeEach(() => { wipeGlobals(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    wipeGlobals();
  });

  function sink() {
    const chunks: Uint8Array[] = [];
    return { chunks, push: (c: Uint8Array) => { chunks.push(c); } };
  }

  it('routes low frames to every LIVE conn and focused ones to the focused conn', async () => {
    const { bus, conns } = await freshRegistry();
    const a = sink(); const b = sink(); const c = sink();
    conns.registerConnection({ connId: 'conn-a-0001', push: a.push, initialFocus: 'S1' });
    conns.registerConnection({ connId: 'conn-b-0001', push: b.push, initialFocus: 'S2' });
    conns.registerConnection({ connId: 'conn-c-0001', push: c.push, initialFocus: 'S1' });
    // Not live yet: nothing routed (its snapshot covers what it misses).
    bus.publish({ type: 'status', sessionId: 'S1', status: 'thinking' });
    expect([a.chunks, b.chunks, c.chunks].map((x) => x.length)).toEqual([0, 0, 0]);
    conns.markConnectionLive('conn-a-0001');
    conns.markConnectionLive('conn-b-0001');
    a.chunks.length = 0; b.chunks.length = 0;

    bus.publish({ type: 'status', sessionId: 'S1', status: 'active' });
    bus.publish({ type: 'assistant_text', sessionId: 'S1', delta: 'hi' });
    bus.publish({ type: 'assistant_text', sessionId: 'S2', delta: 'yo' });
    bus.publish({ type: 'install_started', installId: 'i', vpsId: 'v', vpsName: 'n', status: 'running' });
    const types = (x: Uint8Array[]) => x.map((ch) => `${frames(text(ch))[0].data.type}`);
    expect(types(a.chunks)).toEqual(['status', 'assistant_text', 'install_started']);
    expect(types(b.chunks)).toEqual(['status', 'assistant_text', 'install_started']);
    expect(frames(text(b.chunks[1]))[0].data.delta).toBe('yo');
    expect(c.chunks).toEqual([]);
    // Every routed frame carries its bus id.
    for (const ch of [...a.chunks, ...b.chunks]) expect(frames(text(ch))[0].id).toMatch(/^\d+\.\d+$/);
    // Focus moves the filter on the next frame.
    conns.setConnectionFocus('conn-b-0001', 'S1', 5, true);
    bus.publish({ type: 'assistant_text', sessionId: 'S1', delta: 'both' });
    expect(types(b.chunks).at(-1)).toBe('assistant_text');
    expect(a.chunks).toHaveLength(4);
  });

  it('stringifies and encodes each frame ONCE; every conn and the ring share the same bytes', async () => {
    const { bus, conns } = await freshRegistry();
    const sinks = [sink(), sink(), sink()];
    sinks.forEach((s, i) => {
      conns.registerConnection({ connId: `conn-same-${i}000`, push: s.push, initialFocus: 'S1' });
      conns.markConnectionLive(`conn-same-${i}000`);
      s.chunks.length = 0;
    });
    const viaSub: Uint8Array[] = [];
    bus.subscribeFrames((f) => { viaSub.push(f.chunk); });
    const stringify = vi.spyOn(JSON, 'stringify');
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    const rev = bus.publish({ type: 'status', sessionId: 'S1', status: 'active' });
    expect(stringify).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledTimes(1);
    stringify.mockRestore();
    encode.mockRestore();
    const ring = bus.replayFrom(rev - 1, all, 1 << 20)!;
    for (const s of sinks) {
      expect(s.chunks).toHaveLength(1);
      expect(s.chunks[0]).toBe(viaSub[0]);
    }
    expect(ring[0]).toBe(viaSub[0]);
  });

  it('heartbeats carry id = currentRev() and reach LIVE raw conns only', async () => {
    vi.useFakeTimers();
    const { bus, conns } = await freshRegistry();
    const a = sink(); const pending = sink(); const legacySend = vi.fn();
    conns.registerConnection({ connId: 'conn-hb-a001', push: a.push, initialFocus: 'S1' });
    conns.registerConnection({ connId: 'conn-hb-p001', push: pending.push, initialFocus: 'S1' });
    conns.registerConnection({ connId: 'conn-hb-s001', send: legacySend, initialFocus: 'S1' });
    bus.publish({ type: 'status', sessionId: 'S9', status: 'active' });
    bus.publish({ type: 'status', sessionId: 'S9', status: 'thinking' });

    // Going live sends the first heartbeat, at the current revision.
    expect(conns.markConnectionLive('conn-hb-a001')).toBe(true);
    let hb = frames(text(a.chunks.at(-1)!))[0];
    expect(hb.data.type).toBe('heartbeat');
    expect(hb.id).toBe(`${bus.epoch()}.${bus.currentRev().rev}`);
    expect(hb.id).toBe(`${bus.epoch()}.2`);

    // The registry timer: one 8 s tick reaches every live raw conn.
    bus.publish({ type: 'status', sessionId: 'S9', status: 'active' });
    const before = a.chunks.length;
    vi.advanceTimersByTime(8_000);
    expect(a.chunks.length).toBe(before + 1);
    hb = frames(text(a.chunks.at(-1)!))[0];
    expect(hb).toMatchObject({ id: `${bus.epoch()}.3`, data: { type: 'heartbeat' } });
    expect(pending.chunks).toEqual([]);

    // pushHeartbeatTo: live conns only (the probe's push, C12).
    expect(conns.pushHeartbeatTo('conn-hb-p001')).toBe(false);
    expect(conns.pushHeartbeatTo('conn-hb-zzzz')).toBe(false);
    expect(conns.pushHeartbeatTo('conn-hb-a001')).toBe(true);
    expect(pending.chunks).toEqual([]);
    // A send-only (object) conn gets bus frames once live, never heartbeats.
    conns.markConnectionLive('conn-hb-s001');
    vi.advanceTimersByTime(8_000);
    expect(legacySend).not.toHaveBeenCalled();
    bus.publish({ type: 'status', sessionId: 'S9', status: 'thinking' });
    expect(legacySend).toHaveBeenCalledWith({ type: 'status', sessionId: 'S9', status: 'thinking' });
  });

  it('one process-wide heartbeat timer, stopped with the last conn', async () => {
    vi.useFakeTimers();
    const { conns } = await freshRegistry();
    const offs = [0, 1, 2].map((i) => conns.registerConnection({ connId: `conn-timer-${i}0`, push: () => {} }));
    expect(vi.getTimerCount()).toBe(1);
    offs[0](); offs[1]();
    expect(vi.getTimerCount()).toBe(1);
    offs[2]();
    expect(vi.getTimerCount()).toBe(0);
    conns.registerConnection({ connId: 'conn-timer-30', push: () => {} });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a superseded connId stops receiving; its replacement starts not-live', async () => {
    const { bus, conns } = await freshRegistry();
    const old = sink(); const next = sink();
    conns.registerConnection({ connId: 'conn-dup-0001', push: old.push, initialFocus: 'S1' });
    conns.markConnectionLive('conn-dup-0001');
    conns.registerConnection({ connId: 'conn-dup-0001', push: next.push, initialFocus: 'S1' });
    old.chunks.length = 0;
    bus.publish({ type: 'status', sessionId: 'S1', status: 'active' });
    expect(old.chunks).toEqual([]);
    expect(next.chunks).toEqual([]);
    conns.markConnectionLive('conn-dup-0001');
    bus.publish({ type: 'status', sessionId: 'S1', status: 'thinking' });
    expect(next.chunks).toHaveLength(2); // its heartbeat + the frame
    expect(old.chunks).toEqual([]);
  });
});

describe('publishers and the legacy SSE route on the bus', () => {
  const VPS = 'vps-syncbus';
  const S1 = 'a'.repeat(32);
  const S2 = 'b'.repeat(32);
  let bus: Bus;

  beforeAll(async () => {
    wipeGlobals();
    vi.resetModules();
    const dbMod = await import('@/lib/db');
    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
    migrate(dbMod.db, { migrationsFolder: './drizzle' });
    dbMod.db.insert(dbMod.vpsFolders).values({ id: 'default', name: 'default', position: 0 })
      .onConflictDoNothing().run();
    dbMod.db.insert(dbMod.vps).values({ id: VPS, name: 'v', ip: '127.0.0.1', sshUser: 'root' })
      .onConflictDoNothing().run();
    for (const id of [S1, S2]) {
      dbMod.db.insert(dbMod.agentSessions).values({
        id, vpsId: VPS, name: id.slice(0, 4), cwd: '/tmp', status: 'active',
      }).onConflictDoNothing().run();
    }
    bus = await import('@/lib/server/sync/syncBus');
  });
  afterAll(() => { wipeGlobals(); });

  it('sessionOps publishes through the bus; session subscribers skip session-less frames', async () => {
    const ops = await vi.importActual<typeof import('@/lib/server/agent/sessionOps')>(
      '@/lib/server/agent/sessionOps');
    const got: Array<Record<string, unknown>> = [];
    const off = ops.subscribeGlobalSessionEvents((ev) => { got.push(ev as unknown as Record<string, unknown>); });
    const frameLog: string[] = [];
    const offFrames = bus.subscribeFrames((f) => { frameLog.push(text(f.chunk)); });
    try {
      const before = bus.currentRev().rev;
      ops.emitGlobalTabsChanged();
      bus.publish({ type: 'install_finished', installId: 'i', vpsId: VPS, vpsName: 'v', status: 'success' });
      expect(got).toEqual([{ type: 'tabs_changed', sessionId: 'tabs' }]);
      expect(frameLog[0]).toBe(`id: ${bus.epoch()}.${before + 1}\ndata: {"type":"tabs_changed","sessionId":"tabs"}\n\n`);
      expect(bus.currentRev().rev).toBe(before + 2);
    } finally { off(); offFrames(); }
  });

  it('model notices are published as a LOW bus frame when the ledger changes', async () => {
    const { observeModels, getModelNotices } = await import('@/lib/server/hub/modelNotices');
    const seen: Array<{ route: string; data: Record<string, unknown> }> = [];
    const off = bus.subscribeFrames((f) => { seen.push({ route: f.route, data: frames(text(f.chunk))[0].data }); });
    try {
      observeModels('codex', [{ id: 'gpt-base', label: 'gpt-base' }]); // silent baseline, still a write
      observeModels('codex', [{ id: 'gpt-next', label: 'gpt-next' }]);
      expect(seen.map((s) => s.route)).toEqual(['low', 'low']);
      expect(seen[1].data).toEqual({ type: 'model_notices', notices: getModelNotices() });
    } finally { off(); }
  });

  it('legacy route: snapshot without ids, then a heartbeat at currentRev, then id-stamped bus frames', async () => {
    const { GET } = await import('@/app/api/events/route');
    const ac = new AbortController();
    const res = await GET(new Request(
      `http://localhost/api/events?conn=conn-route-0001&focus=${S1}&focusSeq=1`,
      { signal: ac.signal },
    ));
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    const reader = res.body!.getReader();
    let buf = '';
    const readUntil = async (pred: (s: string) => boolean) => {
      while (!pred(buf)) {
        const r = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout; got: ${buf}`)), 2000)),
        ]);
        if (r.done) throw new Error('stream ended');
        buf += text(r.value);
      }
    };
    try {
      await readUntil((s) => s.includes('"type":"heartbeat"'));
      const snap = frames(buf);
      const hbIdx = snap.findIndex((f) => f.data.type === 'heartbeat');
      expect(hbIdx).toBe(snap.length - 1);
      expect(snap.slice(0, hbIdx).every((f) => f.id === null)).toBe(true);
      expect(snap.slice(0, hbIdx).map((f) => f.data.type)).toEqual(
        expect.arrayContaining(['model_notices', 'vps_status', 'status']),
      );
      expect(snap[hbIdx].id).toBe(`${bus.epoch()}.${bus.currentRev().rev}`);

      buf = '';
      const r1 = bus.publish({ type: 'status', sessionId: S2, status: 'thinking' });            // low
      bus.publish({ type: 'assistant_text', sessionId: S2, delta: 'not focused here' });          // other focus
      const r3 = bus.publish({ type: 'assistant_text', sessionId: S1, delta: 'focused' });        // focused
      const r4 = bus.publish({ type: 'install_started', installId: 'i2', vpsId: VPS, vpsName: 'v', status: 'running' });
      await readUntil((s) => s.includes('install_started'));
      const live = frames(buf);
      expect(live.map((f) => f.id)).toEqual([r1, r3, r4].map((r) => `${bus.epoch()}.${r}`));
      expect(live.map((f) => f.data.type)).toEqual(['status', 'assistant_text', 'install_started']);
      expect(live[1].data).toEqual({ type: 'assistant_text', sessionId: S1, delta: 'focused' });
    } finally {
      ac.abort();
      reader.releaseLock();
    }
    // The abort unregistered the connection: no heartbeat target left.
    const conns = await import('@/lib/server/agent/eventConnections');
    expect(conns.pushHeartbeatTo('conn-route-0001')).toBe(false);
  });
});
