// Reconciliation of the live "assistant is typing" preview (the `__streaming`
// bubble) against a server payload — the GET/poll envelope's `streamingText`,
// i.e. the hub's own unflushed accumulation (sessionOps § getStreamingText).
//
// Two transports feed one buffer: SSE deltas (fast, live-only) and the REST
// envelope (the catch-up truth, §14.24). The browser must never rewind a
// smoothly-streaming preview to an older snapshot — but it must also be ABLE
// to drop it, and that half was missing: the only clear paths were a live
// boundary event (which a finished session will never send again) and a
// prefix test against the LAST assistant row. A preview captured mid-turn,
// before the tool calls and the paragraphs that followed it, matches neither —
// so it stayed pinned under the transcript, rendered as plain text, looking
// exactly like a reply being generated in a session that had finished hours
// ago. Hence the settled rule below. cf. CLAUDE.md §14.105.

/** Statuses during which a turn may legitimately be producing text. Anything
 *  else means nobody is writing, so an empty server buffer is the truth.
 *  `reconnecting` is deliberately in: we don't know yet. */
const TURN_IN_FLIGHT = new Set(['thinking', 'starting', 'reconnecting']);

export type StreamingPreviewInput = {
  /** `streamingText` from the session GET / delta poll. */
  serverText: string;
  /** What this browser accumulated from SSE deltas since the last flush. */
  localText: string;
  /** Authoritative live status (`liveStatus ?? session.status`). Unknown =>
   *  treated as possibly in flight, i.e. the preview is preserved. */
  status: string | null | undefined;
  /** Content of the most recent assistant row of the reloaded window, when
   *  the caller has one (full reload only — the delta poll has no window). */
  lastAssistant?: string | null;
};

/**
 * The text the preview bubble should hold after applying `serverText`.
 * Pure: the caller assigns the result to both the ref and the state.
 */
export function reconcileStreamingPreview(input: StreamingPreviewInput): string {
  const { serverText, localText, status, lastAssistant } = input;
  // Caught up or ahead (the common case: the hub processes deltas before
  // forwarding them to us) — adopt. Also the empty/empty no-op.
  if (serverText.length >= localText.length) return serverText;
  // The hub holds NOTHING and no turn is running: whatever we are showing was
  // flushed to a row, replayed, or belongs to a turn that ended. Drop it.
  // Conditioned on an empty server buffer, so a boundary the SSE hasn't
  // delivered yet cannot truncate a live answer: mid-turn the hub is
  // re-accumulating and the branch above adopts instead. A status we cannot
  // read is not a settled one — fall through to the proof below.
  if (serverText === '' && !!status && !TURN_IN_FLIGHT.has(status)) return '';
  // Still (possibly) streaming: only drop what we can PROVE was persisted.
  if (lastAssistant != null
      && (lastAssistant === localText || lastAssistant.startsWith(localText))) return '';
  // Mid-stream, the hub is briefly behind us — don't rewind.
  return localText;
}
