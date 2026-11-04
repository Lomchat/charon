import { describe, expect, it } from 'vitest';
import { createWindowSync, type WindowReason } from '@/app/sync/windowSync';
import { TranscriptJournal } from '@/app/sync/transcriptJournal';
import {
  applyFrame, applySnapshot, createTranscriptState, type SessionFrame, type TranscriptState,
} from '@/app/sync/transcriptReducer';
import { readShowToolsPreference, transcriptViewFor, SHOW_TOOLS_STORAGE_KEY } from '@/app/chatVisibility';
import type { SessionWindowResponse } from '@/lib/types/api';
import type { TranscriptView } from '@/lib/transcriptRows';

const E = 1_700_000_000_000;
const rev = (r: number, epoch = E) => ({ epoch, rev: r });

function win(r: number, o: Partial<SessionWindowResponse> = {}): SessionWindowResponse {
  return {
    session: { id: 's1', kind: 'claude', status: 'active', vpsId: 'v1', permissionMode: 'normal' } as never,
    liveStatus: 'active', subscribers: 1, messages: [], hasMore: false, oldestChatId: null, maxMessageId: 0,
    streamingText: '', pendingPermissions: [], pendingQuestions: [], pendingExitPlans: [],
    features: ['assistant_flushed'], sync: rev(r), focus: { applied: true, focused: true, focusSeq: 1 }, ...o,
  } as SessionWindowResponse;
}

type Call = { view: TranscriptView; conn: string; focusSeq: number; signal: AbortSignal;
  resolve(r: SessionWindowResponse): void; reject(e: unknown): void };

const settle = () => new Promise((r) => setTimeout(r, 0));

function harness(o: { journal?: TranscriptJournal<SessionFrame>; epoch?: () => number | null; streamReady?: () => boolean; mountDeferMs?: number } = {}) {
  const calls: Call[] = [];
  const journal = o.journal ?? new TranscriptJournal<SessionFrame>();
  const applied: Array<{ r: SessionWindowResponse; mode: 'replace' | 'tail'; replay: Array<{ ev: SessionFrame; rev: { epoch: number; rev: number } }> }> = [];
  let state: TranscriptState = createTranscriptState('s1', 'claude');
  const errors: unknown[] = [];
  const ctx = (r: { epoch: number; rev: number } | null, fromJournal: boolean) =>
    ({ fromJournal, rev: r, nowMs: E, view: 'full' as const, provider: 'claude' as const, hubBoundaries: true });
  const ws = createWindowSync({
    fetchWindow: (p) => new Promise((resolve, reject) => { calls.push({ ...p, resolve, reject }); }),
    apply: (r, mode, replay) => {
      applied.push({ r, mode, replay });
      state = applySnapshot(state, r, { ...ctx(null, true), mode });
      for (const f of replay) state = applyFrame(state, f.ev, ctx(f.rev, true)).state;
    },
    journal,
    focusTicket: () => ({ conn: 'conn-1', seq: 7 }),
    epoch: o.epoch ?? (() => E),
    onError: (e) => { errors.push(e); },
    streamReady: o.streamReady,
    mountDeferMs: o.mountDeferMs,
  });
  /** A live frame: journaled while a GET flies, then applied (the hook's order). */
  const deliver = (ev: SessionFrame, r: number) => {
    if (journal.active) journal.record(ev, rev(r), 10);
    state = applyFrame(state, ev, ctx(rev(r), false)).state;
  };
  return { ws, calls, applied, journal, errors, deliver, get state() { return state; } };
}

describe('windowSync — one window GET at a time', () => {
  it('view === null ⇒ nothing is fetched (even when asked)', async () => {
    const h = harness();
    h.ws.setView(null);
    h.ws.request('resync');
    h.ws.onResync(rev(5));
    h.ws.request('gate');
    await settle();
    expect(h.calls).toHaveLength(0);
    expect(h.journal.active).toBe(false);
  });

  it("a stored '0' (setView('conversation') first) ⇒ exactly ONE view=conversation GET at mount", async () => {
    const store = new Map<string, string>([[SHOW_TOOLS_STORAGE_KEY, '0']]);
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null };
    try {
      const h = harness();
      h.ws.setView(null);                                       // HubPanel has not read storage yet
      h.ws.setView(transcriptViewFor(readShowToolsPreference())); // its mount effect
      await settle();
      expect(h.calls.map((c) => c.view)).toEqual(['conversation']);
      expect(h.calls[0]).toMatchObject({ conn: 'conn-1', focusSeq: 7 });
      h.calls[0].resolve(win(10, { view: 'conversation' }));
      await settle();
      expect(h.applied).toHaveLength(1);
      expect(h.applied[0].mode).toBe('replace');
      expect(h.calls).toHaveLength(1);
    } finally {
      g.localStorage = prev;
    }
  });

  it('two triggers during a flight ⇒ exactly ONE rerun, in tail mode, first reason kept', async () => {
    const h = harness();
    h.ws.setView('full');
    expect(h.ws.inFlight).toBe(true);
    h.ws.request('missed-frame');
    h.ws.request('gate');
    h.ws.request('unknown-row');
    expect(h.calls).toHaveLength(1);
    h.calls[0].resolve(win(10));
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.ws.inFlight).toBe(true);
    h.calls[1].resolve(win(12));
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.applied.map((a) => a.mode)).toEqual(['replace', 'tail']);
    expect(h.ws.inFlight).toBe(false);
    expect(h.ws.snapshotRev).toEqual(rev(12));
  });

  it('a view trigger aborts the flight and refetches (replace); the old answer is ignored', async () => {
    const h = harness();
    h.ws.setView('full');
    h.ws.setView('conversation');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.calls[1].view).toBe('conversation');
    h.calls[0].resolve(win(9));                 // late answer of the aborted request
    await settle();
    expect(h.applied).toHaveLength(0);
    h.calls[1].resolve(win(10, { view: 'conversation' }));
    await settle();
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]).toMatchObject({ mode: 'replace' });
    expect(h.applied[0].r.view).toBe('conversation');
  });

  it('reset/epoch abort too; a queued rerun is superseded by them', async () => {
    const h = harness();
    h.ws.setView('full');
    h.calls[0].resolve(win(10));
    await settle();
    h.ws.request('gate');
    h.ws.request('missed-frame');               // rerun queued
    h.ws.request('reset');
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1].signal.aborted).toBe(true);
    h.calls[2].resolve(win(20));
    await settle();
    expect(h.calls).toHaveLength(3);            // no rerun after the reset
    expect(h.applied.map((a) => a.mode)).toEqual(['replace', 'replace']);
  });

  it('a frame R2+1 arriving before the rerun\'s body is present after its apply (journal across requests)', async () => {
    const h = harness();
    h.ws.setView('full');
    h.deliver({ type: 'user_question', id: 'q-early', questions: [] } as SessionFrame, 9);
    h.ws.request('gate');                       // rerun queued
    h.calls[0].resolve(win(10));                // R1 = 10 (q-early ≤ R1: in the snapshot or not, it is not replayed)
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.journal.active).toBe(true);        // spans the rerun
    h.deliver({ type: 'permission_request', id: 'p-late', tool: 'Bash', input: {} } as SessionFrame, 21);
    h.calls[1].resolve(win(20));                // R2 = 20, its body lacks p-late
    await settle();
    expect(h.applied[1].replay.map((f) => f.rev.rev)).toEqual([21]);
    expect(h.state.queues.permissions.map((p) => p.id)).toEqual(['p-late']);
    expect(h.state.queues.questions).toEqual([]);     // R2's snapshot does not list it
    expect(h.journal.active).toBe(false);
  });

  it('frames received during the GET are replayed after the snapshot when > R', async () => {
    const h = harness();
    h.ws.setView('full');
    h.deliver({ type: 'assistant_text', delta: 'Hel' } as SessionFrame, 10);
    h.deliver({ type: 'assistant_text', delta: 'lo' } as SessionFrame, 11);
    h.calls[0].resolve(win(10, { streamingText: 'Hel' }));
    await settle();
    expect(h.state.buf.assistant).toBe('Hello');
  });

  it("resync `gap` while uncovered ⇒ exactly ONE window GET; buf.assistant = the answer's streamingText", async () => {
    const h = harness();
    h.ws.setView('full');
    h.calls[0].resolve(win(10, { focus: { applied: true, focused: false, focusSeq: 7 } }));  // not covered
    await settle();
    h.deliver({ type: 'assistant_text', delta: 'stale local text' } as SessionFrame, 11);
    h.ws.onResync(rev(40));
    h.ws.onResync(rev(40));                     // a duplicate notification while in flight
    expect(h.calls).toHaveLength(2);
    h.calls[1].resolve(win(41, { streamingText: 'the hub buffer' }));
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.applied[1].mode).toBe('tail');
    expect(h.state.buf.assistant).toBe('the hub buffer');
  });

  it('resync while covered ⇒ none; `first` after a focused mount GET ⇒ none', async () => {
    const h = harness();
    h.ws.setView('full');
    h.calls[0].resolve(win(30));                // focused, R = 30
    await settle();
    h.ws.onResync(rev(25));                     // first: the conn went live at 25, before the GET read
    h.ws.onResync(rev(30));
    await settle();
    expect(h.calls).toHaveLength(1);
    h.ws.onResync(rev(31));                     // a later resync is not covered
    expect(h.calls).toHaveLength(2);
  });

  it('a resync during the flight is decided when the answer lands', async () => {
    const h = harness();
    h.ws.setView('full');
    h.ws.onResync(rev(50));                     // the answer may predate it
    h.calls[0].resolve(win(40));
    await settle();
    expect(h.calls).toHaveLength(2);            // uncovered ⇒ rerun resync
    h.calls[1].resolve(win(51));
    await settle();
    expect(h.calls).toHaveLength(2);
    const k = harness();
    k.ws.setView('full');
    k.ws.onResync(rev(50));
    k.calls[0].resolve(win(55));                // covered by the answer
    await settle();
    expect(k.calls).toHaveLength(1);
  });

  it('a resync of another epoch ⇒ an aborting `epoch` window (replace)', async () => {
    const h = harness();
    h.ws.setView('full');
    h.calls[0].resolve(win(30));
    await settle();
    h.ws.onResync(rev(3, E + 5));
    expect(h.calls).toHaveLength(2);
    h.calls[1].resolve(win(4, { sync: rev(4, E + 5) }));
    await settle();
    expect(h.applied[1].mode).toBe('replace');
  });

  it('an unfocused snapshot ⇒ ONE retry at the next hello completion', async () => {
    const h = harness();
    h.ws.setView('full');
    h.calls[0].resolve(win(10, { focus: { applied: false, focused: false, focusSeq: 7 } }));
    await settle();
    expect(h.calls).toHaveLength(1);
    h.ws.onHelloComplete();
    expect(h.calls).toHaveLength(2);
    h.ws.onHelloComplete();                     // no second retry while in flight / pending
    h.calls[1].resolve(win(11));
    await settle();
    h.ws.onHelloComplete();
    expect(h.calls).toHaveLength(2);
  });

  it('journal overflow beyond R ⇒ rerun (overflow)', async () => {
    const h = harness({ journal: new TranscriptJournal<SessionFrame>({ maxFrames: 2 }) });
    h.ws.setView('full');
    for (let r = 11; r <= 14; r++) h.deliver({ type: 'assistant_text', delta: String(r) } as SessionFrame, r);
    expect(h.journal.droppedUpTo).toEqual(rev(12));
    h.calls[0].resolve(win(10));                // frames 11, 12 lost from the journal
    await settle();
    expect(h.calls).toHaveLength(2);
    h.calls[1].resolve(win(14));
    await settle();
    expect(h.calls).toHaveLength(2);
    // Eviction at or below R needs no rerun.
    const k = harness({ journal: new TranscriptJournal<SessionFrame>({ maxFrames: 1 }) });
    k.ws.setView('full');
    k.deliver({ type: 'assistant_text', delta: 'a' } as SessionFrame, 8);
    k.deliver({ type: 'assistant_text', delta: 'b' } as SessionFrame, 9);
    k.calls[0].resolve(win(10));
    await settle();
    expect(k.calls).toHaveLength(1);
  });

  it('an error ends the journal (no rerun queued) and is reported', async () => {
    const h = harness();
    h.ws.setView('full');
    h.deliver({ type: 'assistant_text', delta: 'x' } as SessionFrame, 3);
    expect(h.journal.active).toBe(true);
    h.calls[0].reject(new Error('GET → 503'));
    await settle();
    expect(h.journal.active).toBe(false);
    expect(h.errors).toHaveLength(1);
    expect(h.ws.inFlight).toBe(false);
    // An error with a rerun queued runs the rerun.
    const k = harness();
    k.ws.setView('full');
    k.ws.request('gate');
    k.calls[0].reject(new Error('boom'));
    await settle();
    expect(k.calls).toHaveLength(2);
    expect(k.journal.active).toBe(true);
  });

  it('ignores an answer of an older epoch than the stream, or strictly older than the snapshot', async () => {
    let streamEpoch = E + 1;
    const h = harness({ epoch: () => streamEpoch });
    h.ws.setView('full');
    h.calls[0].resolve(win(99, { sync: rev(99, E) }));
    await settle();
    expect(h.applied).toHaveLength(0);
    streamEpoch = E;
    h.ws.request('gate');
    h.calls[1].resolve(win(50));
    await settle();
    h.ws.request('gate');
    h.calls[2].resolve(win(40));                // older than 50
    await settle();
    expect(h.applied.map((a) => a.r.sync?.rev)).toEqual([50]);
    h.ws.request('gate');
    h.calls[3].resolve(win(50));                // same revision: a quiet hub — applied
    await settle();
    expect(h.applied.map((a) => a.r.sync?.rev)).toEqual([50, 50]);
  });

  it('dispose aborts and stops everything', async () => {
    const h = harness();
    h.ws.setView('full');
    h.ws.dispose();
    expect(h.calls[0].signal.aborted).toBe(true);
    h.calls[0].resolve(win(10));
    h.ws.request('gate' as WindowReason);
    await settle();
    expect(h.applied).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    expect(h.journal.active).toBe(false);
  });
  it('a failed mount GET with nothing applied is retried by retryMount (and only then)', async () => {
    const h = harness();
    h.ws.setView('full');
    h.ws.retryMount();                          // in flight: no-op
    expect(h.calls).toHaveLength(1);
    h.calls[0].reject(new Error('GET → 503'));
    await settle();
    expect(h.calls).toHaveLength(1);            // an error alone never retries
    h.ws.retryMount();
    expect(h.calls).toHaveLength(2);
    h.calls[1].resolve(win(10));
    await settle();
    expect(h.applied).toHaveLength(1);
    expect(h.state.loaded).toBe(true);
    h.ws.retryMount();                          // loaded once: the probe owns repairs
    expect(h.calls).toHaveLength(2);
  });

  it('an unfocused mount answer then sync_snapshot_end ⇒ the resync GET is the retry (2 GETs, not 3)', async () => {
    const h = harness();
    h.ws.setView('full');
    h.calls[0].resolve(win(10, { focus: { applied: false, focused: false, focusSeq: 7 } }));
    await settle();
    h.ws.onResync(rev(12));                     // globalEventStream: resync listeners first…
    h.ws.onHelloComplete();                     // …then ready listeners, same tick
    expect(h.calls).toHaveLength(2);
    h.calls[1].resolve(win(12));
    await settle();
    expect(h.calls).toHaveLength(2);
    h.ws.onHelloComplete();                     // a later reconnect's hello: nothing left to retry
    expect(h.calls).toHaveLength(2);
  });

  it('a focused answer clears a pending unfocused retry', async () => {
    const h = harness();
    h.ws.setView('full');
    h.calls[0].resolve(win(10, { focus: { applied: false, focused: false, focusSeq: 7 } }));
    await settle();
    h.ws.request('gate');
    h.calls[1].resolve(win(11));
    await settle();
    h.ws.onHelloComplete();
    expect(h.calls).toHaveLength(2);
  });

  it('a resync during a flight that errors still re-windows (and keeps the unfocused retry armed)', async () => {
    const h = harness();
    h.ws.setView('full');
    h.calls[0].resolve(win(30, { focus: { applied: false, focused: false, focusSeq: 7 } }));
    await settle();
    h.ws.request('gate');
    expect(h.calls).toHaveLength(2);
    h.ws.onResync(rev(50));                     // deferred behind the gate GET
    h.calls[1].reject(new Error('GET → 503'));
    await settle();
    expect(h.calls).toHaveLength(3);            // the owed resync window
    h.calls[2].reject(new Error('GET → 503'));  // it fails too
    await settle();
    expect(h.calls).toHaveLength(3);
    expect(h.ws.inFlight).toBe(false);
    h.ws.onHelloComplete();                     // the unfocused retry survived the errors
    expect(h.calls).toHaveLength(4);
    h.calls[3].resolve(win(51));
    await settle();
    h.ws.onHelloComplete();                     // settled by a focused answer
    expect(h.calls).toHaveLength(4);
    // Covered (focused ≥ the resync): an erroring flight owes nothing.
    const k = harness();
    k.ws.setView('full');
    k.calls[0].resolve(win(30));
    await settle();
    k.ws.request('gate');
    k.ws.onResync(rev(20));
    k.calls[1].reject(new Error('boom'));
    await settle();
    expect(k.calls).toHaveLength(2);
  });

  it('everApplied: only a network answer counts (the probe retries a failed mount over a cache paint)', async () => {
    const h = harness();
    h.ws.setView('full');
    expect(h.ws.everApplied).toBe(false);
    h.calls[0].reject(new Error('GET → 503'));
    await settle();
    expect(h.ws.everApplied).toBe(false);
    expect(h.ws.snapshotRev).toBeNull();
    h.ws.retryMount();
    h.calls[1].resolve(win(10));
    await settle();
    expect(h.ws.everApplied).toBe(true);
    expect(h.ws.snapshotRev).toEqual(rev(10));
  });
});

describe('windowSync — cold open waits for the stream registration', () => {
  it('a mount before the stream is live is deferred to the hello completion: exactly ONE (focused) GET', async () => {
    let live = false;
    const h = harness({ streamReady: () => live, mountDeferMs: 60_000 });
    h.ws.setView('conversation');
    await settle();
    expect(h.calls).toHaveLength(0);
    expect(h.ws.inFlight).toBe(true);
    h.ws.request('gate');                     // absorbed by the deferred mount
    h.ws.onResync(rev(4));                    // likewise
    h.ws.retryMount();
    await settle();
    expect(h.calls).toHaveLength(0);
    live = true;
    h.ws.onHelloComplete();
    await settle();
    expect(h.calls.map((c) => c.view)).toEqual(['conversation']);
    h.calls[0].resolve(win(10, { view: 'conversation' }));
    await settle();
    h.ws.onHelloComplete();
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.applied).toHaveLength(1);
  });

  it('a stream that never comes live still gets its mount after mountDeferMs (unfocused retry at the later hello)', async () => {
    const h = harness({ streamReady: () => false, mountDeferMs: 5 });
    h.ws.setView('full');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.calls).toHaveLength(1);
    h.calls[0].resolve(win(10, { focus: { applied: false, focused: false, focusSeq: 7 } }));
    await settle();
    h.ws.onHelloComplete();
    await settle();
    expect(h.calls).toHaveLength(2);
  });

  it('a live stream mounts at once; dispose cancels a deferred mount', async () => {
    const a = harness({ streamReady: () => true });
    a.ws.setView('full');
    await settle();
    expect(a.calls).toHaveLength(1);
    const b = harness({ streamReady: () => false, mountDeferMs: 5 });
    b.ws.setView('full');
    b.ws.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(b.calls).toHaveLength(0);
  });
});

describe('windowSync — replacing', () => {
  it('true while a mount/view window flies (older pages would be dropped), false for a tail rerun', async () => {
    const h = harness();
    h.ws.setView('full');
    await settle();
    expect(h.ws.replacing).toBe(true);
    h.calls[0].resolve(win(10));
    await settle();
    expect(h.ws.replacing).toBe(false);
    h.ws.request('gate');
    expect(h.ws.inFlight).toBe(true);
    expect(h.ws.replacing).toBe(false);
    h.calls[1].resolve(win(11));
    await settle();
    h.ws.setView('conversation');
    expect(h.ws.replacing).toBe(true);
  });
});
