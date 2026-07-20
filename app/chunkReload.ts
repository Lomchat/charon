// Stale-chunk recovery (§14.57).
//
// Charon tabs stay open for days (one long-lived SSE) while `.next` is rebuilt
// often. Every `next build` rewrites chunk hashes and DELETES the old files, so
// a long-open tab that later lazy-imports a chunk (xterm for shell/login, any
// route split) hits a 404 → ChunkLoadError. With no recovery that surfaces as
// the raw "Application error: a client-side exception" white screen and the
// user must F5 by hand. Here we detect chunk-load failures and reload ONCE onto
// the fresh build, guarded against reload loops so a genuine (non-chunk) bug
// can't spin the page forever.

const RELOAD_GUARD_KEY = 'charon:lastChunkReload';
const RELOAD_MIN_INTERVAL_MS = 10_000;

/** True for a failed static/dynamic chunk load (deploy swapped the files). */
export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { name?: unknown; message?: unknown };
  if (anyErr.name === 'ChunkLoadError') return true;
  const msg = typeof anyErr.message === 'string' ? anyErr.message : String(err ?? '');
  return (
    /Loading chunk [\d]+ failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg)
  );
}

/**
 * Reload the page once to pick up the fresh build. No-ops if we already
 * reloaded within RELOAD_MIN_INTERVAL_MS (loop guard: a persistent, non-chunk
 * error must not reload forever). Returns true if a reload was triggered.
 */
export function reloadOnceForChunkError(reason?: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || '0');
    const now = Date.now();
    if (now - last < RELOAD_MIN_INTERVAL_MS) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
  } catch {
    // sessionStorage unavailable (private mode edge): fall through and reload —
    // at worst one reload, the loop guard just isn't persisted.
  }
  if (reason) {
    // eslint-disable-next-line no-console
    console.warn(`[charon] reloading to recover from stale chunk: ${reason}`);
  }
  window.location.reload();
  return true;
}
