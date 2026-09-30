'use client';
import type { CursorModel } from '@/lib/types/api';
import { getCursorModels } from './cursorModelsCache';
import {
  adaptEffortForModel, decodeModelParams, modelAxes, splitModelSpec,
  type ModelParamSet,
} from '@/lib/modelParams';

/**
 * Which stored parameters the SELECTED model actually reads (§14.103).
 *
 * A row stored before model changes were adapted (`pruneCursorEffort`) can
 * carry knobs its current model never declared — `effort=high&fast=false`
 * beside `kimi-k3`, which declares `reasoning` alone. Such a key FAILS the
 * run (§14.103); showing it here would still claim a setting the effort
 * control cannot even offer, so these surfaces show the declared part, the
 * agent's turn error names the rest, and a new pick drops it.
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
 * The effort column to persist alongside a NEW model (`adaptEffortForModel`):
 * foreign knobs dropped, the reasoning rung carried across ladder ids.
 *
 * Runs on every model change — the session header AND the Settings default —
 * so that what the header shows, what the picker offers and what the provider
 * is sent stay the same three things. Falls back to the value it was given
 * whenever the catalog cannot answer: silently clearing a selection because a
 * fetch failed would be worse than a guess.
 */
export async function pruneCursorEffort(
  vpsId: string, modelId: string, effort: string | null,
): Promise<string | null> {
  if (!Object.keys(decodeModelParams(effort)).length) return effort || null;
  try {
    const r = await getCursorModels(vpsId);
    if (!r.ok) return effort || null;
    return adaptEffortForModel(r.models ?? [], modelId, effort);
  } catch { return effort || null; }
}
