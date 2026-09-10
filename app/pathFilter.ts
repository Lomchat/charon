/**
 * Sidebar filter, driven by the URL. Two independent dimensions: WHICH
 * MACHINE, and WHICH FOLDER.
 *
 *   ?path=/srv/app                     one folder
 *   ?path=/srv/app&path=/srv/api       several
 *   ?path=!/srv/scratch                everything EXCEPT
 *   ?path=/srv&path=!/srv/scratch      a subtree, minus one branch
 *   ?path=!/&path=/srv/app             nothing BUT that subtree
 *   ?vps=<id>                          one machine
 *   ?vps=!<id>                         every machine except that one
 *   ?vps=<id>&path=/srv/charon         that folder ON that machine
 *
 * The parameters are REPEATED rather than comma-separated: a path may contain
 * almost anything, and `URLSearchParams.getAll()` handles repetition natively,
 * so there is no escaping rule to invent.
 *
 * The two dimensions are crossed with AND, and NOT merged into one compound
 * `<vps>:<path>` key. Paths form a hierarchy and resolve by specificity;
 * machines are a flat set with no ancestry, so there is nothing for a
 * specificity ladder to rank. Crossing two simple rules is something a reader
 * can hold in their head; one grammar with two kinds of entry, whose
 * precedence depends on which half is more specific, is not. It also means
 * `?path=` alone keeps its exact old meaning — that folder wherever it exists.
 *
 * A machine is named by its ID and never by its name: nobody hand-writes
 * these URLs (the builder exists so you don't), and renaming a box must not
 * break a bookmark.
 *
 * A URL is bookmarkable and per-window, which is the point: one bookmark per
 * project gives back a "one desktop per project" workflow without any extra
 * server state, and it composes with the existing `?session=` / `?shell=`
 * deep links.
 *
 * Pure functions, no dependencies — unit-tested in tests/pathFilter.test.ts.
 */

export type PathFilter = { include: string[]; exclude: string[] };

/**
 * Same shape as PathFilter, so the builder's three-state helpers below work on
 * both — but the entries are opaque VPS ids, matched whole. No `isUnder`, no
 * `bestMatch`: one machine is never "inside" another.
 */
export type VpsFilter = { include: string[]; exclude: string[] };

/**
 * Same rule as workspaceScope.normalizeWorkspacePath: trailing slashes go,
 * the root stays "/". Kept separate so this module has no import cycle with
 * the workspace helper, which pulls in UI concerns.
 */
export function normalizePath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '') || '/';
}

/**
 * Values starting with `!` exclude, everything else includes.
 *
 * The `!` is looked for AFTER trimming: a value pasted from a chat or a README
 * often carries a leading space, and testing the raw string would turn
 * `" !/srv/scratch"` into an include of a literal path that matches nothing —
 * i.e. "hide one folder" would silently become "hide everything".
 *
 * A path that genuinely starts with `!` cannot be expressed: an acceptable
 * trade-off for a filter meant to be typed by hand and read at a glance.
 */
export function parsePathFilter(values: readonly string[]): PathFilter {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    const negated = trimmed.startsWith('!');
    const normalized = normalizePath(negated ? trimmed.slice(1) : trimmed);
    if (!normalized) continue;
    const target = negated ? exclude : include;
    if (!target.includes(normalized)) target.push(normalized);
  }
  return { include, exclude };
}

/**
 * The VPS half. Same `!` convention and the same trim-first reason as
 * parsePathFilter; no normalization beyond the trim, because an id is opaque.
 */
export function parseVpsFilter(values: readonly string[]): VpsFilter {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    const negated = trimmed.startsWith('!');
    const id = (negated ? trimmed.slice(1) : trimmed).trim();
    if (!id) continue;
    const target = negated ? exclude : include;
    if (!target.includes(id)) target.push(id);
  }
  return { include, exclude };
}

/** Works on either half: both are `{ include, exclude }`. */
export function isFilterActive(filter: PathFilter | VpsFilter): boolean {
  return filter.include.length > 0 || filter.exclude.length > 0;
}

/**
 * Membership, not specificity. An explicit exclusion always wins (same tie
 * rule as the paths: hiding is the safer reading of a contradiction), and a
 * non-empty inclusion list turns the filter into an allow-list.
 */
export function isVpsVisible(vpsId: string, filter: VpsFilter): boolean {
  if (!isFilterActive(filter)) return true;
  if (filter.exclude.includes(vpsId)) return false;
  if (filter.include.length > 0) return filter.include.includes(vpsId);
  return true;
}

/**
 * Prefix match, but SEGMENT-WISE: `/srv/ap` must not catch `/srv/app`.
 * The root `/` catches everything.
 */
function isUnder(path: string, prefix: string): boolean {
  if (prefix === '/') return true;
  return path === prefix || path.startsWith(prefix + '/');
}

/**
 * Longest matching prefix, or -1. The length IS the specificity: "/" scores 1,
 * "/srv/app" scores 8, so a rule about a deep folder outranks one about a
 * shallow one.
 */
function bestMatch(path: string, prefixes: readonly string[]): number {
  let best = -1;
  for (const prefix of prefixes) {
    if (isUnder(path, prefix)) best = Math.max(best, prefix.length);
  }
  return best;
}

/**
 * The MOST SPECIFIC rule wins, the way rsync and .gitignore resolve theirs.
 *
 * That matters as soon as you combine the two: excluding "/" while including
 * "/srv/app" has to mean "only /srv/app", not "nothing" — and "/srv" plus
 * "!/srv/scratch" still carves the branch out, because the exclusion is the
 * deeper rule there. A tie goes to the exclusion: with both "/x" and "!/x"
 * spelled out, hiding is the safer reading.
 *
 * With no inclusion at all, everything not excluded stays visible.
 *
 * `unknown` decides what happens to an entity with no path at all, and the two
 * callers genuinely want opposite answers:
 *   - 'visible' (default) for sessions, whose cwd is always set — an entity
 *     whose location we cannot read should not vanish silently.
 *   - 'hidden' for shells, which are stored with cwd=null whenever they were
 *     opened without an explicit directory (the common case). Showing every
 *     home shell of every machine would defeat the filter entirely.
 */
export function isPathVisible(
  path: string | null | undefined,
  filter: PathFilter,
  unknown: 'visible' | 'hidden' = 'visible',
): boolean {
  if (!isFilterActive(filter)) return true;
  const normalized = normalizePath(path);
  if (normalized === null) return unknown === 'visible';
  const included = bestMatch(normalized, filter.include);
  const excluded = bestMatch(normalized, filter.exclude);
  if (excluded >= 0 && excluded >= included) return false;
  if (included >= 0) return true;
  return filter.include.length === 0;
}

/**
 * Rebuilds the query string. Round-trips through parsePathFilter /
 * parseVpsFilter. `vps` comes FIRST so the readable half of the URL is the
 * one you scan for in a bookmark bar.
 */
export function buildFilterQuery(filter: PathFilter, vps?: VpsFilter): string {
  const params = new URLSearchParams();
  if (vps) {
    for (const id of vps.include) params.append('vps', id);
    for (const id of vps.exclude) params.append('vps', '!' + id);
  }
  for (const p of filter.include) params.append('path', p);
  for (const p of filter.exclude) params.append('path', '!' + p);
  const query = params.toString();
  return query ? '?' + query : '';
}

/** A path's state in the URL builder: included / excluded / ignored. */
export type PathState = 'include' | 'exclude' | 'off';

export function pathState(path: string, filter: PathFilter | VpsFilter): PathState {
  if (filter.include.includes(path)) return 'include';
  if (filter.exclude.includes(path)) return 'exclude';
  return 'off';
}

/** Cycles off → include → exclude → off, for a three-state button. */
export function nextPathState(state: PathState): PathState {
  if (state === 'off') return 'include';
  if (state === 'include') return 'exclude';
  return 'off';
}

export function withPathState<F extends PathFilter | VpsFilter>(
  filter: F, path: string, state: PathState,
): { include: string[]; exclude: string[] } {
  const include = filter.include.filter((p) => p !== path);
  const exclude = filter.exclude.filter((p) => p !== path);
  if (state === 'include') include.push(path);
  if (state === 'exclude') exclude.push(path);
  return { include, exclude };
}

/**
 * Human-readable summary. `nameOf` turns a VPS id back into its name: the id
 * is what travels in the URL, but a summary reading "e8c8d7b348e12a01" tells
 * the reader nothing about what is hidden — which is the summary's only job.
 */
export function describeFilter(
  filter: PathFilter,
  vps?: VpsFilter,
  nameOf: (id: string) => string = (id) => id,
): string {
  const parts: string[] = [];
  if (vps?.include.length) parts.push(vps.include.map(nameOf).join(', '));
  if (vps?.exclude.length) parts.push('except ' + vps.exclude.map(nameOf).join(', '));
  if (filter.include.length) parts.push(filter.include.join(', '));
  if (filter.exclude.length) parts.push('except ' + filter.exclude.join(', '));
  return parts.join(' — ');
}
