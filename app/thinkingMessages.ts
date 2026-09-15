import type { Msg } from './sessionTypes';

// Only streamed fragments concatenate. Imported reasoning and complete SDK
// blocks keep their own boundaries; tokens retain their exact whitespace.
function joinThinking(previous: Msg | undefined, next: Msg): Msg | null {
  if (previous?.role !== 'thinking' || next.role !== 'thinking'
      || !previous.thinkingDelta || !next.thinkingDelta || previous.thinkingClosed) return null;
  return { ...previous, content: previous.content + next.content, thinkingClosed: next.thinkingClosed };
}

export function appendThinkingMessage(messages: Msg[], message: Msg): Msg[] {
  if (!message.content) return messages;
  const joined = joinThinking(messages[messages.length - 1], message);
  return joined ? [...messages.slice(0, -1), joined] : [...messages, message];
}

export function closeThinkingMessage(messages: Msg[]): Msg[] {
  const last = messages[messages.length - 1];
  if (last?.role !== 'thinking' || !last.thinkingDelta || last.thinkingClosed) return messages;
  return [...messages.slice(0, -1), { ...last, thinkingClosed: true }];
}

// A page boundary may cut a streamed block in two. Join just that boundary,
// leaving every other message and its React identity intact.
export function prependMessagePage(older: Msg[], current: Msg[]): Msg[] {
  if (!older.length) return current;
  if (!current.length) return older;
  const joined = joinThinking(older[older.length - 1], current[0]);
  return joined
    ? [...older.slice(0, -1), joined, ...current.slice(1)]
    : [...older, ...current];
}
