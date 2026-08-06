// Shared dotted-version helpers.
//
// PLAIN module on purpose: imported by BOTH client components (Sidebar badge)
// and server code (sdkSync, auto-update tick). No 'server-only', no deps.

/**
 * Compare two dotted versions numerically per segment ("0.2.87" < "0.2.116").
 * Missing segments count as 0 ("1.2" == "1.2.0"). Non-numeric suffixes inside
 * a segment (e.g. "1rc1") compare by leading integer then string fallback.
 * Returns -1 | 0 | 1. Null/empty input sorts first.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa || !sb) return sa === sb ? 0 : (sa ? 1 : -1);
  const pa = sa.split('.');
  const pb = sb.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ra = pa[i] ?? '0';
    const rb = pb[i] ?? '0';
    const na = parseInt(ra, 10);
    const nb = parseInt(rb, 10);
    const va = Number.isNaN(na) ? 0 : na;
    const vb = Number.isNaN(nb) ? 0 : nb;
    if (va !== vb) return va < vb ? -1 : 1;
    // Same leading integer — break ties on the raw segment string ("1rc1" vs "1")
    if (ra !== rb) return ra < rb ? -1 : 1;
  }
  return 0;
}

/** True when both versions are known and `installed` is strictly older. */
export function isVersionOutdated(installed: string | null | undefined, latest: string | null | undefined): boolean {
  if (!installed || !latest) return false;
  return compareVersions(installed, latest) < 0;
}

/**
 * Where a VPS's deployed charon-agent sits relative to the pyz THIS hub ships
 * (§14.6). ORDERED comparison of `__version__` — the pyz sha is deliberately
 * NOT part of the verdict:
 *
 *   'outdated' → built is strictly newer ⇒ deploy (badge + auto-update tick)
 *   'ahead'    → the VPS runs a NEWER agent than this hub builds ⇒ HANDS OFF.
 *                This branch is the whole point: two hubs sharing a VPS on
 *                different commits used to see each other's pyz as "not my
 *                sha" and rolled it back and forth every 30min (§14.70).
 *                A strict order cannot cycle, so the ping-pong is gone.
 *   'current'  → same version. A different sha at the same version (rebuild
 *                without a bump, two hubs on sibling commits) is IGNORED by
 *                design — hence: bump `__version__` on ANY agent change, it
 *                is the ONLY propagation signal (§17).
 *   'unknown'  → either side unreported ⇒ never act.
 */
export type AgentBuildRelation = 'unknown' | 'outdated' | 'current' | 'ahead';

export function agentBuildRelation(
  deployedVersion: string | null | undefined,
  builtVersion: string | null | undefined,
): AgentBuildRelation {
  const d = String(deployedVersion ?? '').trim();
  const b = String(builtVersion ?? '').trim();
  if (!d || !b) return 'unknown';
  const c = compareVersions(b, d);
  return c > 0 ? 'outdated' : c < 0 ? 'ahead' : 'current';
}

/** True iff this hub ships a strictly newer agent than the VPS runs. */
export function isAgentOutdated(
  deployedVersion: string | null | undefined,
  builtVersion: string | null | undefined,
): boolean {
  return agentBuildRelation(deployedVersion, builtVersion) === 'outdated';
}
