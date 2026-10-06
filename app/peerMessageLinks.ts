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
