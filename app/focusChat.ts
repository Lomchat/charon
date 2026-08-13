'use client';

/**
 * "This session was just created — put the cursor in its message box."
 *
 * The signal cannot be a prop: the wizard's callback lands in ClaudePanel, the
 * textarea lives three components down inside `ClaudeSessionView`'s memoized
 * `ChatInputBar`, and that bar does not exist yet when the request is made —
 * the session is still `starting`, and a pending permission/question card
 * replaces the bar entirely (`ClaudeSessionView` § the input area). So the
 * request is PARKED, exactly like `revealLine.ts` parks a scroll target, and
 * drained by the bar when it mounts.
 *
 * One-shot and keyed by session, both load-bearing: a focus meant for the
 * session you just created must never fire in another one, and reopening that
 * session an hour later must not steal the caret from whatever you were doing.
 */

const parked = new Set<string>();

/** Ask for the chat input of `sessionId` to take focus once it exists. */
export function requestChatFocus(sessionId: string): void {
  parked.add(sessionId);
  // A bar that never mounts (creation raced a close, the session died while
  // starting) would otherwise keep its claim forever and grab the caret on a
  // much later, unrelated open.
  setTimeout(() => parked.delete(sessionId), 20_000);
}

/** True at most once per request — the caller then focuses (or declines to). */
export function consumeChatFocus(sessionId: string): boolean {
  return parked.delete(sessionId);
}
