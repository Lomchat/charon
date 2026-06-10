'use client';
import { api } from '@/lib/api';
import type { KnownClaudeModel, ClaudeModelsResponse } from '@/lib/types/api';
import { CANONICAL_EFFORTS } from '@/lib/types/api';

// Module-level cache of the model picker payload ({ models, efforts }). Small
// (a few KB), fetched once per browser tab. `invalidateModels()` drops it after
// a manual sync so the pickers pick up newly discovered models/efforts without
// a full page reload.
//
// Why a Promise (not a plain value): the model/effort pickers (several
// components) mount concurrently on page load. Sharing the in-flight Promise
// dedups the HTTP round-trip down to one.
let inflight: Promise<ClaudeModelsResponse> | null = null;
let cached: ClaudeModelsResponse | null = null;

function fetchPayload(): Promise<ClaudeModelsResponse> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = api.getClaudeModels()
      .then((r) => { cached = r; return r; })
      .catch((e) => {
        // Reset inflight so a later retry can fire. Don't cache the error — a
        // transient 503 during boot would otherwise wedge every picker.
        inflight = null;
        throw e;
      });
  }
  return inflight;
}

export function getModels(): Promise<KnownClaudeModel[]> {
  return fetchPayload().then((r) => r.models);
}

export function getEfforts(): Promise<string[]> {
  return fetchPayload().then((r) => r.efforts ?? [...CANONICAL_EFFORTS]);
}

// Optimistic synchronous accessors for first render (return null on first ever
// read of a tab; the caller falls back to a hardcoded baseline).
export function peekModels(): KnownClaudeModel[] | null {
  return cached?.models ?? null;
}

export function peekEfforts(): string[] | null {
  return cached?.efforts ?? null;
}

// Drop the cache so the next read refetches. Called after a manual model-list
// sync from SettingsModal.
export function invalidateModels(): void {
  cached = null;
  inflight = null;
}
