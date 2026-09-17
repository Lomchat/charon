import { describe, it, expect } from 'vitest';
import { buildInteractionPopupQueue } from '@/app/interactionPopup';

// Two failures these pin:
//
//   1. The popup showed the FOCUSED session's permission — prioritised it, in
//      fact — on top of the inline card that session already renders in its
//      composer slot. The same request, twice, with the worse copy on top.
//   2. It only ever read the permission queue. Questions and exit plans are
//      surfaced identically by the hub (broadcast + push + Telegram) but had
//      no popup at all, so on a background session they were left to the
//      sidebar lock and the tab dot.

const perm = (over: Partial<Parameters<typeof buildInteractionPopupQueue>[0]['perms'][number]> = {}) => ({
  id: 'p1', sessionId: 's2', tool: 'Bash', createdAt: 100, ...over,
});
const question = (over: Record<string, unknown> = {}) => ({
  id: 'q1', sessionId: 's2', createdAt: 100,
  questions: [{ question: 'Which database?' }], ...over,
});
const plan = (over: Record<string, unknown> = {}) => ({
  id: 'e1', sessionId: 's2', createdAt: 100, ...over,
});

const build = (over: Partial<Parameters<typeof buildInteractionPopupQueue>[0]> = {}) =>
  buildInteractionPopupQueue({
    perms: [], questions: [], exitPlans: [], currentSessionId: null, ...over,
  });

describe('leaving the focused session alone', () => {
  it('drops a permission belonging to the session on screen', () => {
    expect(build({ perms: [perm({ sessionId: 's1' })], currentSessionId: 's1' })).toEqual([]);
  });

  it('drops a question belonging to the session on screen', () => {
    expect(build({ questions: [question({ sessionId: 's1' })], currentSessionId: 's1' })).toEqual([]);
  });

  it('drops an exit plan belonging to the session on screen', () => {
    expect(build({ exitPlans: [plan({ sessionId: 's1' })], currentSessionId: 's1' })).toEqual([]);
  });

  it('keeps interactions from every other session', () => {
    const out = build({ perms: [perm({ sessionId: 's2' })], currentSessionId: 's1' });
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('s2');
  });

  it('shows everything when no session is focused', () => {
    const out = build({ perms: [perm()], questions: [question()], currentSessionId: null });
    expect(out).toHaveLength(2);
  });

  it('hides the popup entirely when only the focused session is waiting', () => {
    // The whole point: you are looking at the card already.
    const out = build({
      perms: [perm({ sessionId: 's1' })],
      questions: [question({ id: 'q9', sessionId: 's1' })],
      currentSessionId: 's1',
    });
    expect(out).toEqual([]);
  });
});

describe('covering all three interaction kinds', () => {
  it('includes a question from a background session', () => {
    const out = build({ questions: [question()], currentSessionId: 's1' });
    expect(out[0].kind).toBe('question');
  });

  it('includes an exit plan from a background session', () => {
    const out = build({ exitPlans: [plan()], currentSessionId: 's1' });
    expect(out[0].kind).toBe('exit_plan');
  });

  it('carries all three at once', () => {
    const out = build({
      perms: [perm({ createdAt: 1 })],
      questions: [question({ createdAt: 2 })],
      exitPlans: [plan({ createdAt: 3 })],
      currentSessionId: 's1',
    });
    expect(out.map((i) => i.kind)).toEqual(['permission', 'question', 'exit_plan']);
  });
});

describe('what can be answered from a corner card', () => {
  it('lets a permission be answered in place', () => {
    expect(build({ perms: [perm()] })[0].answerable).toBe(true);
  });

  it('sends a question to its session instead of truncating it', () => {
    expect(build({ questions: [question()] })[0].answerable).toBe(false);
  });

  it('sends a plan to its session instead of truncating it', () => {
    expect(build({ exitPlans: [plan()] })[0].answerable).toBe(false);
  });
});

describe('labels', () => {
  it('names the tool for a permission', () => {
    expect(build({ perms: [perm({ tool: 'Write' })] })[0].label).toBe('Write');
  });

  it('uses the first question text', () => {
    expect(build({ questions: [question()] })[0].label).toBe('Which database?');
  });

  it('falls back when a question carries no readable text', () => {
    const out = build({ questions: [question({ questions: [{ question: '   ' }] })] });
    expect(out[0].label).toBe('question awaiting your reply');
  });

  it('falls back when a question carries no entries at all', () => {
    expect(build({ questions: [question({ questions: [] })] })[0].label)
      .toBe('question awaiting your reply');
  });

  it('describes an exit plan without needing its body', () => {
    // The plan text can run to pages; the popup must not depend on it.
    expect(build({ exitPlans: [plan()] })[0].label).toBe('plan ready for approval');
  });
});

describe('ordering', () => {
  it('puts the longest-waiting interaction first, since it expires first', () => {
    const out = build({
      perms: [perm({ id: 'late', createdAt: 300 }), perm({ id: 'early', createdAt: 100 })],
    });
    expect(out.map((i) => i.id)).toEqual(['early', 'late']);
  });

  it('orders across kinds by age, not by queue', () => {
    const out = build({
      perms: [perm({ id: 'p', createdAt: 500 })],
      questions: [question({ id: 'q', createdAt: 200 })],
    });
    expect(out.map((i) => i.id)).toEqual(['q', 'p']);
  });

  it('breaks ties by id so the order cannot flicker between renders', () => {
    const out = build({
      perms: [perm({ id: 'b', createdAt: 100 }), perm({ id: 'a', createdAt: 100 })],
    });
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

// The reported sequence: you are working in s1, and s2 stops to ask something.
describe('a question arriving on a background session', () => {
  it('raises a popup that identifies it without trying to render it', () => {
    const out = build({
      questions: [question({ sessionId: 's2', questions: [{ question: 'Deploy to prod?' }] })],
      currentSessionId: 's1',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'question', sessionId: 's2', label: 'Deploy to prod?', answerable: false,
    });
  });

  it('stops showing it once you switch to that session', () => {
    const questions = [question({ sessionId: 's2' })];
    expect(build({ questions, currentSessionId: 's1' })).toHaveLength(1);
    expect(build({ questions, currentSessionId: 's2' })).toEqual([]);
  });
});
