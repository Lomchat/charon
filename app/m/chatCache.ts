'use client';
// Module re-exported from `app/sessionCache.ts` (shared desktop/mobile).
// Before the maintainability refactor (audit #1), this file contained the
// implementation. It is kept so as not to break the historical
// `../chatCache` imports in `app/m/`. Prefer the new path for new code.
export {
  getCached, isCacheFresh, fetchAndCache, prefetchAll, invalidate,
  extendWithOlder,
} from '../sessionCache';
