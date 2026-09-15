import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getCursorModels: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { getCursorModels: mocks.getCursorModels },
}));

import { invalidateCursorModels } from '@/app/cursorModelsCache';
import { applicableParams, effectiveParams, pruneCursorEffort } from '@/app/cursorEffort';

// Two shapes from the live catalog: one model whose only knob is `reasoning`,
// one that has `effort` + `fast`. Switching between them is exactly how a
// session ends up carrying parameters its model never declared (§14.103).
const KIMI = {
  id: 'kimi-k3',
  label: 'Kimi K3',
  parameters: [{ id: 'reasoning', label: 'Reasoning', values: [
    { value: 'low', label: 'Low' }, { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
  ] }],
  variants: [{ params: { reasoning: 'max' }, label: 'Max', isDefault: true }],
} as any;
const GROK = {
  id: 'grok-4.6',
  label: 'Grok',
  parameters: [
    { id: 'effort', label: 'Effort', values: [{ value: 'high', label: 'High' }] },
    { id: 'fast', label: 'Fast', values: [{ value: 'false', label: '' }] },
  ],
  variants: [{ params: { effort: 'high', fast: 'true' }, isDefault: true }],
} as any;

describe('Cursor per-model effort', () => {
  beforeEach(() => {
    mocks.getCursorModels.mockReset();
    invalidateCursorModels();
  });

  it('keeps only the knobs the model declares', () => {
    const stored = { effort: 'high', fast: 'false', reasoning: 'max' };
    expect(applicableParams(KIMI, stored)).toEqual({ reasoning: 'max' });
    expect(applicableParams(GROK, stored)).toEqual({ effort: 'high', fast: 'false' });
  });

  it('shows the whole set when the model cannot be classified', () => {
    // Catalog not loaded / model absent from it: hiding on a guess would claim
    // a parameter is not in force when it is.
    const stored = { effort: 'high', reasoning: 'max' };
    expect(applicableParams(null, stored)).toEqual(stored);
  });

  it('reads the legacy `id?params` suffix as part of the selection', () => {
    expect(effectiveParams(KIMI, 'kimi-k3?reasoning=low', null)).toEqual({ reasoning: 'low' });
    // The effort column wins the same key.
    expect(effectiveParams(KIMI, 'kimi-k3?reasoning=low', 'reasoning=max'))
      .toEqual({ reasoning: 'max' });
  });

  it('prunes foreign knobs when the model changes', async () => {
    mocks.getCursorModels.mockResolvedValue({ ok: true, models: [KIMI, GROK] });
    expect(await pruneCursorEffort('v1', 'kimi-k3', 'effort=high&fast=false&reasoning=max'))
      .toBe('reasoning=max');
    // Nothing survives ⇒ the model's own defaults, not an empty string.
    expect(await pruneCursorEffort('v1', 'kimi-k3', 'effort=high&fast=false')).toBeNull();
  });

  it('never drops a selection the catalog cannot vouch for', async () => {
    mocks.getCursorModels.mockResolvedValue({ ok: false, models: [], reason: 'auth' });
    expect(await pruneCursorEffort('v1', 'kimi-k3', 'effort=high')).toBe('effort=high');

    invalidateCursorModels();
    mocks.getCursorModels.mockResolvedValue({ ok: true, models: [GROK] });
    expect(await pruneCursorEffort('v1', 'kimi-k3', 'effort=high')).toBe('effort=high');

    invalidateCursorModels();
    mocks.getCursorModels.mockRejectedValue(new Error('offline'));
    expect(await pruneCursorEffort('v1', 'kimi-k3', 'effort=high')).toBe('effort=high');
  });
});
