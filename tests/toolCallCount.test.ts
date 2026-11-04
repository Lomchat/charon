import { describe, expect, it } from 'vitest';
import {
  applyFrame, applySnapshot, createTranscriptState, toolCallTotal, type SessionFrame, type TranscriptState,
} from '@/app/sync/transcriptReducer';
import type { SessionWindowResponse } from '@/lib/types/api';
import type { TranscriptView } from '@/lib/transcriptRows';

// The tool-calls tab counter (useSessionStream § toolCallCount): the
// window's `toolCallCount` + the live tool_use ids since — it grows between
// window answers (no poll refreshes it any more).
const E = 1_700_000_000_000;
const R = (rev: number) => ({ epoch: E, rev });
function win(rev: number, count: number | undefined, view: TranscriptView): SessionWindowResponse {
  return {
    session: { id: 's1', kind: 'claude', status: 'active', vpsId: 'v1', permissionMode: 'normal' } as never,
    liveStatus: 'active', subscribers: 1, hasMore: false, oldestChatId: null, messages: [], maxMessageId: 0,
    streamingText: '', pendingPermissions: [], pendingQuestions: [], pendingExitPlans: [],
    features: ['assistant_flushed'], sync: R(rev), focus: { applied: true, focused: true, focusSeq: 1 },
    view, ...(count == null ? {} : { toolCallCount: count }),
  } as SessionWindowResponse;
}
const ctx = (view: TranscriptView, rev: number | null, fromJournal = false) =>
  ({ fromJournal, rev: rev == null ? null : R(rev), nowMs: E, view, provider: 'claude' as const, hubBoundaries: true });
const tool = (id: string): SessionFrame => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }) as SessionFrame;

describe.each(['full', 'conversation'] as const)('tool-call count (%s view)', (view) => {
  it('snapshot base + live tool_use frames; duplicates, covered frames and the journal replay stay exact', () => {
    let s: TranscriptState = createTranscriptState('s1', 'claude');
    expect(toolCallTotal(s)).toBeNull();
    s = applySnapshot(s, win(10, 300, view), { ...ctx(view, null, true), mode: 'replace' });
    expect(toolCallTotal(s)).toBe(300);
    s = applyFrame(s, tool('t9'), ctx(view, 9)).state;     // covered by the snapshot
    expect(toolCallTotal(s)).toBe(300);
    for (let i = 0; i < 20; i++) s = applyFrame(s, tool(`t${i + 11}`), ctx(view, 11 + i)).state;
    s = applyFrame(s, tool('t11'), ctx(view, 31)).state;   // same id again
    expect(toolCallTotal(s)).toBe(320);
    // A window read at 20 holds 310 of them; frames > 20 are replayed after it.
    s = applySnapshot(s, win(20, 310, view), { ...ctx(view, null, true), mode: 'tail' });
    for (let i = 10; i < 20; i++) s = applyFrame(s, tool(`t${i + 11}`), ctx(view, 11 + i, true)).state;
    expect(toolCallTotal(s)).toBe(320);
    // A snapshot without a count keeps the running total.
    s = applySnapshot(s, win(40, undefined, view), { ...ctx(view, null, true), mode: 'tail' });
    expect(toolCallTotal(s)).toBe(320);
  });
});
