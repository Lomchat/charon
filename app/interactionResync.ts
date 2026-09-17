// Reconciling the cross-session interaction queues with a fresh connect
// snapshot, without ever going blind in between.
//
// The queues are built from live events and survive only in component state:
// nothing repopulates them except an arriving event or a remount. That makes
// CLEARING them dangerous in a way that is easy to miss. A reconnect handler
// that empties the queues and waits for the replay to refill them is correct
// only if the replay always arrives; if it is missed, delayed past the grace,
// or dropped, the queues stay empty until the user presses F5 — and once the
// badge treats live as authoritative, the list poll can no longer paper over
// it either. That shipped, and it read exactly as reported: the popup and the
// NEEDS YOU badge worked after a refresh, stopped at some later reconnect, and
// came back only on the next refresh.
//
// So the queues are never emptied on reconnect. The old entries stay on screen
// — they were true a moment ago, and a stale prompt is a far smaller harm than
// a missing one — while the incoming snapshot is recorded. When the snapshot
// has drained, anything it did NOT mention is dropped: that, and only that, is
// the evidence an interaction was resolved while this tab was away.
//
// Replace-when-you-have-the-replacement, rather than clear-and-hope.

/** Anything the queues hold: identity is the interaction id. */
export type Identified = { id: string };

/**
 * Keep only the entries the fresh snapshot confirmed are still pending.
 *
 * `confirmed` is every interaction id seen since the resync began — the
 * replayed snapshot plus anything that fired while it was arriving. An entry
 * missing from it was resolved while this tab was disconnected, and
 * `interaction_resolved` is live-only, so this is the sole way to learn that.
 *
 * Returns the original array when nothing is dropped, so an unchanged queue
 * does not re-render every consumer on every reconnect.
 */
export function pruneUnconfirmed<T extends Identified>(
  queue: readonly T[],
  confirmed: ReadonlySet<string>,
): T[] {
  const kept = queue.filter((item) => confirmed.has(item.id));
  return kept.length === queue.length ? (queue as T[]) : kept;
}
