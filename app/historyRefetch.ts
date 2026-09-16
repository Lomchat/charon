// When a full history reload may replace what the session view shows.
//
// `refetchHistory` serves the initial mount, SSE reconnects, tab foreground AND
// the 5s safety-net poll, which escalates to a full reload whenever the server
// holds rows the view has not seen. During tool-heavy work that is almost every
// tick: tool calls, tool results and thinking are persisted row by row.
//
// Two snapshots are in play, and each has one situation it can be trusted in:
//
//   - The CACHED copy is only as new as the previous full fetch. Painting it
//     first is what makes opening a session instant, and on first paint there
//     is nothing newer to lose. Once the view is live it is strictly older than
//     the screen: SSE has since appended tool rows and assistant text. Applying
//     it then removed those rows, and the fetch that should have restored them
//     is itself discarded whenever a live event lands mid-flight (below) — so
//     on the next tick the next stale copy removed the next rows. The result
//     was a transcript whose newest rows vanished and reappeared every few
//     seconds while tools ran, mostly visible with tool rows shown.
//
//   - A FRESH response is authoritative only if nothing live happened while it
//     was in flight; otherwise it predates the screen and is dropped, and the
//     view keeps its live state until a later reload lands in a quiet moment.

/** Whether to paint the cached snapshot before the network answers. */
export function shouldApplyCachedHistory(initialLoadDone: boolean): boolean {
  return !initialLoadDone;
}

/** Whether a fetched snapshot may replace the view. */
export function shouldApplyFetchedHistory(input: {
  initialLoadDone: boolean;
  /** Live-event revision when the request started. */
  revisionAtRequest: number;
  /** Live-event revision when the response arrived. */
  revisionNow: number;
}): boolean {
  return !input.initialLoadDone || input.revisionNow === input.revisionAtRequest;
}
