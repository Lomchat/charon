'use client';
import { api } from '@/lib/api';
import type { CodexModelsResponse } from '@/lib/types/api';
import { CODEX_CANONICAL_EFFORTS } from '@/lib/types/api';

// Per-VPS cache of the Codex model catalog ({ ok, models, efforts }). Unlike
// the Claude catalog (global, one hub-wide list — cf. modelsCache.ts), the
// Codex catalog is ACCOUNT-driven and therefore per-VPS: it comes from the
// agent's list_codex_models RPC (openai-codex .models()) on that specific box.
// Fetched once per (tab, vpsId); the shared in-flight Promise dedups the
// concurrent mounts of CodexModelPicker + CodexEffortPicker for the same VPS.
const inflight = new Map<string, Promise<CodexModelsResponse>>();
const cached = new Map<string, CodexModelsResponse>();

function fetchPayload(vpsId: string): Promise<CodexModelsResponse> {
  const hit = cached.get(vpsId);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(vpsId);
  if (!p) {
    p = api.getCodexModels(vpsId)
      .then((r) => { cached.set(vpsId, r); inflight.delete(vpsId); return r; })
      .catch((e) => {
        // Don't cache the error — a transient failure during boot would
        // otherwise wedge the pickers for the whole tab lifetime.
        inflight.delete(vpsId);
        throw e;
      });
    inflight.set(vpsId, p);
  }
  return p;
}

export function getCodexModels(vpsId: string): Promise<CodexModelsResponse> {
  return fetchPayload(vpsId);
}

// Optimistic synchronous accessor for first render (null on the first read of
// a (tab, vpsId); the caller falls back to a baseline so the picker isn't empty).
export function peekCodexModels(vpsId: string): CodexModelsResponse | null {
  return cached.get(vpsId) ?? null;
}

export const CODEX_FALLBACK_EFFORTS: string[] = [...CODEX_CANONICAL_EFFORTS];

// Drop a VPS's cached catalog (e.g. after a re-login / model refresh).
export function invalidateCodexModels(vpsId?: string): void {
  if (vpsId) { cached.delete(vpsId); inflight.delete(vpsId); }
  else { cached.clear(); inflight.clear(); }
}
