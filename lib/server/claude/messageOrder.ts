import 'server-only';

// Chronological identity that survives crash-repair (Codex 16.3): a row
// repaired by the replay engine is INSERTED late (high id) but carries the
// seq of the moment it belongs to. Plain id-order would show it after rows
// it actually preceded. Key = the row's seq when stamped, else a MONOTONIC
// watermark of the highest seq seen so far in id order — nulls (user rows,
// legacy rows) stay anchored where they were inserted instead of being
// dragged backward by a low-seq repair row after them. Ties break by id, so
// fully-legacy sessions keep their exact historical order.
//
// THE single definition of the order (Codex 20.3): display sorting
// (orderChronologically, used by the ?since delta) AND page slicing
// (messageWindow.ts) both derive from chronologicalKeys — they can't drift.

/** rowsById MUST be sorted ascending by id. Returns id → chronological key. */
export function chronologicalKeys<T extends { id: number; seq: number | null }>(
  rowsById: T[],
): Map<number, number> {
  const key = new Map<number, number>();
  let watermark = 0;
  for (const r of rowsById) {
    if (typeof r.seq === 'number') {
      key.set(r.id, r.seq);
      if (r.seq > watermark) watermark = r.seq;
    } else {
      key.set(r.id, watermark);
    }
  }
  return key;
}

export function orderChronologically<T extends { id: number; seq: number | null }>(rows: T[]): T[] {
  const byId = [...rows].sort((a, b) => a.id - b.id);
  const key = chronologicalKeys(byId);
  return byId.sort((a, b) => (key.get(a.id)! - key.get(b.id)!) || (a.id - b.id));
}
