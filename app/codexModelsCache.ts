'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { codexSpeedHint } from '@/lib/speedCosts';
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

function fetchPayload(vpsId: string, profile: string): Promise<CodexModelsResponse> {
  const key = `${vpsId}:${profile}`;
  const hit = cached.get(key);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = api.getCodexModels(vpsId, profile)
      .then((r) => { if (inflight.get(key) === p) { cached.set(key, r); inflight.delete(key); } return r; })
      .catch((e) => {
        // Don't cache the error — a transient failure during boot would
        // otherwise wedge the pickers for the whole tab lifetime.
        if (inflight.get(key) === p) inflight.delete(key);
        throw e;
      });
    inflight.set(key, p);
  }
  return p;
}

export function getCodexModels(vpsId: string, profile = "default"): Promise<CodexModelsResponse> {
  return fetchPayload(vpsId, profile);
}

// Optimistic synchronous accessor for first render (null on the first read of
// a (tab, vpsId); the caller falls back to a baseline so the picker isn't empty).
export function peekCodexModels(vpsId: string, profile = "default"): CodexModelsResponse | null {
  return cached.get(`${vpsId}:${profile}`) ?? null;
}

export const CODEX_FALLBACK_EFFORTS: string[] = [...CODEX_CANONICAL_EFFORTS];

// Drop a VPS's cached catalog (e.g. after a re-login / model refresh).
export function invalidateCodexModels(vpsId?: string): void {
  if (vpsId) {
    for (const key of cached.keys()) if (key.startsWith(`${vpsId}:`)) cached.delete(key);
    for (const key of inflight.keys()) if (key.startsWith(`${vpsId}:`)) inflight.delete(key);
  } else { cached.clear(); inflight.clear(); }
}

/** One speed a Codex model offers (§14.59): a catalog tier, or standard. */
export type CodexSpeedTier = { id: string; name: string; hint?: string };

/** The speeds this model offers, Standard (`default`) first, plus the tier a
 *  turn gets when none is asked. `modelId` empty = the catalog default. null
 *  while unknown (loading, failed, an agent too old to list tiers) or when
 *  the model offers nothing but standard. */
export function useCodexSpeeds(vpsId: string, profile: string, modelId: string, enabled = true):
  { tiers: CodexSpeedTier[]; defaultTier: string } | null {
  const catalog = useCodexCatalog(vpsId, profile, enabled);
  if (!enabled || !catalog?.ok) return null;
  const m = modelId ? catalog.models.find((x) => x.id === modelId) : catalog.models.find((x) => x.isDefault);
  if (!m?.serviceTiers?.length) return null;
  // Each tier's tooltip: its published speed and cost on THIS model.
  return {
    tiers: [{ id: 'default', name: 'Standard' }, ...m.serviceTiers.filter((t) => t.id !== 'default')]
      .map((t) => ({ id: t.id, name: t.name, hint: codexSpeedHint(t.id, m.id, t.hint) })),
    defaultTier: m.defaultServiceTier || 'default',
  };
}

/** Every tier any model of the catalog offers, beyond standard: the choices
 *  of the fleet default (a model without the tier runs at standard speed). */
export function useCodexSpeedChoices(vpsId: string | null, profile = 'default'): CodexSpeedTier[] | null {
  const catalog = useCodexCatalog(vpsId ?? '', profile, !!vpsId);
  if (!vpsId || !catalog?.ok) return null;
  const seen = new Map<string, CodexSpeedTier>();
  for (const m of catalog.models) {
    for (const t of m.serviceTiers ?? []) if (t.id !== 'default' && !seen.has(t.id)) seen.set(t.id, { id: t.id, name: t.name });
  }
  return seen.size ? [...seen.values()] : null;
}

function useCodexCatalog(vpsId: string, profile: string, enabled: boolean): CodexModelsResponse | null {
  const [catalog, setCatalog] = useState<CodexModelsResponse | null>(() => (enabled ? peekCodexModels(vpsId, profile) : null));
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setCatalog(peekCodexModels(vpsId, profile));
    getCodexModels(vpsId, profile).then((r) => { if (!cancelled) setCatalog(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [vpsId, profile, enabled]);
  return enabled ? catalog : null;
}

/** The speed a session runs at, as a tier id of `useCodexSpeeds`: null =
 *  the model's default, legacy `fast` = the catalog's `priority`. */
export function codexSpeedOf(serviceTier: string | null, defaultTier = 'default'): string {
  if (!serviceTier) return defaultTier;
  return serviceTier === 'fast' ? 'priority' : serviceTier;
}
