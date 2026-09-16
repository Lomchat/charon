// THE rule for the "finished, unread" cue (§14.47), shared by the two surfaces
// that draw it: the sidebar card and the header nav. One predicate, or the same
// green pulse ends up meaning two different things three inches apart.
//
// The MARKER is durable and server-owned (`claudeSessions.unreadStop`, cleared
// by focus). This is only about DRAWING it.

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
  pendingPermissions?: number | null;
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
  if (!row.unreadStop) return false;
  if (row.selected) return false;                      // you are reading it
  if ((row.pendingPermissions ?? 0) > 0) return false; // a gate is more urgent
  return String(row.status ?? '') === 'active';
}
