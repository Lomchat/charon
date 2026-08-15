// Addressable handles for sessions.
//
// A session's `name` is free-form: it may be null, contain spaces or accents,
// and two sessions on one VPS may share it. None of that survives being typed
// after an `@` or handed to another agent as "who to talk to". The handle is
// the addressing form of the same identity: lowercase, [a-z0-9-], unique
// WITHIN A VPS — which is the scope that matters, because cross-session
// messaging is filesystem-scoped to one machine.
//
// Stability is the property that makes it usable: the handle a user typed
// yesterday must still point at the same session today. So assignment is
// deterministic and seniority-ordered — an older session keeps the bare handle
// and a newcomer that would collide takes the suffix, never the reverse.

/** Longest handle we emit. Long enough to stay recognisable, short enough to
 *  type in full without autocomplete. */
const MAX_LEN = 32;

/**
 * Normalise a free-form name into handle shape. Returns '' when nothing
 * usable survives (e.g. a name made only of emoji), so callers can fall back.
 */
export function slugifyHandle(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .normalize('NFKD')
    // Strip combining marks so "Réglages" → "reglages" rather than losing the
    // letter entirely. Escaped form on purpose: a literal combining range is
    // invisible in a diff and trivially corrupted by an editor.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LEN)
    .replace(/-+$/g, '');
}

/** Last path segment of a cwd, in handle shape. The fallback that still says
 *  something about the session ("api", "charon") rather than an opaque id. */
function handleFromCwd(cwd: string | null | undefined): string {
  if (!cwd) return '';
  const tail = cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop();
  return slugifyHandle(tail ?? '');
}

export type HandleInput = {
  id: string;
  name?: string | null;
  cwd?: string | null;
  /** Lower sorts first = keeps the bare handle on collision. Use a stable
   *  seniority key (creation time); ties break on id so the result never
   *  depends on input order. */
  createdAt?: number | null;
};

/**
 * Assign a unique handle to every session in ONE VPS.
 *
 * Collisions get `-2`, `-3`… appended to the newcomer, never to the incumbent:
 * two sessions both called "api" stay `api` and `api-2` across restarts, and
 * `@api` keeps meaning what it meant before the second one existed.
 *
 * Pass the whole VPS's sessions — including sleeping ones. A handle that is
 * free only because a session is asleep would be re-pointed the moment it
 * wakes, which is exactly the surprise addressing must not have.
 */
export function assignHandles(sessions: HandleInput[]): Map<string, string> {
  const ordered = [...sessions].sort((a, b) => {
    const ta = a.createdAt ?? 0;
    const tb = b.createdAt ?? 0;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const s of ordered) {
    const base =
      slugifyHandle(s.name) ||
      handleFromCwd(s.cwd) ||
      // Last resort: never empty, never colliding, still copy-pasteable.
      `session-${s.id.slice(0, 6)}`;
    let handle = base;
    let n = 2;
    while (taken.has(handle)) handle = `${base}-${n++}`;
    taken.add(handle);
    out.set(s.id, handle);
  }
  return out;
}

/**
 * Same as `assignHandles`, but for a mixed list spanning several VPSes.
 *
 * Uniqueness is scoped PER VPS, not globally: cross-session messaging is
 * filesystem-scoped to one machine, so two machines may both have an `@api`
 * without ambiguity — and forcing global uniqueness would make one of them
 * `api-2` for no reason the user could see.
 */
export function assignHandlesByVps(
  sessions: (HandleInput & { vpsId: string })[],
): Map<string, string> {
  const byVps = new Map<string, (HandleInput & { vpsId: string })[]>();
  for (const s of sessions) {
    const list = byVps.get(s.vpsId);
    if (list) list.push(s);
    else byVps.set(s.vpsId, [s]);
  }
  const out = new Map<string, string>();
  for (const list of byVps.values()) {
    for (const [id, handle] of assignHandles(list)) out.set(id, handle);
  }
  return out;
}

/** Find a session by handle, case-insensitively. Returns null rather than
 *  guessing: addressing the wrong agent is worse than not addressing one. */
export function resolveHandle(
  handles: Map<string, string>,
  typed: string,
): string | null {
  const want = typed.trim().replace(/^@/, '').toLowerCase();
  if (!want) return null;
  for (const [id, h] of handles) if (h.toLowerCase() === want) return id;
  return null;
}
