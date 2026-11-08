// Pure helpers of POST /api/search/files (no DB, no RPC): which project roots
// the global palette fans out over, and how the merged hits are filtered and
// ranked. Roots come ONLY from the DB rows the route feeds in, never from the
// request.

export const MAX_SEARCH_ROOTS = 24;
export const MAX_FILE_HITS = 40;

export type RootCandidate = { vpsId: string; path: string; usedAt: number };

/** Absolute path without trailing slashes ('/' stays '/'); null when relative or odd. */
export function normalizeRoot(p: string): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) return null;
  if (!p.startsWith('/')) return null;
  const n = p.replace(/\/+$/, '');
  return n === '' ? '/' : n;
}

/** '/', '/root', '/home/<user>': walking those scans a whole account. */
export function isBroadRoot(p: string): boolean {
  return p === '/' || p === '/root' || /^\/home\/[^/]+$/.test(p);
}

/**
 * Deduplicated, outermost-only roots, most recently used first, capped. A root
 * nested inside another root of the same VPS is covered by the outer walk; its
 * recency is folded into the outer one.
 */
export function selectSearchRoots(cands: RootCandidate[], max = MAX_SEARCH_ROOTS): RootCandidate[] {
  const byKey = new Map<string, RootCandidate>();
  for (const c of cands) {
    const path = normalizeRoot(c.path);
    if (!path || isBroadRoot(path)) continue;
    const key = `${c.vpsId}\0${path}`;
    const prev = byKey.get(key);
    if (prev) prev.usedAt = Math.max(prev.usedAt, c.usedAt);
    else byKey.set(key, { vpsId: c.vpsId, path, usedAt: c.usedAt });
  }
  const list = [...byKey.values()].sort((a, b) => a.path.length - b.path.length);
  const kept: RootCandidate[] = [];
  for (const c of list) {
    const outer = kept.find((k) => k.vpsId === c.vpsId && c.path.startsWith(k.path + '/'));
    if (outer) outer.usedAt = Math.max(outer.usedAt, c.usedAt);
    else kept.push(c);
  }
  kept.sort((a, b) => b.usedAt - a.usedAt || a.path.localeCompare(b.path));
  return kept.slice(0, max);
}

/** Lower-cased whitespace-separated terms, deduplicated, bounded. */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const t of String(q ?? '').toLowerCase().split(/\s+/)) {
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

/** The term sent to the agent: the most selective one. */
export function longestTerm(terms: string[]): string {
  return terms.reduce((a, b) => (b.length > a.length ? b : a), '');
}

export type FileHit = { path: string; size: number; mtime: number };

/** 0 basename equals, 1 starts-with, 2 contains, 3 path contains; null = no AND match. */
export function fileTier(relPath: string, terms: string[]): number | null {
  const lower = relPath.toLowerCase();
  for (const t of terms) if (!lower.includes(t)) return null;
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  const key = longestTerm(terms);
  if (base === key) return 0;
  if (base.startsWith(key)) return 1;
  if (base.includes(key)) return 2;
  return 3;
}

/** AND-filter on the relative path, then rank: tier, shorter path, alphabetical. */
export function filterRankFiles<T extends FileHit>(hits: T[], terms: string[], limit = MAX_FILE_HITS): T[] {
  if (!terms.length) return [];
  const scored: Array<{ h: T; tier: number }> = [];
  for (const h of hits) {
    const tier = fileTier(h.path, terms);
    if (tier != null) scored.push({ h, tier });
  }
  scored.sort((a, b) => a.tier - b.tier || a.h.path.length - b.h.path.length || a.h.path.localeCompare(b.h.path));
  return scored.slice(0, limit).map((s) => s.h);
}
