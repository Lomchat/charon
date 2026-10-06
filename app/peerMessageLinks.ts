import type { Msg } from './sessionTypes';

/** Resolve exact durable identities; a legacy handle is scoped to this VPS. */
export function peerSessionTarget(
  message: Msg,
  siblings: ReadonlyArray<{ id: string; handle: string }> = [],
): string | null {
  if (message.role === 'peer_status') {
    return message.peerTargetSessionId
      ?? siblings.find((session) => session.handle === message.peerTarget)?.id ?? null;
  }
  if (message.role === 'external') {
    return message.sourceSessionId
      ?? siblings.find((session) => session.handle === message.from)?.id ?? null;
  }
  return null;
}

export function peerRequestTarget(message: Msg): string | null {
  return message.replyTo
    ?? (message.role === 'peer_status' && message.peerStatus === 'replied'
      ? message.messageId ?? null : null);
}

/** An assistant answers the latest input, including an incoming peer message.
 * Reconstruct from the full loaded transcript before applying visibility
 * filters. A human input or fork boundary ends that peer context. */
export function peerAssistantReplies(messages: readonly Msg[]): {
  replyToById: Map<string, string>; streamingReplyTo: string | null;
} {
  const replyToById = new Map<string, string>();
  let inputId: string | null = null;
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'forkpoint') inputId = null;
    else if (message.role === 'external') inputId = message.messageId ?? message.id;
    else if (message.role === 'assistant') {
      const replyTo = message.replyTo ?? inputId;
      if (replyTo) replyToById.set(message.id, replyTo);
      // A page can begin after its input; the API supplies that durable anchor.
      if (message.replyTo) inputId = message.replyTo;
    }
  }
  return { replyToById, streamingReplyTo: inputId };
}
