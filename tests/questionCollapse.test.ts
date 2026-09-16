import { describe, it, expect, beforeEach } from 'vitest';
import {
  isQuestionCollapsed,
  setQuestionCollapsed,
  clearQuestionCollapsed,
  resetQuestionCollapsed,
} from '../app/questionCollapse';

/**
 * Minimized state for the pending AskUserQuestion card.
 *
 * The property that matters is the one that is easy to get wrong by storing a
 * boolean: the store is never garbage-collected when a question is answered,
 * so a leftover entry MUST NOT minimize the next question to arrive. That only
 * holds because the question id is what is stored — so that is what these
 * tests pin, alongside session isolation and the bound on growth.
 */
describe('questionCollapse', () => {
  beforeEach(() => resetQuestionCollapsed());

  it('defaults to expanded', () => {
    expect(isQuestionCollapsed('s1', 'q1')).toBe(false);
  });

  it('round-trips a minimize and a restore', () => {
    setQuestionCollapsed('s1', 'q1', true);
    expect(isQuestionCollapsed('s1', 'q1')).toBe(true);
    setQuestionCollapsed('s1', 'q1', false);
    expect(isQuestionCollapsed('s1', 'q1')).toBe(false);
  });

  // The reason the value is an id and not a boolean. Nothing clears the entry
  // when a question is answered, so the next question lands on a dirty store.
  it('does not minimize a new question left minimized by the previous one', () => {
    setQuestionCollapsed('s1', 'q1', true);
    expect(isQuestionCollapsed('s1', 'q2')).toBe(false);
  });

  it('keeps sessions independent', () => {
    setQuestionCollapsed('s1', 'q1', true);
    expect(isQuestionCollapsed('s2', 'q1')).toBe(false);
    setQuestionCollapsed('s2', 'q1', true);
    expect(isQuestionCollapsed('s1', 'q1')).toBe(true);
  });

  // Restoring a question the session has already moved past must not disturb
  // the card the user is actually looking at.
  it('ignores a restore aimed at a superseded question', () => {
    setQuestionCollapsed('s1', 'q2', true);
    setQuestionCollapsed('s1', 'q1', false);
    expect(isQuestionCollapsed('s1', 'q2')).toBe(true);
  });

  // One entry per session: minimizing a second question replaces the first
  // rather than accumulating, which is what makes never cleaning up safe.
  it('holds at most one question per session', () => {
    setQuestionCollapsed('s1', 'q1', true);
    setQuestionCollapsed('s1', 'q2', true);
    expect(isQuestionCollapsed('s1', 'q1')).toBe(false);
    expect(isQuestionCollapsed('s1', 'q2')).toBe(true);
  });

  it('forgets a session on clear', () => {
    setQuestionCollapsed('s1', 'q1', true);
    clearQuestionCollapsed('s1');
    expect(isQuestionCollapsed('s1', 'q1')).toBe(false);
  });
});
