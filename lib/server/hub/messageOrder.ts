import 'server-only';

// THE single definition of chat order (Codex 20.3): display sorting
// (orderChronologically, used by the ?since delta) AND page slicing
// (messageWindow.ts) both derive from chronologicalKeys — they can't drift.
//
// ── The key is `ts_ms`: WHEN the event happened (§14.71) ────────────────────
// It used to be the agent's `seq`, which cannot be an order key: seq is
// per-session and RESTARTS AT 1 whenever the agent's durable event log is
// recreated (a daemon boots with an empty state.json → `cleanup_orphans`
// wipes `events/` → the hub re-creates the session via
// `start_session(claude_session_id=…)`). The hub kept stamping rows with the
// raw seq, so a transcript acquired a SECOND epoch numbered from 1 while the
// DB already held seqs in the thousands — and every reply of that new epoch
// sorted into the MIDDLE of the history, hundreds of positions back and
// outside the newest page, while null-seq user rows stayed pinned at the end.
// The signature was exact: "I only see my own messages; replies flash for a
// second then vanish" (flash = live SSE append, vanish = the 5s poll
// refetching the window without them). 8 of 16 live sessions were in that
// state, across resets spread over months.
//
// Wall-clock time has no epochs, so the whole class of bug disappears rather
// than being detected and compensated. It also handles the case seq was being
// abused for — a row REPAIRED by the replay engine is inserted late (high id)
// but carries the ts of the moment it belongs to, so it sorts back into place
// for free (§14.31).
//
// NOT `created_at`: that is INSERT time at SECOND granularity, so a repaired
// row would land at the end and a whole turn would share one value.
//
// Rows are stamped at insert (`sessionOps._persist` — agent `ts`, else now)
// and every pre-existing row was backfilled from `created_at * 1000` by
// migration 0026, so in practice no row is null. The null branch below is
// the belt to that suspender: such a row anchors to the running watermark,
// i.e. stays where it was inserted instead of jumping to the front.
//
// Caveat, accepted: ts comes from the VPS clock, so an NTP step backwards can
// locally invert two rows. Bounded and self-correcting — unlike a seq reset,
// which was permanent and swallowed entire turns.

/** rowsById MUST be sorted ascending by id. Returns id → chronological key. */
export function chronologicalKeys<T extends { id: number; tsMs?: number | null }>(
  rowsById: T[],
): Map<number, number> {
  const key = new Map<number, number>();
  let watermark = 0;
  for (const r of rowsById) {
    const ts = r.tsMs;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      key.set(r.id, ts);
      if (ts > watermark) watermark = ts;
    } else {
      key.set(r.id, watermark);
    }
  }
  return key;
}

export function orderChronologically<T extends { id: number; tsMs?: number | null }>(rows: T[]): T[] {
  const byId = [...rows].sort((a, b) => a.id - b.id);
  const key = chronologicalKeys(byId);
  // Ties break by id: ms granularity still collides inside a fast turn, and
  // within one millisecond insertion order IS the truth.
  return byId.sort((a, b) => (key.get(a.id)! - key.get(b.id)!) || (a.id - b.id));
}
