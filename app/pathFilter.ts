/**
 * Sidebar path filter, driven by the URL.
 *
 *   ?path=/srv/app                     one folder
 *   ?path=/srv/app&path=/srv/api       several
 *   ?path=!/srv/scratch                everything EXCEPT
 *   ?path=/srv&path=!/srv/scratch      a subtree, minus one branch
 *   ?path=!/&path=/srv/app             nothing BUT that subtree
 *
 * The parameter is REPEATED rather than comma-separated: a path may contain
 * almost anything, and `URLSearchParams.getAll()` handles repetition natively,
 * so there is no escaping rule to invent.
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

export function isFilterActive(filter: PathFilter): boolean {
  return filter.include.length > 0 || filter.exclude.length > 0;
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

/** Rebuilds the query string. Round-trips through parsePathFilter. */
export function buildFilterQuery(filter: PathFilter): string {
  const params = new URLSearchParams();
  for (const p of filter.include) params.append('path', p);
  for (const p of filter.exclude) params.append('path', '!' + p);
  const query = params.toString();
  return query ? '?' + query : '';
}

/** A path's state in the URL builder: included / excluded / ignored. */
export type PathState = 'include' | 'exclude' | 'off';

export function pathState(path: string, filter: PathFilter): PathState {
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

export function withPathState(filter: PathFilter, path: string, state: PathState): PathFilter {
  const include = filter.include.filter((p) => p !== path);
  const exclude = filter.exclude.filter((p) => p !== path);
  if (state === 'include') include.push(path);
  if (state === 'exclude') exclude.push(path);
  return { include, exclude };
}

/** Human-readable summary for the filter chip. */
export function describeFilter(filter: PathFilter): string {
  const parts: string[] = [];
  if (filter.include.length) parts.push(filter.include.join(', '));
  if (filter.exclude.length) parts.push('except ' + filter.exclude.join(', '));
  return parts.join(' — ');
}
