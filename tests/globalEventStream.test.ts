import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource, installFakeBrowser, lastEs, sinceOf, type FakeBrowser } from './helpers/fakeSse';

// THE transport (app/globalEventStream.ts, CLAUDE.md §9/§14.24) driven
// through stubbed window/document/EventSource/fetch with fake timers: manual
// since-reconnects, the SSR stamp on the first connect, NO silence reload,
// the hello watchdog and degraded mode, build-id skew without losing drafts.

const E = 1_700_000_000_000;
type Transport = typeof import('@/app/globalEventStream');
let gse: Transport;
let browser: FakeBrowser;
let focusAnswers: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  focusAnswers = [];
  browser = installFakeBrowser({
    fetch: (url) => (url === '/api/focus' ? focusAnswers.shift() ?? { ok: true } : { ok: true }),
  });
  gse = await import('@/app/globalEventStream');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function resyncTo(es: FakeEventSource, r: number, reason = 'first', buildId = 'b1') {
  es.send({ type: 'sync_hello', proto: 2, mode: 'resync', reason, epoch: E, rev: r, buildId });
  es.send({ type: 'sync_summaries', sessions: [] });
  es.send({ type: 'sync_vps', vps: [] });
  es.send({ type: 'sync_installs', running: [] });
  es.send({ type: 'model_notices', notices: { revision: 1, notices: [] } });
  es.send({ type: 'sync_snapshot_end', rev: r }, `${E}.${r}`);
}

describe('globalEventStream', () => {
  it('a stream opened during a pending backoff (setFocus) is still closed on its own error, then reconnected manually', async () => {
    gse.initSyncPosition({ epoch: E, rev: 10, buildId: 'b1' });
    gse.subscribeAll(() => {});
    const a = lastEs();
    a.open();
    a.fail();                                     // backoff armed
    expect(a.closed).toBe(true);
    void gse.setFocus('sess-B');                  // opens B before the timer fires
    const b = lastEs();
    expect(b).not.toBe(a);
    b.fail();
    expect(b.closed).toBe(true);                  // no CONNECTING passthrough
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeEventSource.all.length).toBeGreaterThanOrEqual(3);
    expect(lastEs().url).toContain('focus=sess-B');
  });

  it('the first connect resumes from the SSR stamp (proto=2&since=E.R)', () => {
    gse.initSyncPosition({ epoch: E, rev: 42, buildId: 'b1' });
    gse.subscribeAll(() => {});
    expect(lastEs().url).toContain('proto=2');
    expect(sinceOf(lastEs())).toBe(`${E}.42`);
  });

  it('onerror ALWAYS closes and reconnects (jittered first retry) with since = the last delivered rev', async () => {
    gse.initSyncPosition({ epoch: E, rev: 10, buildId: 'b1' });
    gse.subscribeAll(() => {});
    const es = lastEs();
    es.open();
    es.send({ type: 'sync_hello', proto: 2, mode: 'resume', epoch: E, rev: 13, from: 10, buildId: 'b1' });
    es.send({ type: 'status', sessionId: 's', status: 'active' }, `${E}.11`);
    es.send({ type: 'status', sessionId: 's', status: 'thinking' }, `${E}.12`);
    es.readyState = 0;                            // CONNECTING: no passthrough either
    es.fail();
    expect(es.closed).toBe(true);
    expect(FakeEventSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(FakeEventSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(sinceOf(lastEs())).toBe(`${E}.12`);
    // The next failures back off 1→2→4→6 s ±20 %.
    for (const d of [1, 2, 3, 4].map((n) => gse.backoffDelay(n, () => 0.5))) expect([1000, 2000, 4000, 6000]).toContain(d);
    expect(gse.backoffDelay(1, () => 0)).toBe(800);
    expect(gse.backoffDelay(9, () => 1)).toBe(7200);
  });

  it('NO location.reload after 25 s of silence: the watchdog reconnects instead', async () => {
    gse.subscribeAll(() => {});
    const es = lastEs();
    es.open();
    resyncTo(es, 5);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(es.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    const next = lastEs();
    expect(next).not.toBe(es);
    next.open();
    resyncTo(next, 6, 'gap');                       // the first frame after the outage
    await vi.advanceTimersByTimeAsync(1_000);
    expect(browser.reload).not.toHaveBeenCalled();
  });

  it('two ok:false focus answers of one chain on an OPEN, hello-ed stream (a zombie) ⇒ reconnect', async () => {
    focusAnswers = [{ ok: false }, { ok: false }];
    const p = gse.setFocus('s1');
    lastEs().open();
    resyncTo(lastEs(), 1);
    await p;
    expect(FakeEventSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(FakeEventSource.all[0].closed).toBe(true);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(lastEs().url).toContain('focus=s1');
  });

  it('resync listeners fire once per snapshot end (reason first included); nothing fires on a resume', () => {
    const resyncs: unknown[] = [];
    const ready: number[] = [];
    let reconnects = 0;
    gse.subscribeResync((r) => resyncs.push(r));
    gse.subscribeSyncReady(() => ready.push(1));
    gse.subscribeReconnect(() => { reconnects++; });
    gse.subscribeAll(() => {});
    const es = lastEs();
    es.open();
    resyncTo(es, 7);
    expect(resyncs).toEqual([{ rev: { epoch: E, rev: 7 }, reason: 'first' }]);
    expect(reconnects).toBe(1);
    expect(gse.getSyncPosition()).toEqual({ epoch: E, lastRev: 7 });
    gse.requestReconnect('test');
    const again = lastEs();
    expect(sinceOf(again)).toBe(`${E}.7`);
    again.open();
    again.send({ type: 'sync_hello', proto: 2, mode: 'resume', epoch: E, rev: 9, from: 7, buildId: 'b1' });
    again.send({ type: 'status', sessionId: 's', status: 'active' }, `${E}.8`);
    again.send({ type: 'sync_replay_end', rev: 9 }, `${E}.8`);
    expect(resyncs).toHaveLength(1);
    expect(reconnects).toBe(1);
    expect(ready).toHaveLength(2);
    expect(gse.getSyncPosition().lastRev).toBe(9);
  });

  it('listeners get {bytes, at, rev, catchUp}; replayed frames are catch-up; duplicates are dropped', () => {
    const got: Array<{ type: string; rev: unknown; catchUp: boolean }> = [];
    gse.initSyncPosition({ epoch: E, rev: 10, buildId: 'b1' });
    gse.subscribeSession('s', (ev, r) => got.push({ type: ev.type, rev: r.rev, catchUp: r.catchUp }));
    const es = lastEs();
    es.open();
    es.send({ type: 'sync_hello', proto: 2, mode: 'resume', epoch: E, rev: 11, from: 10, buildId: 'b1' });
    es.send({ type: 'assistant_text', sessionId: 's', delta: 'a' }, `${E}.11`);
    es.send({ type: 'sync_replay_end', rev: 11 }, `${E}.11`);
    es.send({ type: 'assistant_text', sessionId: 's', delta: 'a' }, `${E}.11`);   // duplicate
    es.send({ type: 'assistant_text', sessionId: 's', delta: 'b' }, `${E}.12`);
    expect(got).toEqual([
      { type: 'assistant_text', rev: { epoch: E, rev: 11 }, catchUp: true },
      { type: 'assistant_text', rev: { epoch: E, rev: 12 }, catchUp: false },
    ]);
  });

  it('getSessionFrameRev advances on a session_summary frame (any type carrying the id)', () => {
    gse.subscribeAll(() => {});
    const es = lastEs();
    es.open();
    resyncTo(es, 3);
    expect(gse.getSessionFrameRev('s1')).toBeNull();
    es.send({ type: 'session_summary', sessionId: 's1', summary: null }, `${E}.4`);
    expect(gse.getSessionFrameRev('s1')).toEqual({ epoch: E, rev: 4 });
    es.send({ type: 'status', sessionId: 's1', status: 'active' }, `${E}.6`);
    expect(gse.getSessionFrameRev('s1')).toEqual({ epoch: E, rev: 6 });
    expect(gse.getFocusTicket().conn).toEqual(expect.any(String));
  });

  it('3 hello-less opens ⇒ degraded (legacy frames delivered rev:null), then NO reconnect at 10 s; a sync_hello leaves it', async () => {
    const got: unknown[] = [];
    gse.subscribeAll((ev, r) => got.push([ev.type, r.rev]));
    for (let i = 1; i <= 3; i++) {
      expect(FakeEventSource.all).toHaveLength(i);
      lastEs().open();
      lastEs().send({ type: 'vps_status', sessionId: 'v', agentStatus: 'ok' });
      await vi.advanceTimersByTimeAsync(10_001);
    }
    expect(gse.isDegraded()).toBe(true);
    expect(FakeEventSource.all).toHaveLength(3);
    expect(got[0]).toEqual(['vps_status', null]);
    // Degraded: the hello watchdog is off; the legacy heartbeat keeps it alive.
    for (let i = 0; i < 5; i++) {
      lastEs().send({ type: 'heartbeat', ts: i });
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(FakeEventSource.all).toHaveLength(3);
    // The hub is back on the sync protocol.
    const degradedFlips: boolean[] = [];
    gse.subscribeDegraded((d) => degradedFlips.push(d));
    gse.requestReconnect('test');
    lastEs().open();
    resyncTo(lastEs(), 2);
    expect(gse.isDegraded()).toBe(false);
    expect(degradedFlips).toEqual([false]);
  });

  it('no sync_hello within 10 s of onopen (before degraded) ⇒ reconnect', async () => {
    gse.subscribeAll(() => {});
    lastEs().open();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(FakeEventSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(FakeEventSource.all).toHaveLength(2);
  });

  it('a new build fires the mismatch callback; the auto-reload waits while a draft exists', async () => {
    const drafts = await import('@/app/inputDraftStore');
    const builds: string[] = [];
    gse.initSyncPosition({ epoch: E, rev: 1, buildId: 'old' });
    gse.subscribeBuildMismatch((b) => builds.push(b));
    gse.subscribeAll(() => {});
    drafts.setDraft('s1', 'half-written message');
    const es = lastEs();
    es.open();
    resyncTo(es, 2, 'epoch', 'new');
    expect(builds).toEqual(['new']);
    // Hidden for > 30 s and idle: still no reload while the draft exists.
    browser.doc.visibilityState = 'hidden';
    browser.fire('document', 'visibilitychange');
    for (let i = 0; i < 12; i++) {
      es.send({ type: 'heartbeat', ts: i }, `${E}.2`);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(browser.reload).not.toHaveBeenCalled();
    drafts.setDraft('s1', '');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });

  it('a visible, recently used tab keeps the chip instead of reloading', async () => {
    gse.initSyncPosition({ epoch: E, rev: 1, buildId: 'old' });
    gse.subscribeAll(() => {});
    const es = lastEs();
    es.open();
    resyncTo(es, 2, 'first', 'new');
    expect(gse.getBuildMismatch()).toBe('new');
    browser.fire('window', 'pointerdown');
    for (let i = 0; i < 6; i++) {
      es.send({ type: 'heartbeat', ts: i }, `${E}.2`);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(browser.reload).not.toHaveBeenCalled();
  });
  it('a stream stuck in CONNECTING (no onopen/onerror) is reconnected by the silence watchdog', async () => {
    gse.subscribeAll(() => {});
    // The page's first connect never opens.
    await vi.advanceTimersByTimeAsync(gse.STALE_MS + 5_000);
    expect(FakeEventSource.all[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeEventSource.all.length).toBe(2);
    // Opened, then stale: the reconnect hangs in CONNECTING again.
    const second = lastEs();
    second.open();
    resyncTo(second, 5);
    await vi.advanceTimersByTimeAsync(gse.STALE_MS + 5_000);
    expect(second.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    const third = lastEs();
    expect(third).not.toBe(second);
    await vi.advanceTimersByTimeAsync(gse.STALE_MS + 5_000);
    expect(third.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(lastEs()).not.toBe(third);
    // Hung connects are not hello-less opens: never degraded.
    expect(gse.isDegraded()).toBe(false);
  });

  it('the build auto-reload also waits for a dirty editor tab and marked unsaved inputs', async () => {
    const drafts = await import('@/app/inputDraftStore');
    const tabs = await import('@/app/tabStore');
    gse.initSyncPosition({ epoch: E, rev: 1, buildId: 'old' });
    gse.subscribeAll(() => {});
    tabs.setTabDirty('t1', true);
    drafts.markUnsavedInput('question', true);
    const es = lastEs();
    es.open();
    resyncTo(es, 2, 'epoch', 'new');
    browser.doc.visibilityState = 'hidden';
    browser.fire('document', 'visibilitychange');
    for (let i = 0; i < 12; i++) {
      es.send({ type: 'heartbeat', ts: i }, `${E}.2`);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(browser.reload).not.toHaveBeenCalled();
    tabs.setTabDirty('t1', false);
    es.send({ type: 'heartbeat', ts: 99 }, `${E}.2`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(browser.reload).not.toHaveBeenCalled();
    drafts.markUnsavedInput('question', false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });

  it('several newer-epoch HTTP answers before the new hello ⇒ ONE reconnect', async () => {
    gse.initSyncPosition({ epoch: E, rev: 1, buildId: 'b1' });
    gse.subscribeAll(() => {});
    const es = lastEs();
    es.open();
    es.send({ type: 'sync_hello', proto: 2, mode: 'resume', epoch: E, rev: 1, from: 1, buildId: 'b1' });
    expect(gse.noteHttpSync({ epoch: E + 5, rev: 3 })).toBe('newer');
    expect(FakeEventSource.all).toHaveLength(2);
    gse.requestReconnect('epoch');              // a second trigger for the same answer
    gse.noteHttpSync({ epoch: E + 5, rev: 4 }); // the list seed
    expect(FakeEventSource.all).toHaveLength(2);
    expect(lastEs().closed).toBe(false);
    // Once the new stream said hello, a later epoch bump reconnects again.
    lastEs().open();
    resyncTo(lastEs(), 3, 'epoch');
    gse.requestReconnect('epoch');
    expect(FakeEventSource.all).toHaveLength(3);
  });

  it('a stream closed after its hello (prologue error, outbox cap) backs off 1→2→4→6 s; a completed prologue resets it', async () => {
    gse.subscribeAll(() => {});
    const auth = () => browser.fetch.mock.calls.filter((c) => c[0] === '/api/auth/check').length;
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const es = lastEs();
      es.open();
      es.send({ type: 'sync_hello', proto: 2, mode: 'resync', reason: 'first', epoch: E, rev: 5, buildId: 'b1' });
      es.send({ type: 'sync_summaries', sessions: [] });
      es.fail();                                  // closed before sync_snapshot_end
      const n = FakeEventSource.all.length;
      let waited = 0;
      while (FakeEventSource.all.length === n && waited < 20_000) { await vi.advanceTimersByTimeAsync(50); waited += 50; }
      gaps.push(waited);
    }
    expect(gaps[0]).toBeLessThanOrEqual(1_500);
    expect(gaps[1]).toBeGreaterThanOrEqual(800);
    expect(gaps[2]).toBeGreaterThanOrEqual(1_600);
    expect(gaps[3]).toBeGreaterThanOrEqual(3_200);
    expect(gaps[4]).toBeGreaterThanOrEqual(4_800);
    expect(gse.getStreamHealth().attempt).toBeGreaterThanOrEqual(6);
    expect(auth()).toBeGreaterThan(0);            // the 401 probe is reachable again
    // A stream that completes its prologue is healthy: the ladder restarts.
    const ok = lastEs();
    ok.open();
    resyncTo(ok, 6);
    expect(gse.getStreamHealth().attempt).toBe(0);
  });

  it('navigator.onLine === false still retries (slowly): a reachable localhost hub is not stranded', async () => {
    gse.subscribeAll(() => {});
    const a = lastEs();
    a.open();
    resyncTo(a, 3);
    vi.stubGlobal('navigator', { onLine: false });
    a.fail();
    expect(FakeEventSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(FakeEventSource.all).toHaveLength(1);  // slowed to the last ladder step
    await vi.advanceTimersByTimeAsync(4_000);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(lastEs().closed).toBe(false);
  });

  // W4-review: attention proofs lost while the conn is not registered.
  const focusPosts = () => browser.fetch.mock.calls
    .filter(([url]) => url === '/api/focus')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

  it('a tab turning visible while its stream is down re-POSTs its attended focus once the new stream says hello', async () => {
    // A hub that applies every focus POST (no retry chain muddying the count).
    browser.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const b = url === '/api/focus' ? JSON.parse(String(init?.body)) : {};
      return { status: 200, json: async () => ({ ok: true, focus: b.sessionId, focusSeq: b.focusSeq }) };
    });
    void gse.setFocus('S');
    const a = lastEs();
    a.open();
    resyncTo(a, 1);
    browser.doc.visibilityState = 'hidden';
    browser.fire('document', 'visibilitychange');
    a.fail();                                         // es = null, backoff pending
    await vi.advanceTimersByTimeAsync(0);
    browser.fetch.mockClear();
    browser.doc.visibilityState = 'visible';
    browser.fire('document', 'visibilitychange');     // no POST: no stream
    await vi.advanceTimersByTimeAsync(20_000);
    const b = lastEs();
    expect(b).not.toBe(a);
    const q = new URL(b.url, 'http://x').searchParams;
    expect(q.get('attentive')).toBe('1');
    expect(Number(q.get('attentiveAgeMs'))).toBeGreaterThanOrEqual(0);
    expect(focusPosts().filter((p) => p.sessionId === 'S' && p.attentive === true)).toEqual([]);
    b.open();
    resyncTo(b, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(focusPosts()).toContainEqual(expect.objectContaining({ conn: expect.any(String), sessionId: 'S', attentive: true }));
  });

  it('an idle device re-POSTs nothing on hello; a URL carries attentive=0 without an age', async () => {
    void gse.setFocus('S');
    const a = lastEs();
    expect(new URL(a.url, 'http://x').searchParams.get('attentiveAgeMs')).toBeNull();
    a.open();
    await vi.advanceTimersByTimeAsync(0);
    browser.fetch.mockClear();
    resyncTo(a, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(focusPosts()).toEqual([]);
  });

  it('an attention proof answered ok:false (conn not registered yet) is retried by the next input', async () => {
    void gse.setFocus('S');
    const a = lastEs();
    a.open();
    resyncTo(a, 1);
    await vi.advanceTimersByTimeAsync(0);
    browser.fetch.mockClear();
    focusAnswers = [{ ok: false }];
    browser.fire('window', 'pointerdown');            // idle → active: proof, lost
    await vi.advanceTimersByTimeAsync(1_000);
    browser.fire('window', 'pointerdown');            // 1 s later: proves again
    await vi.advanceTimersByTimeAsync(0);
    expect(focusPosts().filter((p) => p.kind === 'attention')).toHaveLength(2);
    browser.fire('window', 'pointerdown');            // answered ok: throttled again
    await vi.advanceTimersByTimeAsync(0);
    expect(focusPosts().filter((p) => p.kind === 'attention')).toHaveLength(2);
  });
});
