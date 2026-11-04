import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SSE registry identity (CLAUDE.md §14.15, G8): a connection is its STREAM
// instance. A reconnect with the same connId closes and replaces the old stream,
// and the old stream's late close can never unregister the replacement — the
// measured zombie conn (registered, heartbeating, receiving nothing, every focus
// POST answered `ok:false`). Delivery rides the sync bus router (C11): a conn
// receives bus frames only once its route marked it live. The legacy SSE route
// tests moved to eventsRouteLegacy.test.ts (C12).

const bus = vi.hoisted(() => {
  const subs = new Set<(ev: any) => void>();
  return {
    subs,
    emit(ev: any) { for (const cb of [...subs]) cb(ev); },
    markSessionRead: vi.fn(),
    streams: new Map<string, { status: string; runningBgTaskCount(): number }>(),
    noticesThrow: false,
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
  listInstalls: () => [],
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

import {
  focusCountFor, isBeingWatched, markConnectionLive, registerConnection, setConnectionFocus,
} from '@/lib/server/agent/eventConnections';
import { publish } from '@/lib/server/sync/syncBus';


describe('registerConnection identity (G8)', () => {
  beforeEach(() => { bus.markSessionRead.mockReset(); });

  it('a second stream on the same connId closes the first once; its late unregister leaves the second registered', async () => {
    const sendA = vi.fn();
    const sendB = vi.fn();
    let unregA: () => void = () => {};
    // The route's close() calls its own unregister, synchronously.
    const closeA = vi.fn(() => unregA());
    const closeB = vi.fn();
    unregA = registerConnection({
      connId: 'identity-conn-1', send: sendA, close: closeA,
      initialFocus: 'S1', initialFocusSeq: 1, initialVisible: true,
    });
    const unregB = registerConnection({
      connId: 'identity-conn-1', send: sendB, close: closeB,
      initialFocus: 'S1', initialFocusSeq: 1, initialVisible: true,
    });
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeA).toHaveBeenCalledWith('superseded');
    expect(closeB).not.toHaveBeenCalled();
    expect(markConnectionLive('identity-conn-1')).toBe(true);

    // The superseded stream's abort/cancel fires late — must be a no-op for B.
    unregA();
    unregA();
    expect(focusCountFor('S1')).toBe(1);

    publish({ type: 'assistant_text', sessionId: 'S1', delta: 'hi' });
    publish({ type: 'status', sessionId: 'S9', status: 'active' });
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).toHaveBeenCalledTimes(2);

    // A focus POST on the replacement applies (it is registered).
    const { POST } = await import('@/app/api/focus/route');
    const res = await POST(new Request('http://localhost/api/focus', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conn: 'identity-conn-1', sessionId: 'S2', focusSeq: 2, visible: true }),
    }));
    expect(await res.json()).toEqual({
      ok: true, applied: true, focus: 'S2', focusSeq: 2, sync: expect.objectContaining({ rev: expect.any(Number) }),
    });
    expect(bus.markSessionRead).toHaveBeenCalledWith('S2');

    unregB();
    expect(focusCountFor('S2')).toBe(0);
    expect(setConnectionFocus('identity-conn-1', 'S3', 3).ok).toBe(false);
    expect(closeB).not.toHaveBeenCalled();
  });

  it('a superseded stream whose close is a no-op is still detached from the bus', () => {
    const sendA = vi.fn();
    const sendB = vi.fn();
    const unregA = registerConnection({ connId: 'identity-conn-2', send: sendA, initialFocus: 'S1' });
    markConnectionLive('identity-conn-2');
    const unregB = registerConnection({ connId: 'identity-conn-2', send: sendB, initialFocus: 'S1' });
    markConnectionLive('identity-conn-2');
    publish({ type: 'assistant_text', sessionId: 'S1', delta: 'x' });
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).toHaveBeenCalledTimes(1);
    unregA();
    expect(focusCountFor('S1')).toBe(1);
    unregB();
    expect(focusCountFor('S1')).toBe(0);
    publish({ type: 'assistant_text', sessionId: 'S1', delta: 'y' });
    expect(sendB).toHaveBeenCalledTimes(1);
  });

  it('a push conn gets nothing before it is live, then the shared bus chunk (no per-conn subscription)', () => {
    const chunks: Uint8Array[] = [];
    const unreg = registerConnection({ connId: 'identity-conn-3', push: (c) => { chunks.push(c); }, initialFocus: 'S1' });
    expect(bus.subs.size).toBe(0);
    expect(focusCountFor('S1')).toBe(1);
    publish({ type: 'assistant_text', sessionId: 'S1', delta: 'early' });
    expect(chunks).toHaveLength(0);
    markConnectionLive('identity-conn-3');           // + its first heartbeat
    publish({ type: 'assistant_text', sessionId: 'S1', delta: 'late' });
    expect(chunks).toHaveLength(2);
    expect(new TextDecoder().decode(chunks[1])).toContain('"delta":"late"');
    unreg();
    expect(focusCountFor('S1')).toBe(0);
  });
});

describe('setConnectionFocus sequencing', () => {
  let unreg: () => void = () => {};
  afterEach(() => unreg());

  it('seq < cur is not applied', () => {
    unreg = registerConnection({ connId: 'seq-conn-1', send: () => {}, initialFocus: 'A', initialFocusSeq: 5 });
    expect(setConnectionFocus('seq-conn-1', 'B', 4)).toEqual({ ok: true, applied: false, focus: 'A', focusSeq: 5 });
    expect(focusCountFor('A')).toBe(1);
  });

  it('seq === cur on the same session re-applies presence idempotently (applied:true)', () => {
    // Own session ids: an earlier test's attended unregister leaves ITS grace
    // on 'A', which another conn's report no longer cancels.
    unreg = registerConnection({
      connId: 'seq-conn-2', send: () => {}, initialFocus: 'A2', initialFocusSeq: 5, initialVisible: false,
    });
    // Hidden ⇒ a finish is not "watched"; the same POST re-sent visible is.
    expect(setConnectionFocus('seq-conn-2', 'A2', 5, true)).toEqual({ ok: true, applied: true, focus: 'A2', focusSeq: 5 });
    return import('@/lib/server/agent/eventConnections').then(({ isBeingWatched }) => {
      expect(isBeingWatched('A2')).toBe(true);
      expect(setConnectionFocus('seq-conn-2', 'A2', 5, false)).toMatchObject({ applied: true });
      expect(isBeingWatched('A2')).toBe(false);
    });
  });

  it('seq === cur on the same session with routingOnly leaves presence untouched', async () => {
    const { isBeingWatched } = await import('@/lib/server/agent/eventConnections');
    unreg = registerConnection({
      connId: 'seq-conn-3', send: () => {}, initialFocus: 'A3', initialFocusSeq: 5, initialVisible: false,
    });
    expect(setConnectionFocus('seq-conn-3', 'A3', 5, true, { routingOnly: true }))
      .toEqual({ ok: true, applied: true, focus: 'A3', focusSeq: 5 });
    expect(isBeingWatched('A3')).toBe(false);
  });

  it('seq === cur on another session is not applied', () => {
    unreg = registerConnection({ connId: 'seq-conn-4', send: () => {}, initialFocus: 'A', initialFocusSeq: 5 });
    expect(setConnectionFocus('seq-conn-4', 'B', 5)).toEqual({ ok: true, applied: false, focus: 'A', focusSeq: 5 });
    expect(focusCountFor('B')).toBe(0);
  });

  it('seq > cur applies; routingOnly moves focus/focusSeq only', async () => {
    const { isBeingWatched } = await import('@/lib/server/agent/eventConnections');
    unreg = registerConnection({
      connId: 'seq-conn-5', send: () => {}, initialFocus: 'A', initialFocusSeq: 5, initialVisible: false,
    });
    expect(setConnectionFocus('seq-conn-5', 'B', 6, true, { routingOnly: true }))
      .toEqual({ ok: true, applied: true, focus: 'B', focusSeq: 6 });
    expect(focusCountFor('B')).toBe(1);
    expect(isBeingWatched('B')).toBe(false);   // still hidden: presence untouched
    expect(setConnectionFocus('seq-conn-5', 'C', 7, true))
      .toEqual({ ok: true, applied: true, focus: 'C', focusSeq: 7 });
    expect(isBeingWatched('C')).toBe(true);
  });

  it('an unknown conn is ok:false and is never created', () => {
    expect(setConnectionFocus('seq-conn-unknown', 'A', 1)).toEqual({ ok: false, applied: false, focus: null, focusSeq: 0 });
    expect(focusCountFor('A')).toBe(0);
  });
});
