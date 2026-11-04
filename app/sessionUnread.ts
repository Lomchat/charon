// THE rule for the "finished, unread" cue (§14.47), shared by every surface
// that draws it. It is one face of the attention predicate
// (`lib/sessionAttention.ts`): a pending gate — blocking or async — outranks
// the green cue, so the same session never reads "come and see" and "needs
// you" at once.
//
// The MARKER is durable and server-owned (`agentSessions.unreadStop`, cleared
// by an attended focus). This is only about DRAWING it.
import { attentionForRow } from '@/lib/sessionAttention';

/** A turn, or the background work it launched, is still in flight (§14.91). */
export const WORKING_STATUSES = new Set(['thinking', 'starting', 'background']);

export function isWorkingStatus(status: string | null | undefined): boolean {
  return WORKING_STATUSES.has(String(status ?? ''));
}

export type UnreadCueInput = {
  /** The durable marker, as the row carries it. */
  unreadStop?: number | boolean | null;
  /** What the row is actually showing: `liveStatus ?? status`. */
  status?: string | null;
  /** Every pending gate (older hubs send only this; read as blocking). */
  pendingPermissions?: number | null;
  pendingBlocking?: number | null;
  /** Async questions (§14.96): a question outranks the green cue too. */
  pendingAsync?: number | null;
  /** The session the user is reading right now. */
  selected?: boolean;
};

/**
 * Whether the cue is worth drawing on this row.
 *
 * READY only. The cue asks you to go and READ an answer, so it needs a session
 * still there to answer: a paused card already says paused, a failed one is
 * red, and a working one has not finished — a green "come and see" over any of
 * them is noise. `active` (running and idle) is exactly that state, which is
 * why it also subsumes the working test.
 */
export function showsUnreadCue(row: UnreadCueInput): boolean {
  return attentionForRow({
    status: String(row.status ?? ''),
    unreadStop: row.unreadStop,
    pendingPermissions: row.pendingPermissions,
    pendingBlocking: row.pendingBlocking,
    pendingAsync: row.pendingAsync,
  }, { viewedHere: !!row.selected }) === 'unread';
}
