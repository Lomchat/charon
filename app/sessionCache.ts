'use client';
import { api } from '@/lib/api';
import type { ClaudeSessionDetailResponse } from '@/lib/types/api';

// Cache module-level partagé desktop + mobile.
// - Mobile : `/m/select` prefetch toutes les sessions au mount → `/m/chat`
//   lit le cache et render instant.
// - Desktop : ClaudePanel prefetch les sessions de la sidebar → switch
//   entre sessions est instantané via `<ClaudeSessionView key={id}>`
//   (re-mount mais le hook lit le cache au mount).
//
// Avant ce module, `app/m/chatCache.ts` ne servait qu'au mobile. Promu en
// `app/sessionCache.ts` pour être réutilisable côté desktop sans cross-import
// entre app/m/ et app/. L'ancien fichier mobile ré-exporte depuis ici pour
// préserver les imports existants (rétrocompat).

type CacheEntry = {
  data: ClaudeSessionDetailResponse;
  fetchedAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ClaudeSessionDetailResponse>>();

// Une entrée est "fraîche" pendant STALE_MS. Au-delà, on refetch (mais on
// retourne le cache d'abord pour render instant ; l'appelant ré-applique
// quand le fresh arrive).
const STALE_MS = 15_000;

export function getCached(id: string): ClaudeSessionDetailResponse | undefined {
  return cache.get(id)?.data;
}

export function isCacheFresh(id: string): boolean {
  const e = cache.get(id);
  return !!e && (Date.now() - e.fetchedAt < STALE_MS);
}

/**
 * Fetch + cache d'une session. Dedup les calls concurrents.
 * Si une entrée fresh existe et `force=false` → return cached sans fetch.
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

/** Lance des prefetches en background pour la liste des sessions. */
export function prefetchAll(ids: string[]): void {
  for (const id of ids) {
    fetchAndCache(id).catch(() => {});
  }
}

export function invalidate(id: string): void {
  cache.delete(id);
}
