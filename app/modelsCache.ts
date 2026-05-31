'use client';
import { api } from '@/lib/api';
import type { KnownClaudeModel } from '@/lib/types/api';

// Module-level cache of the model list. The list is small (<1KB) and
// changes only when we edit lib/server/claude/knownModels.ts + redeploy,
// so a single fetch per browser tab is plenty. No TTL — the value lives
// for the page lifetime.
//
// Why a Promise (not a plain array): callers (3 different selector
// components) mount concurrently on page load. Sharing the same in-flight
// Promise dedups the HTTP round-trip down to one even when N components
// call getModels() at the same instant.
let inflight: Promise<KnownClaudeModel[]> | null = null;
let cached: KnownClaudeModel[] | null = null;

export function getModels(): Promise<KnownClaudeModel[]> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = api.getClaudeModels()
      .then((r) => {
        cached = r.models;
        return r.models;
      })
      .catch((e) => {
        // Reset inflight so a subsequent retry can fire. Don't cache the
        // error — a transient 503 during boot would otherwise wedge every
        // picker on the page until reload.
        inflight = null;
        throw e;
      });
  }
  return inflight;
}

// Optimistic synchronous accessor for components that want to render
// immediately (with a fallback list) instead of going through useEffect.
// Returns null on first ever read of a tab; the caller falls back to a
// hardcoded baseline.
export function peekModels(): KnownClaudeModel[] | null {
  return cached;
}
