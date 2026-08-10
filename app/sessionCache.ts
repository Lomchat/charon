'use client';
import { api } from '@/lib/api';
import type { ClaudeSessionDetailResponse, ClaudeSessionMessageWindow } from '@/lib/types/api';

// Module-level cache for session detail/messages. ClaudePanel prefetches the
// sidebar sessions on mount → switching between sessions is instant via
// `<ClaudeSessionView key={id}>` (re-mount, but the hook reads the cache on
// mount).
//
// Originally `app/m/chatCache.ts` (mobile-only); promoted here and renamed when
// the UI was unified into the single responsive `/` (CLAUDE.md §11).

type CacheEntry = {
  data: ClaudeSessionDetailResponse;
  fetchedAt: number;
  approxBytes: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ClaudeSessionDetailResponse>>();

// A cached detail response contains parsed message objects and strings, whose
// actual JS heap cost is several times their wire size. Keep the hot working
// set deliberately small: session switching remains instant for recent tabs,
// while a long-lived browser can no longer retain every transcript forever.
const MAX_ENTRIES = 5;
const MAX_APPROX_BYTES = 24 * 1024 * 1024;

// An entry is "fresh" for STALE_MS. Beyond that, we refetch (but we
// return the cache first to render instantly; the caller re-applies
// when the fresh data arrives).
const STALE_MS = 15_000;

function estimateBytes(data: ClaudeSessionDetailResponse): number {
  let n = 2_048;
  for (const m of data.messages ?? []) {
    n += 256 + (typeof m.content === 'string' ? m.content.length * 2 : 0);
  }
  n += String(data.streamingText ?? '').length * 2;
  return n;
}

function touch(id: string, entry: CacheEntry): void {
  cache.delete(id);
  cache.set(id, entry);
}

function prune(): void {
  let total = 0;
  for (const e of cache.values()) total += e.approxBytes;
  while (cache.size > MAX_ENTRIES || total > MAX_APPROX_BYTES) {
    const oldest = cache.entries().next().value as [string, CacheEntry] | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    total -= oldest[1].approxBytes;
  }
}

export function getCached(id: string): ClaudeSessionDetailResponse | undefined {
  const e = cache.get(id);
  if (!e) return undefined;
  touch(id, e);
  return e.data;
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
      const entry = { data, fetchedAt: Date.now(), approxBytes: estimateBytes(data) };
      touch(id, entry);
      prune();
      return data;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
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
    approxBytes: e.approxBytes + estimateBytes({ ...e.data, messages: older.messages } as ClaudeSessionDetailResponse),
    // fetchedAt unchanged: we didn't refresh the session, just extended it.
  });
  prune();
}
