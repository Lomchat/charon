'use client';
import { api } from '@/lib/api';
import type { ClaudeSessionDetailResponse, ClaudeSessionMessageWindow } from '@/lib/types/api';

// Module-level cache shared between desktop + mobile.
// - Mobile: `/m/select` prefetches all sessions on mount → `/m/chat`
//   reads from the cache and renders instantly.
// - Desktop: ClaudePanel prefetches the sidebar sessions → switching
//   between sessions is instant via `<ClaudeSessionView key={id}>`
//   (re-mount but the hook reads the cache on mount).
//
// Before this module, `app/m/chatCache.ts` only served mobile. Promoted to
// `app/sessionCache.ts` to be reusable on the desktop side without cross-import
// between app/m/ and app/. The old mobile file re-exports from here to
// preserve existing imports (backward compatibility).

type CacheEntry = {
  data: ClaudeSessionDetailResponse;
  fetchedAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ClaudeSessionDetailResponse>>();

// An entry is "fresh" for STALE_MS. Beyond that, we refetch (but we
// return the cache first to render instantly; the caller re-applies
// when the fresh data arrives).
const STALE_MS = 15_000;

export function getCached(id: string): ClaudeSessionDetailResponse | undefined {
  return cache.get(id)?.data;
}

export function isCacheFresh(id: string): boolean {
  const e = cache.get(id);
  return !!e && (Date.now() - e.fetchedAt < STALE_MS);
}

/**
 * Fetch + cache a session. Dedups concurrent calls.
 * If a fresh entry exists and `force=false` → return cached without fetch.
 */
export async function fetchAndCache(id: string, force = false): Promise<ClaudeSessionDetailResponse> {
  if (!force) {
    const e = cache.get(id);
    if (e && Date.now() - e.fetchedAt < STALE_MS) return e.data;
  }
  const existing = inflight.get(id);
  if (existing) return existing;
  const p = (async () => {
    try {
      const data = await api.getClaudeSession(id);
      cache.set(id, { data, fetchedAt: Date.now() });
      return data;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}

/** Launch background prefetches for the list of sessions. */
export function prefetchAll(ids: string[]): void {
  for (const id of ids) {
    fetchAndCache(id).catch(() => {});
  }
}

export function invalidate(id: string): void {
  cache.delete(id);
}

/**
 * Extend a session's cache entry with a window of older messages
 * (the result of a loadOlderClaudeMessages). Preserves the position
 * in history across session switches / component remounts.
 *
 * No error if the entry doesn't exist (no-op) — the caller may still
 * have fresh data locally. Note: extended pages are NOT preserved
 * across a `fetchAndCache(force=true)` — a full reload (visibilitychange,
 * manual) resets to the latest window. The trade-off: simplicity > absolute
 * scroll fidelity after long absence.
 */
export function extendWithOlder(id: string, older: ClaudeSessionMessageWindow): void {
  const e = cache.get(id);
  if (!e) return;
  // The merge keeps asc order by id. The older messages come, by definition,
  // before the current ones (smaller ids). We keep hasMore/oldestChatId
  // from the last loaded page (the oldest).
  cache.set(id, {
    ...e,
    data: {
      ...e.data,
      messages: [...older.messages, ...e.data.messages],
      hasMore: older.hasMore,
      oldestChatId: older.oldestChatId,
    },
    // fetchedAt unchanged: we didn't refresh the session, just extended it.
  });
}
