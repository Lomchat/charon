'use client';

/**
 * Whether the pending AskUserQuestion card is minimized, per session.
 *
 * The card does not live in the transcript: it replaces the input bar in
 * `.claude-pending-zone`, which is allowed 65vh. A question with several
 * options therefore covers most of the conversation that produced it — which
 * is exactly what you need to read before answering. Minimizing it gives the
 * transcript back without answering, cancelling, or losing the question.
 *
 * Persistence is deliberately ephemeral, matching `inputDraftStore.ts`:
 *   - Module-level Map → survives the remount from
 *     `<ClaudeSessionView key={selectedId}>`, so minimizing a question,
 *     reading another session and coming back keeps it minimized.
 *   - No localStorage → an F5 brings the card back open. A minimized question
 *     is an easy one to forget and questions auto-deny on a timer, so this
 *     state has no business outliving the tab.
 *
 * The stored value is the QUESTION ID, not a boolean. Only one pending
 * interaction renders at a time, so one entry per session bounds the Map
 * without any cleanup on resolve — and a stale entry left by an answered
 * question can never minimize the NEXT one, because the id will not match.
 * That property is what makes it safe to never garbage-collect this.
 */

const collapsedBySession = new Map<string, string>();

export function isQuestionCollapsed(sessionId: string, questionId: string): boolean {
  return collapsedBySession.get(sessionId) === questionId;
}

export function setQuestionCollapsed(sessionId: string, questionId: string, collapsed: boolean): void {
  if (collapsed) {
    collapsedBySession.set(sessionId, questionId);
    return;
  }
  // Only clear OUR entry: a different id means the session has already moved
  // on to another question, and dropping that would expand a card the user
  // just minimized.
  if (collapsedBySession.get(sessionId) === questionId) collapsedBySession.delete(sessionId);
}

/** Forget the session entirely (session closed / removed). */
export function clearQuestionCollapsed(sessionId: string): void {
  collapsedBySession.delete(sessionId);
}

/** Test seam: the Map is module state and would otherwise leak between tests. */
export function resetQuestionCollapsed(): void {
  collapsedBySession.clear();
}
