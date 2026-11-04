import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// "Viewed" = ATTENDED (CLAUDE.md §14.47, I10): a conn suppresses or clears the
// finished-unread marker only while visible AND with input on that device
// within ATTENTION_WINDOW_MS (a legacy client that never reports attention:
// visible). A forgotten, visible desktop tab used to mute the marker for every
// other device. Real eventConnections + sessionOps + focus route on a hermetic
// DB; only the transport/notification side channels are mocked.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({ userId: 'test-user' })) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: vi.fn() }));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: vi.fn(async () => {}) }));
vi.mock('@/lib/server/hub/codexBgState', () => ({ readCodexBgState: vi.fn(async () => []) }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: vi.fn(async () => {}),
  sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: vi.fn(async () => {}),
  sendPlainToTelegram: vi.fn(async () => {}),
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {},
    call: async () => ({ status: 'active' }),
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'attvps';
const SID = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
// Every test starts an hour after the previous one: grace stamps of an earlier
// test (its afterEach unregisters) must lie in the PAST, never the future.
let base = Date.UTC(2026, 9, 15, 12, 0, 0);

let db: any;
let schema: any;
let ec: typeof import('@/lib/server/agent/eventConnections');
let ops: typeof import('@/lib/server/agent/sessionOps');
let POST: (req: Request) => Promise<Response>;
const unregs: Array<() => void> = [];
const busEvents: any[] = [];

function at(ms: number) { vi.setSystemTime(base + ms); }

function register(connId: string, o: { focus?: string | null; visible?: boolean; attentive?: boolean; ageMs?: number } = {}) {
  const unreg = ec.registerConnection({
    connId, send: () => {}, initialFocus: o.focus ?? SID, initialFocusSeq: 1,
    initialVisible: o.visible ?? true, initialAttentive: o.attentive, initialAttentiveAgeMs: o.ageMs,
  });
  unregs.push(unreg);
  return unreg;
}

function post(body: Record<string, unknown>) {
  return POST(new Request('http://localhost/api/focus', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

function unreadStop(id = SID): number {
  return db.select().from(schema.agentSessions).all().find((r: any) => r.id === id)?.unreadStop;
}

function finishTurn(seq: number) {
  const stream = new ops.SessionStream({
    id: SID, vpsId: VPS_ID, vpsName: 'test-vps', name: 'build', status: 'thinking',
    permissionMode: 'normal', nativeSessionId: null, kind: 'claude',
  }) as any;
  stream._onAgentEvent({ event: 'stop', session_id: SID, seq, subtype: 'end_turn' });
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test-vps', ip: '127.0.0.1', sshUser: 'root' })
    .onConflictDoNothing().run();
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ops = await import('@/lib/server/agent/sessionOps');
  ec = await import('@/lib/server/agent/eventConnections');
  ({ POST } = await import('@/app/api/focus/route'));
  ops.subscribeGlobalSessionEvents((ev) => busEvents.push(ev));
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  base += 60 * 60_000;
  at(0);
  busEvents.length = 0;
  db.delete(schema.sessionMessages).run();
  db.delete(schema.agentSessions).run();
  for (const id of [SID, OTHER]) {
    db.insert(schema.agentSessions).values({ id, vpsId: VPS_ID, cwd: '/tmp', name: 'build', status: 'active' }).run();
  }
});

afterEach(() => {
  while (unregs.length) unregs.pop()!();
  vi.useRealTimers();
});

describe('attended viewing matrix', () => {
  it('the stop handler asks eventConnections (wired into hubHooks at import)', async () => {
    const { hubHooks } = await import('@/lib/server/agent/hubHooks');
    expect(hubHooks().focusChecker).toBeTypeOf('function');
    expect(ec.wasRecentlyViewed).toBe(ec.isBeingWatched);
  });

  it('a legacy conn (no attentive report) is attended while visible, whatever its idle time', () => {
    register('att-legacy-1');
    at(60 * 60_000);
    expect(ec.isBeingWatched(SID)).toBe(true);
    ec.setConnectionFocus('att-legacy-1', SID, 2, false);
    expect(ec.isBeingWatched(SID)).toBe(false);
  });

  it('a visible conn idle for more than 120 s is no longer watching', () => {
    register('att-idle-1', { attentive: true });
    at(ec.ATTENTION_WINDOW_MS - 1);
    expect(ec.isBeingWatched(SID)).toBe(true);
    at(ec.ATTENTION_WINDOW_MS);
    expect(ec.isBeingWatched(SID)).toBe(true);
    at(ec.ATTENTION_WINDOW_MS + 1);
    expect(ec.isBeingWatched(SID)).toBe(false);
  });

  it('attentive=0 watches nothing until an attention POST, which revives it and reads the focused session', async () => {
    db.update(schema.agentSessions).set({ unreadStop: 1 }).run();
    register('att-revive-1', { attentive: false });
    expect(ec.isBeingWatched(SID)).toBe(false);

    at(5_000);
    const res = await post({ conn: 'att-revive-1', kind: 'attention' });
    expect(await res.json()).toEqual({ ok: true });
    expect(ec.isBeingWatched(SID)).toBe(true);
    expect(unreadStop(SID)).toBe(0);
    expect(unreadStop(OTHER)).toBe(1);
    expect(busEvents).toContainEqual(expect.objectContaining({ type: 'session_unread', sessionId: SID, unread: false }));

    at(5_000 + ec.ATTENTION_WINDOW_MS + 1);
    expect(ec.isBeingWatched(SID)).toBe(false);
  });

  it('an attention POST on a hidden conn reads nothing and watches nothing; an unknown conn is ok:false', async () => {
    db.update(schema.agentSessions).set({ unreadStop: 1 }).run();
    register('att-hidden-1', { attentive: false, visible: false });
    expect(await (await post({ conn: 'att-hidden-1', kind: 'attention' })).json()).toEqual({ ok: true });
    expect(ec.isBeingWatched(SID)).toBe(false);
    expect(unreadStop(SID)).toBe(1);
    expect(await (await post({ conn: 'att-unknown-1', kind: 'attention' })).json()).toEqual({ ok: false });
    expect(unreadStop(SID)).toBe(1);
  });

  it('a focus POST: attentive:false reads nothing, attentive:true is a proof of attention and reads', async () => {
    db.update(schema.agentSessions).set({ unreadStop: 1 }).run();
    register('att-focus-1', { attentive: false, focus: OTHER });
    let res = await post({ conn: 'att-focus-1', sessionId: SID, focusSeq: 2, visible: true, attentive: false });
    expect(await res.json()).toMatchObject({ ok: true, applied: true, focus: SID });
    expect(ec.isBeingWatched(SID)).toBe(false);
    expect(unreadStop(SID)).toBe(1);

    res = await post({ conn: 'att-focus-1', sessionId: SID, focusSeq: 3, visible: true, attentive: true });
    expect(await res.json()).toMatchObject({ ok: true, applied: true, focus: SID });
    expect(ec.isBeingWatched(SID)).toBe(true);
    expect(unreadStop(SID)).toBe(0);
  });

  it('attentive:false never erases a newer attention report (out-of-order POSTs, FM9); idleness = the 120 s expiry', async () => {
    db.update(schema.agentSessions).set({ unreadStop: 1 }).run();
    // (a) the onopen re-POST (same seq, sent while idle) lands AFTER the
    // immediate idle→active attention POST.
    register('att-race-1', { attentive: false });
    at(1_000);
    expect(await (await post({ conn: 'att-race-1', kind: 'attention' })).json()).toEqual({ ok: true });
    expect(ec.isBeingWatched(SID)).toBe(true);
    at(1_050);
    const res = await post({ conn: 'att-race-1', sessionId: SID, focusSeq: 1, visible: true, attentive: false });
    expect(await res.json()).toMatchObject({ ok: true, applied: true, focus: SID });
    at(10_000);
    expect(ec.isBeingWatched(SID)).toBe(true);
    at(1_000 + ec.ATTENTION_WINDOW_MS + 1);
    expect(ec.isBeingWatched(SID)).toBe(false);

    // (b) a NEWER-seq visibility POST carrying `attentive:false` that lands
    // after an attention POST keeps the attention too.
    register('att-race-2', { attentive: false, focus: OTHER });
    at(200_000);
    ec.noteConnectionAttention('att-race-2');
    at(200_050);
    expect(ec.setConnectionFocus('att-race-2', OTHER, 2, true, { attentive: false }))
      .toMatchObject({ ok: true, applied: true });
    at(209_000);
    expect(ec.isBeingWatched(OTHER)).toBe(true);
    at(200_000 + ec.ATTENTION_WINDOW_MS + 1);
    expect(ec.isBeingWatched(OTHER)).toBe(false);
  });

  it('a native reconnect replaying a stale attentive=1 URL is cleared by the re-POSTed attentive:false', async () => {
    register('att-stale-url-1', { attentive: true });
    at(60 * 60_000);
    expect(ec.isBeingWatched(SID)).toBe(false);
    // EventSource reconnects by itself with the URL it was built with.
    register('att-stale-url-1', { attentive: true });
    at(60 * 60_000 + 50);
    expect(ec.setConnectionFocus('att-stale-url-1', SID, 1, true, { attentive: false }))
      .toMatchObject({ ok: true, applied: true });
    expect(ec.isBeingWatched(SID)).toBe(false);
    // A finish in that window lights the marker for every device.
    finishTurn(1);
    expect(unreadStop(SID)).toBe(1);

    // A POST's own proof is still never cleared by a later attentive:false.
    expect(ec.noteConnectionAttention('att-stale-url-1').ok).toBe(true);
    at(60 * 60_000 + 100);
    ec.setConnectionFocus('att-stale-url-1', SID, 1, true, { attentive: false });
    expect(ec.isBeingWatched(SID)).toBe(true);
  });

  it('12 s grace after an ATTENDED conn switches away or unregisters', () => {
    register('att-grace-1', { attentive: true });
    at(1_000);
    ec.setConnectionFocus('att-grace-1', OTHER, 2, true, { attentive: true });
    at(1_000 + 11_999);
    expect(ec.isBeingWatched(SID)).toBe(true);
    at(1_000 + 12_000);
    expect(ec.isBeingWatched(SID)).toBe(false);

    const unreg = register('att-grace-2', { attentive: true });
    at(20_000);
    unreg();
    at(20_000 + 11_999);
    expect(ec.isBeingWatched(SID)).toBe(true);
    at(20_000 + 12_000);
    expect(ec.isBeingWatched(SID)).toBe(false);
  });

  it('an idle or hidden conn leaving a session stamps no grace', () => {
    register('att-nograce-1', { attentive: true });
    at(ec.ATTENTION_WINDOW_MS + 1);
    ec.setConnectionFocus('att-nograce-1', OTHER, 2, true);
    expect(ec.isBeingWatched(SID)).toBe(false);

    const unreg = register('att-nograce-2', { visible: false });
    unreg();
    expect(ec.isBeingWatched(SID)).toBe(false);
  });

  it('a forgotten visible desktop tab no longer mutes the finish for the other devices', () => {
    register('att-desktop-1', { attentive: true });          // the desktop, then nobody touches it
    register('att-phone-1', { attentive: true, focus: OTHER }); // the phone, elsewhere

    at(30_000);
    finishTurn(1);                                            // watched: no marker
    expect(unreadStop(SID)).toBe(0);
    expect(busEvents.filter((e) => e.type === 'session_unread')).toEqual([]);

    at(5 * 60_000);
    finishTurn(2);                                            // the desktop is idle now
    expect(unreadStop(SID)).toBe(1);
    expect(busEvents).toContainEqual(expect.objectContaining({ type: 'session_unread', sessionId: SID, unread: true }));
  });

  it('a legacy (pre-attention) visible tab still suppresses the marker', () => {
    register('att-legacy-2');
    at(5 * 60_000);
    finishTurn(1);
    expect(unreadStop(SID)).toBe(0);
  });

  it('a focus POST dates the proof by the client input age, never extending the window past the client expiry', async () => {
    register('att-age-1', { attentive: true });                // input at t=0
    at(110_000);
    // A re-POST without new input: the client's last input is 110 s old.
    await post({ conn: 'att-age-1', sessionId: SID, focusSeq: 1, visible: true, attentive: true, attentiveAgeMs: 110_000 });
    at(ec.ATTENTION_WINDOW_MS + 1);
    expect(ec.isBeingWatched(SID)).toBe(false);
    at(200_000);
    finishTurn(1);
    expect(unreadStop(SID)).toBe(1);
  });

  it('an older-dated proof never moves a newer one back (FM9)', async () => {
    register('att-age-2', { attentive: false });
    at(100_000);
    ec.noteConnectionAttention('att-age-2');                   // input at t=100 s
    at(100_050);
    await post({ conn: 'att-age-2', sessionId: SID, focusSeq: 1, visible: true, attentive: true, attentiveAgeMs: 90_000 });
    at(100_000 + ec.ATTENTION_WINDOW_MS - 1);
    expect(ec.isBeingWatched(SID)).toBe(true);
  });

  it("another device's presence report never cancels the grace an attended device stamped", async () => {
    register('att-own-a', { attentive: true });
    register('att-own-b', { attentive: false });
    at(1_000);
    ec.setConnectionFocus('att-own-a', OTHER, 2, true, { attentive: true }); // A leaves SID
    expect(ec.isBeingWatched(SID)).toBe(true);
    await post({ conn: 'att-own-b', sessionId: SID, focusSeq: 1, visible: true, attentive: false });
    expect(ec.isBeingWatched(SID)).toBe(true);
    at(3_000);
    finishTurn(1);
    expect(unreadStop(SID)).toBe(0);
  });

  it('a reconnect URL grant is dated by the input age, never restarting the 120 s window', () => {
    register('att-url-age', { attentive: true, ageMs: 110_000 }); // last input 110 s ago
    at(9_000);
    expect(ec.isBeingWatched(SID)).toBe(true);
    at(10_001);
    expect(ec.isBeingWatched(SID)).toBe(false);
    finishTurn(1);
    expect(unreadStop(SID)).toBe(1);
  });

  describe('the leave grace covers only output the user saw', () => {
    function liveStream() {
      return new ops.SessionStream({
        id: SID, vpsId: VPS_ID, vpsName: 'test-vps', name: 'build', status: 'thinking',
        permissionMode: 'normal', nativeSessionId: null, kind: 'claude',
      }) as any;
    }

    it('leaving while the answer is still being written: a finish 3 s later is unread', () => {
      register('att-leave-mid', { attentive: true });
      const stream = liveStream();
      stream._onAgentEvent({ event: 'assistant_text', session_id: SID, seq: 1, delta: 'Here is ' });
      at(1_000);
      ec.setConnectionFocus('att-leave-mid', OTHER, 2, true, { attentive: true }); // leaves SID
      at(2_000);
      stream._onAgentEvent({ event: 'assistant_text', session_id: SID, seq: 2, delta: 'the answer.' });
      at(4_000);
      stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 3, subtype: 'end_turn' });
      expect(unreadStop(SID)).toBe(1);
    });

    it('a tool finishing after the user left counts as output too', () => {
      register('att-leave-tool', { attentive: true });
      const stream = liveStream();
      stream._onAgentEvent({ event: 'tool_use', session_id: SID, seq: 1, id: 't1', name: 'Bash', input: { command: 'ls' } });
      at(1_000);
      ec.setConnectionFocus('att-leave-tool', OTHER, 2, true, { attentive: true });
      at(3_000);
      stream._onAgentEvent({ event: 'tool_result', session_id: SID, seq: 2, tool_use_id: 't1', content: 'ok', is_error: false });
      at(4_000);
      stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 3, subtype: 'end_turn' });
      expect(unreadStop(SID)).toBe(1);
    });

    it('leaving after the last output: the late stop is still watched', () => {
      register('att-leave-after', { attentive: true });
      const stream = liveStream();
      stream._onAgentEvent({ event: 'assistant_text', session_id: SID, seq: 1, delta: 'Done.' });
      at(1_000);
      ec.setConnectionFocus('att-leave-after', OTHER, 2, true, { attentive: true });
      at(4_000);
      stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 2, subtype: 'end_turn' });
      expect(unreadStop(SID)).toBe(0);
    });

    it('isBeingWatched: a stamp counts only at or after the output time; unknown output = any stamp', () => {
      register('att-leave-unit', { attentive: true });
      at(5_000);
      ec.setConnectionFocus('att-leave-unit', OTHER, 2, true, { attentive: true });
      at(6_000);
      expect(ec.isBeingWatched(SID, 4_999 + base)).toBe(true);
      expect(ec.isBeingWatched(SID, 5_000 + base)).toBe(true);
      expect(ec.isBeingWatched(SID, 5_001 + base)).toBe(false);
      expect(ec.isBeingWatched(SID, null)).toBe(true);
      expect(ec.isBeingWatched(SID)).toBe(true);
    });
  });

  it('grace stamps of departed page loads stay bounded (pruned per session, not only past 512 sessions)', () => {
    for (let i = 0; i < 2_000; i++) {
      at(i * 60_000);
      const u = ec.registerConnection({
        connId: `att-churn-${i}`, send: () => {}, initialFocus: SID, initialFocusSeq: 1,
        initialVisible: true, initialAttentive: true,
      });
      at(i * 60_000 + 1_000);
      u();                                                  // attended unregister ⇒ a stamp
    }
    expect(ec.graceStampCount()).toBeLessThan(10);
    expect(ec.isBeingWatched(SID)).toBe(true);              // the last one is still in grace
    at(2_000 * 60_000 + 60_000);
    expect(ec.isBeingWatched(SID)).toBe(false);
    expect(ec.graceStampCount()).toBe(0);
  });
});
