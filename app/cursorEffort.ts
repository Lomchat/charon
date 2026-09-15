'use client';
import type { CursorModel } from '@/lib/types/api';
import { getCursorModels } from './cursorModelsCache';
import {
  decodeModelParams, encodeModelParams, modelAxes, splitModelSpec,
  type ModelParamSet,
} from '@/lib/modelParams';

/**
 * Which stored parameters the SELECTED model actually reads (§14.103).
 *
 * A parameter set is merged forward as the model changes, so a session can
 * carry knobs its current model never declared — `effort=high&fast=false`
 * survives a switch from a model that has those to `kimi-k3`, which declares
 * `reasoning` alone. Those keys reach the provider and are ignored, but every
 * surface that showed them claimed a setting the effort control cannot even
 * offer: the header listed three knobs while the picker had one.
 *
 * `null` means "cannot tell" — the catalog has not loaded, or the model is not
 * in it. Nothing is hidden on a guess; an unclassifiable set is shown whole.
 */
export function modelKnobIds(model: CursorModel | null | undefined): Set<string> | null {
  if (!model) return null;
  return new Set(modelAxes(model).all.map((p) => p.id));
}

/** The stored set reduced to what this model reads, catalog order irrelevant. */
export function applicableParams(
  model: CursorModel | null | undefined, params: ModelParamSet,
): ModelParamSet {
  const known = modelKnobIds(model);
  if (!known) return params;
  return Object.fromEntries(Object.entries(params).filter(([k]) => known.has(k)));
}

/** The model's own knobs, read off the model id AND the effort column — the
 *  legacy `id?params` suffix is part of the effective selection (§14.103). */
export function effectiveParams(
  model: CursorModel | null | undefined, modelId: string | null, effort: string | null,
): ModelParamSet {
  const spec = splitModelSpec(modelId);
  return applicableParams(model, { ...spec.params, ...decodeModelParams(effort) });
}

/**
 * The effort column to persist alongside a NEW model, foreign knobs dropped.
 *
 * Runs on a model change so that what the header shows, what the picker
 * offers and what the provider is sent stay the same three things. Falls back
 * to the value it was given whenever the catalog cannot answer: silently
 * clearing a selection because a fetch failed would be worse than keeping a
 * key the model ignores.
 */
export async function pruneCursorEffort(
  vpsId: string, modelId: string, effort: string | null,
): Promise<string | null> {
  const params = decodeModelParams(effort);
  if (!Object.keys(params).length) return effort || null;
  let models: CursorModel[] = [];
  try {
    const r = await getCursorModels(vpsId);
    if (!r.ok) return effort || null;
    models = r.models ?? [];
  } catch { return effort || null; }
  const model = models.find((m) => m.id === splitModelSpec(modelId).id);
  if (!model) return effort || null;
  return encodeModelParams(applicableParams(model, params)) || null;
}
