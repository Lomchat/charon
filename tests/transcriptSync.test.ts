// The transcript sync guarantees (CLAUDE.md §14.107, sync refonte I6), proven
// on the pure reducer: snapshot@R + frames>R, per frame class.
import { describe, expect, it } from 'vitest';
import {
  applyFrame, applyOlderPage, applySnapshot, createTranscriptState, liveStreamingMessage,
  CONVERSATION_TOOL_CALLS_MAX, type SessionFrame, type TranscriptState,
} from '@/app/sync/transcriptReducer';
import type { SessionWindowResponse } from '@/lib/types/api';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import type { TranscriptView } from '@/lib/transcriptRows';

const E = 1_700_000_000_000;
const R = 100;
type Row = { id: number; role: string; content: string; assistantFinal?: number | null };

function win(rev: number | null, rows: Row[] = [], o: Partial<SessionWindowResponse> = {}): SessionWindowResponse {
  return {
    session: { id: 's1', kind: 'claude', status: 'active', vpsId: 'v1', permissionMode: 'normal' } as never,
    liveStatus: 'thinking', subscribers: 1, hasMore: false, oldestChatId: rows[0]?.id ?? null,
    messages: rows.map((r) => ({ createdAt: 100, tsMs: 1_000_000 + r.id, model: null, assistantFinal: null, ...r })) as never,
    maxMessageId: rows.reduce((a, r) => Math.max(a, r.id), 0),
    streamingText: '', pendingPermissions: [], pendingQuestions: [], pendingExitPlans: [],
    features: ['assistant_flushed'], focus: { applied: true, focused: true, focusSeq: 1 },
    ...(rev == null ? {} : { sync: { epoch: E, rev } }), ...o,
  } as SessionWindowResponse;
}

const ctx = (rev: number | null, view: TranscriptView = 'full', provider: SessionProvider = 'claude', fromJournal = false) =>
  ({ fromJournal, view, provider, hubBoundaries: true, nowMs: E, rev: rev == null ? null : { epoch: E, rev } });

function snapshot(r: SessionWindowResponse, o: { s?: TranscriptState; mode?: 'replace' | 'tail'; view?: TranscriptView;
  provider?: SessionProvider } = {}): TranscriptState {
  const s = o.s ?? createTranscriptState('s1', o.provider ?? 'claude');
  return applySnapshot(s, r, { ...ctx(null, o.view ?? 'full', o.provider ?? 'claude', true), mode: o.mode ?? 'replace' });
}
function frames(s: TranscriptState, list: Array<[SessionFrame, number | null]>, view: TranscriptView = 'full',
  provider: SessionProvider = 'claude'): TranscriptState {
  for (const [ev, rev] of list) s = applyFrame(s, ev, ctx(rev, view, provider)).state;
  return s;
}
const f = (ev: Record<string, unknown>) => ev as unknown as SessionFrame;
/** What the view draws: rows with the live row substituted + `__streaming`. */
function rendered(s: TranscriptState): string[] {
  const live = liveStreamingMessage(s.messages, s.buf);
  const out = s.messages.map((m) => (live && live.id === m.id ? live.content : m.content));
  if (live?.id === '__streaming') out.push(live.content);
  return out;
}

describe('snapshot@R + frames>R', () => {
  it('frames {R−1, R+1, R+2} ⇒ only R+1 and R+2 apply', () => {
    let s = snapshot(win(R, [{ id: 1, role: 'user', content: 'hi' }]));
    s = frames(s, [
      [f({ type: 'tool_use', id: 't-old', name: 'Read', input: {}, rowId: 2 }), R - 1],
      [f({ type: 'tool_use', id: 't1', name: 'Read', input: {}, rowId: 3 }), R + 1],
      [f({ type: 'tool_use', id: 't2', name: 'Read', input: {}, rowId: 4 }), R + 2],
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm3', 'm4']);
    expect(s.toolCalls.map((c) => c.id)).toEqual(['t1', 't2']);
  });

  it('pending-apply flags: the hub\'s known values win over a starting frame lost in a gap; absent keeps them', () => {
    let s = snapshot(win(R));
    s = frames(s, [[f({ type: 'effort_changed', effort: 'high', appliedAtNextStart: true }), R + 1]]);
    expect(s.meta.effortPendingApply).toBe(true);
    // A resync after a restart this view never saw (its `starting` lost).
    s = snapshot(win(R + 10, [], { pendingApply: { model: false, effort: false } }), { s });
    expect(s.meta.effortPendingApply).toBe(false);
    s = frames(s, [[f({ type: 'model_changed', model: 'opus', fallbackModel: null, appliedAtNextStart: true }), R + 11]]);
    s = snapshot(win(R + 12), { s });            // an older hub: no pendingApply
    expect(s.meta.modelPendingApply).toBe(true);
  });

  it('question_delivery: a failed delivery seen as delivering in the snapshot becomes answerable again', () => {
    const pq = { id: 'aq1', sessionId: 's1', questions: [{ question: 'ok?', options: [] }], createdAt: 1,
      delivery: 'async', delivering: true };
    let s = snapshot(win(R, [], { pendingQuestions: [pq] as never }));
    expect(s.queues.questions[0].delivering).toBe(true);
    s = frames(s, [[f({ type: 'question_delivery', id: 'aq1', delivering: false }), R + 1]]);
    expect(s.queues.questions[0].delivering).toBeFalsy();
    expect(s.queues.questions[0].id).toBe('aq1');
    // A start seen live marks it; an unknown id changes nothing.
    s = frames(s, [[f({ type: 'question_delivery', id: 'aq1', delivering: true }), R + 2]]);
    expect(s.queues.questions[0].delivering).toBe(true);
    const before = s;
    s = frames(s, [[f({ type: 'question_delivery', id: 'nope', delivering: false }), R + 3]]);
    expect(s.queues).toBe(before.queues);
  });

  it('a question at R+1 received during the GET survives the snapshot (journal replay)', () => {
    let s = createTranscriptState('s1', 'claude');
    const q = f({ type: 'user_question', id: 'q1', questions: [{ question: 'ok?', options: [] }], rowId: 9 });
    s = frames(s, [[q, R + 1]]);                         // live, while the GET flies
    s = snapshot(win(R), { s });                         // its body predates the question
    expect(s.queues.questions).toEqual([]);
    s = applyFrame(s, q, ctx(R + 1, 'full', 'claude', true)).state;   // replayed from the journal
    expect(s.queues.questions.map((x) => x.id)).toEqual(['q1']);
  });

  it('stop at R+1 marks the final row; no effect asks for a refetch', () => {
    let s = snapshot(win(R, [{ id: 1, role: 'user', content: 'hi' }, { id: 2, role: 'assistant', content: 'done', assistantFinal: 0 }]));
    const out = applyFrame(s, f({ type: 'stop', finalAssistantId: 2 }), ctx(R + 1));
    s = out.state;
    expect(s.messages.find((m) => m.id === 'm2')?.assistantFinal).toBe(1);
    expect(out.effects).toEqual([]);
    // A stop ≤ R is already in the snapshot.
    const t = snapshot(win(R, [{ id: 2, role: 'assistant', content: 'x', assistantFinal: 0 }]));
    expect(applyFrame(t, f({ type: 'stop', finalAssistantId: 2 }), ctx(R)).state).toBe(t);
  });

  it('deltas at R+1.. extend `streamingText@R` without doubling', () => {
    let s = snapshot(win(R, [], { streamingText: 'Hello' }));
    s = frames(s, [
      [f({ type: 'assistant_text', delta: 'llo' }), R - 1],    // inside streamingText@R
      [f({ type: 'assistant_text', delta: 'Hello' }), R],
      [f({ type: 'assistant_text', delta: ' wor' }), R + 1],
      [f({ type: 'assistant_text', delta: 'ld' }), R + 2],
    ]);
    expect(s.buf.assistant).toBe('Hello world');
    expect(rendered(s)).toEqual(['Hello world']);
  });

  it('a SIGTERM partial with `streamingExtends` shows its text once; the later assistant_flushed{content} replaces it', () => {
    let s = snapshot(win(R, [{ id: 1, role: 'user', content: 'hi' }, { id: 7, role: 'assistant', content: 'The ans' }],
      { streamingText: 'wer is', streamingExtends: { rowId: 7, length: 7 } }));
    expect(s.buf.streamingInto).toBe(7);
    expect(rendered(s)).toEqual(['hi', 'The answer is']);
    s = frames(s, [[f({ type: 'assistant_text', delta: ' 42' }), R + 1]]);
    expect(rendered(s)).toEqual(['hi', 'The answer is 42']);
    s = frames(s, [[f({ type: 'assistant_flushed', rowId: 7, length: 16, tsMs: null, model: null,
      content: 'The answer is 42.' }), R + 2]]);
    expect(rendered(s)).toEqual(['hi', 'The answer is 42.']);
    expect(s.buf).toMatchObject({ assistant: '', streamingInto: null });
  });

  it('tool_progress ≤ R after the apply is dropped (covered by streamingToolOutput), > R appended', () => {
    let s = snapshot(win(R, [{ id: 3, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't1', name: 'Bash', input: {} }) }],
      { streamingToolOutput: [{ toolUseId: 't1', text: 'line1\n', truncated: false }] }));
    const out = () => JSON.parse(s.messages.find((m) => m.id === 'tr-live-t1')!.content).content;
    expect(out()).toBe('line1\n');
    s = frames(s, [[f({ type: 'tool_progress', tool_use_id: 't1', delta: 'line1\n' }), R]]);
    expect(out()).toBe('line1\n');
    s = frames(s, [[f({ type: 'tool_progress', tool_use_id: 't1', delta: 'line2\n' }), R + 1]]);
    expect(out()).toBe('line1\nline2\n');
  });

  it('plan_progress ≤ R applies unless its plan is durable in the snapshot', () => {
    const plan = (id: string) => f({ type: 'plan_progress', id, text: 'step…' });
    let s = snapshot(win(R, [{ id: 5, role: 'event', content: JSON.stringify({ type: 'plan_update', id: 'p-done', steps: [] }) }]));
    s = frames(s, [[plan('p-live'), R - 5], [plan('p-done'), R - 5]]);
    const pd = s.messages.find((m) => m.id === 'plan:p-done')!;
    expect(JSON.parse(pd.content).partial).toBeUndefined();          // still the durable row
    expect(JSON.parse(s.messages.find((m) => m.id === 'plan:p-live')!.content).partial).toBe(true);
    s = frames(s, [[plan('p-done'), R + 1]]);                         // a later update of that plan applies
    expect(JSON.parse(s.messages.find((m) => m.id === 'plan:p-done')!.content).partial).toBe(true);
  });

  it('a live partial plan survives a snapshot; its durable row retires it', () => {
    let s = snapshot(win(R));
    s = frames(s, [[f({ type: 'plan_progress', id: 'p1', text: 'thinking…' }), R + 1]]);
    s = snapshot(win(R + 5), { s });
    expect(s.messages.map((m) => m.id)).toContain('plan:p1');
    s = snapshot(win(R + 9, [{ id: 8, role: 'event', content: JSON.stringify({ type: 'plan_update', id: 'p1', steps: [] }) }]), { s });
    expect(s.livePlans.size).toBe(0);
    expect(s.messages.filter((m) => m.id === 'plan:p1')).toHaveLength(1);
  });

  it('edit_progress ≤ R applies (live class)', () => {
    let s = snapshot(win(R));
    s = frames(s, [[f({ type: 'edit_progress', tool_use_id: 't', file_path: '/a.ts', diff: '+x', size: 2, truncated: false }), R - 10]]);
    expect(s.edits.get('/a.ts')?.after).toBe('+x');
    expect(s.files.has('/a.ts')).toBe(true);
  });

  it('tail mode keeps older pages; replace mode drops them', () => {
    let s = snapshot(win(R, [{ id: 50, role: 'user', content: 'new' }]));
    s = applyOlderPage(s, { messages: win(null, [{ id: 10, role: 'user', content: 'old' }]).messages, hasMore: true, oldestChatId: 10 },
      50, { view: 'full', provider: 'claude' });
    expect(s.messages.map((m) => m.id)).toEqual(['m10', 'm50']);
    const tail = snapshot(win(R + 1, [{ id: 50, role: 'user', content: 'new' }, { id: 51, role: 'assistant', content: 'a' }]),
      { s, mode: 'tail' });
    expect(tail.messages.map((m) => m.id)).toEqual(['m10', 'm50', 'm51']);
    expect(tail.hasMore).toBe(true);
    expect(tail.oldestChatId).toBe(10);
    const replace = snapshot(win(R + 1, [{ id: 50, role: 'user', content: 'new' }]), { s, mode: 'replace' });
    expect(replace.messages.map((m) => m.id)).toEqual(['m50']);
    expect(replace.oldestChatId).toBe(50);
  });

  it('a tail window past a gap wider than itself replaces (no hole), taking its own paging', () => {
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => ({ id: a + i, role: i % 2 ? 'assistant' : 'user', content: `r${a + i}` }));
    let s = snapshot(win(R, range(1, 10)));
    s = snapshot(win(R + 1, range(301, 310), { hasMore: true, oldestChatId: 301 }), { s, mode: 'tail' });
    expect(s.messages.map((m) => m.id)).toEqual(range(301, 310).map((r) => `m${r.id}`));
    expect(s.hasMore).toBe(true);
    expect(s.oldestChatId).toBe(301);
    // An overlapping answer still keeps the older rows (and their paging).
    let o = snapshot(win(R, range(1, 10), { hasMore: true, oldestChatId: 1 }));
    o = snapshot(win(R + 1, range(8, 20), { hasMore: true, oldestChatId: 8 }), { s: o, mode: 'tail' });
    expect(o.messages[0].id).toBe('m1');
    expect(o.oldestChatId).toBe(1);
    // An answer reaching the start (hasMore false) joins whatever it is.
    let z = snapshot(win(R, range(1, 3)));
    z = snapshot(win(R + 1, range(5, 6), { hasMore: false }), { s: z, mode: 'tail' });
    expect(z.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm5', 'm6']);
  });

  it('conversation view: a covered tool frame still reaches the calls list (count already holds it)', () => {
    let s = snapshot(win(R, [{ id: 1, role: 'user', content: 'hi' }], { toolCallCount: 1 }), { view: 'conversation' });
    s = frames(s, [
      [f({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x.ts' }, rowId: 2 }), R - 1],
      [f({ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false, rowId: 3 }), R],
      [f({ type: 'tool_use', id: 't1', name: 'Read', input: {}, rowId: 2 }), R - 1],
    ], 'conversation');
    expect(s.toolCalls.map((c) => [c.id, c.result?.content])).toEqual([['t1', 'ok']]);
    expect(s.toolCallIdsSince.size).toBe(0);
    expect(s.files.has('/x.ts')).toBe(true);
    expect(s.messages.map((m) => m.id)).toEqual(['m1']);
    // The full view still drops a covered frame whole (the snapshot holds its row).
    let full = snapshot(win(R, [{ id: 1, role: 'user', content: 'hi' }]));
    full = frames(full, [[f({ type: 'tool_use', id: 't9', name: 'Read', input: {}, rowId: 2 }), R - 1]]);
    expect(full.toolCalls).toEqual([]);
  });

  it('an older page is ignored once the window moved (replace apply meanwhile)', () => {
    let s = snapshot(win(R, [{ id: 50, role: 'user', content: 'new' }]));
    s = snapshot(win(R + 1, [{ id: 60, role: 'user', content: 'newer' }]), { s, mode: 'replace' });
    const t = applyOlderPage(s, { messages: [], hasMore: false, oldestChatId: 10 }, 50, { view: 'full', provider: 'claude' });
    expect(t).toBe(s);
  });

  it('conversation view never grows `messages` on tool/thinking/plan/tool_progress frames but grows toolCalls (ring 200)', () => {
    let s = snapshot(win(R, [{ id: 1, role: 'user', content: 'hi' }], {
      session: { id: 's1', kind: 'codex', status: 'active', vpsId: 'v1', permissionMode: 'workspace-write' } as never,
    }), { view: 'conversation', provider: 'codex' });
    const before = s.messages;
    const list: Array<[SessionFrame, number]> = [];
    let rev = R;
    for (let i = 0; i < 250; i++) {
      list.push([f({ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' }, rowId: 1000 + 2 * i }), ++rev]);
      list.push([f({ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok', rowId: 1001 + 2 * i }), ++rev]);
    }
    list.push([f({ type: 'tool_progress', tool_use_id: 't249', delta: 'x' }), ++rev]);
    list.push([f({ type: 'thinking', text: 'hmm' }), ++rev]);
    list.push([f({ type: 'thinking_flushed', rowId: 5000, length: 3 }), ++rev]);
    list.push([f({ type: 'plan_progress', id: 'p', text: '…' }), ++rev]);
    list.push([f({ type: 'plan_update', id: 'p', steps: [], rowId: 5001 }), ++rev]);
    s = frames(s, list, 'conversation', 'codex');
    expect(s.messages).toBe(before);
    expect(s.toolCalls).toHaveLength(CONVERSATION_TOOL_CALLS_MAX);
    expect(s.toolCalls[s.toolCalls.length - 1]).toMatchObject({ id: 't249', result: { content: 'ok' } });
    expect(s.knownRowIds.has(5001)).toBe(true);
    // An assistant cut still lands.
    s = frames(s, [[f({ type: 'assistant_text', delta: 'answer' }), ++rev],
      [f({ type: 'assistant_flushed', rowId: 6000, length: 6, tsMs: null, model: null }), ++rev]], 'conversation', 'codex');
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm6000']);
  });

  it('a rev-less response applies, and rev-less frames always apply', () => {
    let s = snapshot(win(null, [{ id: 1, role: 'user', content: 'hi' }], { streamingText: 'par' }));
    expect(s.snapshotRev).toBeNull();
    expect(s.messages.map((m) => m.id)).toEqual(['m1']);
    s = frames(s, [[f({ type: 'tool_use', id: 't1', name: 'Read', input: {}, rowId: 2 }), null]]);
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    // Unstamped: its buffer may lag what we hold — never rewound.
    s = frames(s, [[f({ type: 'assistant_text', delta: 'tial answer' }), null]]);
    s = snapshot(win(null, [{ id: 1, role: 'user', content: 'hi' }], { streamingText: 'partial' }), { s, mode: 'tail' });
    expect(s.buf.assistant).toBe('partial answer');
  });

  it('a stamped snapshot is EXACT: its buffers replace what the browser held', () => {
    let s = snapshot(win(R, [], { streamingText: 'abc' }));
    s = frames(s, [[f({ type: 'assistant_text', delta: 'def' }), R + 1]]);
    s = snapshot(win(R + 3, [], { streamingText: 'xyz' }), { s, mode: 'tail' });
    expect(s.buf.assistant).toBe('xyz');
  });

  it('queues and status are replaced; gates answered here after R stay answered', () => {
    let s = snapshot(win(R, [], { pendingPermissions: [{ id: 'p1', tool: 'Bash', input: {}, createdAt: 1 }] }));
    expect(s.queues.permissions.map((p) => p.id)).toEqual(['p1']);
    expect(s.status).toBe('thinking');
    s = { ...s, localResolved: new Map([['p1', { epoch: E, rev: R + 5 }]]), queues: { ...s.queues, permissions: [] } };
    s = snapshot(win(R + 2, [], { pendingPermissions: [{ id: 'p1', tool: 'Bash', input: {}, createdAt: 1 }], liveStatus: 'active' }), { s });
    expect(s.queues.permissions).toEqual([]);
    expect(s.status).toBe('active');
    s = snapshot(win(R + 9, [], { pendingPermissions: [{ id: 'p1', tool: 'Bash', input: {}, createdAt: 1 }] }), { s });
    expect(s.queues.permissions.map((p) => p.id)).toEqual(['p1']);   // a snapshot after the answer is the truth
    expect(s.localResolved.size).toBe(0);
  });

  it('effects: transcript_reset ⇒ window(reset); session_resync ⇒ window(resync); killed; banner', () => {
    const s = snapshot(win(R));
    expect(applyFrame(s, f({ type: 'transcript_reset', reason: 'rollback' }), ctx(R + 1)).effects)
      .toEqual([{ kind: 'window', reason: 'reset' }]);
    expect(applyFrame(s, f({ type: 'session_resync', reason: 'large_frame' }), ctx(R + 1)).effects)
      .toEqual([{ kind: 'window', reason: 'resync' }]);
    expect(applyFrame(s, f({ type: 'status', status: 'killed' }), ctx(R + 1)).effects).toEqual([{ kind: 'killed' }]);
    expect(applyFrame(s, f({ type: 'error', msg: 'x' }), ctx(R + 1)).effects).toEqual([{ kind: 'banner', msg: 'x' }]);
  });

  it('a retrying provider error is retired by the next stream frame, once', () => {
    let s = snapshot(win(R));
    let out = applyFrame(s, f({ type: 'error', msg: 'Reconnecting... 3/5', retrying: true }), ctx(R + 1));
    expect(out.effects).toEqual([{ kind: 'banner', msg: 'Reconnecting... 3/5', retrying: true }]);
    s = out.state;
    expect(applyFrame(s, f({ type: 'usage', output_tokens: 1, input_tokens: 1 }), ctx(R + 2)).effects).toEqual([]);
    out = applyFrame(s, f({ type: 'assistant_text', delta: 'back' }), ctx(R + 2));
    expect(out.effects).toEqual([{ kind: 'clearRetryBanner' }]);
    expect(applyFrame(out.state, f({ type: 'assistant_text', delta: '!' }), ctx(R + 3)).effects).toEqual([]);
    // A plain error is not the retry's to retire.
    s = applyFrame(s, f({ type: 'error', msg: 'boom' }), ctx(R + 2)).state;
    expect(applyFrame(s, f({ type: 'assistant_text', delta: 'x' }), ctx(R + 3)).effects).toEqual([]);
  });

  it('knownRowIds: snapshot rows ∪ every rowId a frame carried', () => {
    let s = snapshot(win(R, [{ id: 1, role: 'user', content: 'hi' }]));
    s = frames(s, [
      [f({ type: 'assistant_text', delta: 'yo' }), R + 1],
      [f({ type: 'assistant_flushed', rowId: 2, length: 2, tsMs: null, model: null }), R + 2],
      [f({ type: 'blocking_error', error: { kind: 'x' }, createdAt: 1, messageId: 3 }), R + 3],
    ]);
    expect([...s.knownRowIds].sort()).toEqual([1, 2, 3]);
    expect(s.afterId).toBe(1);
  });

  it('delta reasoning: the open block of the snapshot + deltas > R, never doubled', () => {
    let s = snapshot(win(R, [{ id: 1, role: 'user', content: 'hi' }], { streamingThinking: 'Let me',
      session: { id: 's1', kind: 'codex', status: 'active', vpsId: 'v1', permissionMode: 'workspace-write' } as never }),
    { provider: 'codex' });
    expect(s.provider).toBe('codex');
    expect(s.buf.thinkingOpen).toBe('Let me');
    s = frames(s, [[f({ type: 'thinking', text: 'Let me' }), R], [f({ type: 'thinking', text: ' think' }), R + 1]], 'full', 'codex');
    const th = s.messages.filter((m) => m.role === 'thinking');
    expect(th).toHaveLength(1);
    expect(th[0].content).toBe('Let me think');
    expect(s.buf.thinkingOpen).toBe('Let me think');
  });
});

// No page carries `bg_task` rows (lib/server/hub/messageWindow.ts § pageRows):
// the root window's folded registry IS the bar's history, the running set
// still decided by `backgroundTasks` alone.
describe('the bg registry from a root window answer', () => {
  const task = (taskId: string, status: string, endedAt: number | null) => ({
    taskId, description: taskId, command: null, toolUseId: null, taskType: 'local_agent', status,
    startedAt: 50, endedAt, outputFile: null, summary: null, workflowName: null, usage: null, lastToolName: null, agents: null,
  });
  it('ended tasks come from bgHistory, running ones from backgroundTasks, older ones as a count', () => {
    const s = snapshot(win(R, [{ id: 1, role: 'user', content: 'go' }], {
      backgroundTasks: [task('run', 'running', null)] as never,
      bgHistory: { ended: [task('done', 'completed', 90), task('stale-running-in-history', 'running', null)] as never, older: 7 },
    }));
    expect([...s.bgTasks.keys()].sort()).toEqual(['done', 'run']);
    expect(s.bgTasks.get('done')?.status).toBe('completed');
    expect(s.bgOlderEnded).toBe(7);
  });
});
