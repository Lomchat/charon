import type { Vps } from '@/lib/db/schema';
import type { VpsRuntimeSnapshot } from '@/lib/types/api';
import { VPS_RUNTIME_KEYS } from '@/lib/vpsRuntimeFields';

/** Merge an authoritative runtime snapshot without replacing static VPS data.
 * Returns the original array when every field already matches, avoiding a
 * fleet-wide sidebar render on each convergence poll.
 *
 * The compared key set is DERIVED from the provider registry
 * (`lib/vpsRuntimeFields`): hand-listed, it silently stopped covering the third
 * backend, so a snapshot that differed only on a cursor column compared EQUAL
 * and the poll kept the stale row (§14.52). */
export function mergeVpsRuntimeSnapshots(
  current: Vps[],
  snapshots: VpsRuntimeSnapshot[],
): Vps[] {
  if (snapshots.length === 0 || current.length === 0) return current;
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot] as const));
  let changed = false;
  const next = current.map((row) => {
    const snapshot = byId.get(row.id);
    if (!snapshot) return row;
    const same = VPS_RUNTIME_KEYS.every((key) => (
      (row as Record<string, unknown>)[key] === (snapshot as Record<string, unknown>)[key]
    ));
    if (same) return row;
    changed = true;
    return { ...row, ...snapshot };
  });
  return changed ? next : current;
}
