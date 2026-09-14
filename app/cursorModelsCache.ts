'use client';
import { api } from '@/lib/api';
import type { CursorModelsResponse } from '@/lib/types/api';

// Per-VPS cache of the Cursor model catalog. Per-VPS for the same reason as
// Codex's (§14.59): the catalog is ACCOUNT-driven, so it belongs to whichever
// account that box signed in as — not to the hub. Only successful responses
// persist; invalidation also prevents an older in-flight request repopulating.
const inflight = new Map<string, Promise<CursorModelsResponse>>();
const cached = new Map<string, CursorModelsResponse>();

export function getCursorModels(vpsId: string): Promise<CursorModelsResponse> {
  const hit = cached.get(vpsId);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(vpsId);
  if (!p) {
    let request!: Promise<CursorModelsResponse>;
    request = api.getCursorModels(vpsId)
      .then((r) => {
        if (inflight.get(vpsId) === request) {
          if (r.ok) cached.set(vpsId, r);
          inflight.delete(vpsId);
        }
        return r;
      })
      .catch((e) => {
        if (inflight.get(vpsId) === request) inflight.delete(vpsId);
        throw e;
      });
    p = request;
    inflight.set(vpsId, p);
  }
  return p;
}

/** Synchronous first-render read; null until the first fetch resolves. */
export function peekCursorModels(vpsId: string): CursorModelsResponse | null {
  return cached.get(vpsId) ?? null;
}

export function invalidateCursorModels(vpsId?: string): void {
  if (vpsId) { cached.delete(vpsId); inflight.delete(vpsId); }
  else { cached.clear(); inflight.clear(); }
}
