import type { Vps } from '@/lib/db/schema';
import type { VpsRuntimeSnapshot } from '@/lib/types/api';

const RUNTIME_KEYS = [
  'agentStatus',
  'agentVersion',
  'agentPyzSha',
  'agentLastError',
  'sdkVersion',
  'codexAvailable',
  'codexSdkVersion',
  'codexCliVersion',
  'claudeLoggedIn',
  'codexLoggedIn',
] as const satisfies ReadonlyArray<Exclude<keyof VpsRuntimeSnapshot, 'id'>>;

/** Merge an authoritative runtime snapshot without replacing static VPS data.
 * Returns the original array when every field already matches, avoiding a
 * fleet-wide sidebar render on each convergence poll. */
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
    if (RUNTIME_KEYS.every((key) => row[key] === snapshot[key])) return row;
    changed = true;
    return { ...row, ...snapshot };
  });
  return changed ? next : current;
}
