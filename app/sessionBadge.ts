// THE rule for "this session is waiting on you", shared by every surface that
// draws it: the sidebar card, the header nav and the tab strip. One predicate,
// or the same lock means three different things in three corners of the screen
// — which is exactly what it did before this module existed.
//
// Two sources answer "is it waiting", and they do NOT agree in time:
//
//   - `pendingPermissions` on the session row is a COUNT from the list
//     endpoint (permissions + questions + exit plans, cf. the sessions route).
//     It only moves when the list is refetched — the 60s poll, a visibility
//     change, a session_list_changed ping. Nothing about a prompt firing or
//     being answered refetches the list, so this number is stale for as long
//     as a minute in both directions.
//
//   - The SSE queues (permission_request / user_question / exit_plan_request,
//     emptied by interaction_resolved) move the instant the hub speaks. They
//     are also COMPLETE rather than a delta: /api/claude/events replays every
//     pending row on connect, so a freshly (re)connected stream holds the
//     whole picture, not just what happened since.
//
// Live therefore wins once the stream has synced. Taking the union instead
// ("show the lock if EITHER says so") looks safer and is not: after you answer,
// the stale count keeps the lock lit until the next poll, which is the whole
// bug. The count is used only to seed the first paint, before the stream has
// said anything.

/** One pending interaction, as the client queues carry it. */
export type PendingRef = { sessionId: string };

/**
 * How many interactions each session is currently blocked on, from the live
 * queues. Presence and count in one pass — the card draws 🔒N, not just 🔒.
 */
export function liveWaitingCounts(
  perms: readonly PendingRef[],
  questions: readonly PendingRef[],
  exitPlans: readonly PendingRef[],
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const queue of [perms, questions, exitPlans]) {
    for (const item of queue) {
      if (!item?.sessionId) continue;
      out.set(item.sessionId, (out.get(item.sessionId) ?? 0) + 1);
    }
  }
  return out;
}

export type WaitingInput = {
  /** The row's count from the list endpoint. Stale by up to a poll interval. */
  pendingPermissions?: number | null;
  /** This session's entry in the live queues. Absent = zero, once synced. */
  liveWaitingCount?: number | null;
  /**
   * Has the SSE stream delivered anything yet? Until it has, the queues are
   * empty because nothing has arrived — not because nothing is pending — and
   * the server-rendered count is the only thing that knows.
   */
  liveSynced: boolean;
};

/** How many interactions to draw this session as blocked on. */
export function waitingCount(input: WaitingInput): number {
  if (!input.liveSynced) return Math.max(0, input.pendingPermissions ?? 0);
  return Math.max(0, input.liveWaitingCount ?? 0);
}

/**
 * Statuses a pending prompt may be drawn over.
 *
 * A prompt fires MID-TURN: the agent sets 'thinking' when the turn begins and
 * only returns to 'active' when it ends, so a session waiting on you is almost
 * always 'thinking'. The old sidebar rule promoted to 'waiting' only from
 * 'active', which meant the word NEEDS YOU was unreachable in the one case it
 * was for — the card said WORKING while it sat blocked on a question.
 *
 * It is still not every status. A pending row against a session that is
 * sleeping, failed or gone is a leftover the turn never resolved; "needs you"
 * over a dead session asks for something that cannot be given.
 */
export const WAITING_PROMOTABLE = new Set(['active', 'thinking', 'starting', 'background']);

export type BadgeInput = {
  /** The durable row status. */
  status?: string | null;
  /** The live status patched from the status bus; preferred when present. */
  liveStatus?: string | null;
  /** Already resolved through `waitingCount`. */
  waiting: number;
};

/**
 * The single state word for a session row: 'waiting' when it is blocked on you
 * and alive enough to answer, otherwise whatever it is actually doing.
 */
export function badgeState(input: BadgeInput): string {
  const base = String(input.liveStatus ?? input.status ?? '');
  if (input.waiting > 0 && WAITING_PROMOTABLE.has(base)) return 'waiting';
  return base;
}
