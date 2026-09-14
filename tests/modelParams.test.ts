import { describe, it, expect } from 'vitest';
import type { CursorModel } from '@/lib/types/api';
import {
  REASONING_PARAM_IDS, decodeModelParams, encodeModelParams, isModelParamSet,
  joinModelSpec, modelAxes, paramLabel, paramValueLabel, splitModelSpec,
} from '@/lib/modelParams';

/**
 * A provider whose reasoning axis is declared PER MODEL (§14.103).
 *
 * The fixtures below are verbatim shapes from the live 38-model catalog, kept
 * because every bug in this area came from a shape that was ASSUMED:
 *   * a variant has no `id` — reading one yielded `undefined` for all of them,
 *     so the picker silently offered no variants at all;
 *   * `thinking` and `fast` ship values with EMPTY display names, which renders
 *     as blank rows next to each other;
 *   * `fast` pads duplicate labels with U+200B, invisible in a menu;
 *   * one model has 32 variants, which is why they are not models.
 */

// claude-opus-5, exactly as `/v1/models` returns it (values trimmed to shape).
const OPUS: CursorModel = {
  id: 'claude-opus-5',
  label: 'Claude Opus 5',
  parameters: [
    { id: 'thinking', label: 'Thinking', values: [{ value: 'false' }, { value: 'true' }] },
    { id: 'context', label: 'Context', values: [{ value: '300k', label: '300K' }, { value: '1m', label: '1M' }] },
    {
      id: 'effort',
      label: 'Effort',
      values: [
        { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra High' },
        { value: 'max', label: 'Max' },
      ],
    },
    { id: 'fast', label: 'Fast', values: [{ value: 'false' }, { value: 'true', label: 'Fast​​' }] },
  ],
  variants: [
    { params: { thinking: 'true', context: '300k', effort: 'high', fast: 'false' }, isDefault: true },
    { params: { thinking: 'false', context: '300k', effort: 'low', fast: 'false' } },
  ],
};

// GPT-5.6 Sol: the ladder is called `reasoning`, and it has a `none` rung.
const SOL: CursorModel = {
  id: 'gpt-5.6-sol',
  label: 'GPT-5.6 Sol',
  parameters: [
    { id: 'context', label: 'Context', values: [{ value: '272k', label: '272K' }, { value: '1m', label: '1M' }] },
    {
      id: 'reasoning',
      label: 'Reasoning',
      values: [{ value: 'none', label: 'None' }, { value: 'high', label: 'High' }, { value: 'max', label: 'Max' }],
    },
    { id: 'fast', label: 'Fast', values: [{ value: 'false' }, { value: 'true', label: 'Fast' }] },
  ],
  variants: [],
};

// Seven models have no parameters at all, `default` (Auto) among them.
const AUTO: CursorModel = { id: 'default', label: 'Auto', variants: [{ params: {}, isDefault: true }] };

describe('per-model parameter codec', () => {
  it('encodes canonically so two equal selections compare equal', () => {
    // Key order is what the picker's ✓ depends on: it marks the active row by
    // comparing whole strings.
    expect(encodeModelParams({ thinking: 'true', effort: 'high' }))
      .toBe(encodeModelParams({ effort: 'high', thinking: 'true' }));
    expect(encodeModelParams({ effort: 'high', thinking: 'true' })).toBe('effort=high&thinking=true');
    // An empty value is absent, not `key=`: absent means "the model's default".
    expect(encodeModelParams({ effort: '', thinking: 'true' })).toBe('thinking=true');
    expect(encodeModelParams({})).toBe('');
    expect(encodeModelParams(null)).toBe('');
  });

  it('round-trips, and decodes tolerantly', () => {
    const set = { context: '1m', effort: 'xhigh', fast: 'false' };
    expect(decodeModelParams(encodeModelParams(set))).toEqual(set);
    // Stored by an older build, or truncated: skip the junk, keep the rest.
    expect(decodeModelParams('effort=high&&broken&=x&thinking=true'))
      .toEqual({ effort: 'high', thinking: 'true' });
    expect(decodeModelParams(null)).toEqual({});
  });

  it('refuses a malformed set rather than passing it to a provider', () => {
    expect(isModelParamSet('effort=high')).toBe(true);
    expect(isModelParamSet('effort=high&thinking=true&context=1m&fast=false')).toBe(true);
    expect(isModelParamSet('reasoning=extra-high')).toBe(true);
    for (const bad of [
      '', 'effort', 'effort=', '=high', 'effort==high',
      'effort=high&effort=low',      // one axis, one value
      'ef fort=high', 'effort=hi gh', 'effort=high;drop',
      'a'.repeat(300),
      'a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9',   // over the count bound
    ]) {
      expect(isModelParamSet(bad), bad.slice(0, 24)).toBe(false);
    }
  });

  it('still understands the legacy suffix a model id may carry', () => {
    // Parameters used to ride on the model id. Sessions created then still
    // hold that shape, and every reader must keep resolving it.
    expect(splitModelSpec('claude-opus-5?thinking=true'))
      .toEqual({ id: 'claude-opus-5', params: { thinking: 'true' } });
    expect(splitModelSpec('claude-opus-5')).toEqual({ id: 'claude-opus-5', params: {} });
    expect(splitModelSpec(null)).toEqual({ id: '', params: {} });
    // A bare id must not GAIN a suffix on the way back out.
    expect(joinModelSpec('claude-opus-5', {})).toBe('claude-opus-5');
    expect(joinModelSpec('claude-opus-5', { thinking: 'true' })).toBe('claude-opus-5?thinking=true');
  });
});

describe('reading a model’s axes', () => {
  it('finds the reasoning ladder whatever the catalog calls it', () => {
    expect(modelAxes(OPUS).reasoning?.id).toBe('effort');
    expect(modelAxes(SOL).reasoning?.id).toBe('reasoning');
    // Verified across the live catalog: never two ladders on one model, which
    // is what lets a single control represent it.
    for (const m of [OPUS, SOL, AUTO]) {
      const ladders = (m.parameters ?? []).filter((p) => REASONING_PARAM_IDS.includes(p.id));
      expect(ladders.length).toBeLessThanOrEqual(1);
    }
  });

  it('keeps every other knob, so none is silently dropped', () => {
    const axes = modelAxes(OPUS);
    expect(axes.extra.map((p) => p.id)).toEqual(['thinking', 'context', 'fast']);
    // `all` is what the effort control groups over: the ladder leads.
    expect(axes.all.map((p) => p.id)).toEqual(['effort', 'thinking', 'context', 'fast']);
    // Together they account for every parameter — an axis missing from both
    // would be a setting no control can reach.
    expect(axes.all.length).toBe(OPUS.parameters!.length);
  });

  it('reads the default variant, which is what an empty effort means', () => {
    expect(modelAxes(OPUS).defaults)
      .toEqual({ thinking: 'true', context: '300k', effort: 'high', fast: 'false' });
    // No default variant declared is not an error; it just means the provider
    // decides.
    expect(modelAxes(SOL).defaults).toEqual({});
  });

  it('never renders a blank, redundant or invisibly-padded label', () => {
    const fast = OPUS.parameters!.find((p) => p.id === 'fast')!;
    const thinking = OPUS.parameters!.find((p) => p.id === 'thinking')!;
    // A boolean is on/off. Its catalog labels are '' for false and the
    // PARAMETER'S OWN NAME for true, so under a group headed "Fast" the rows
    // would read "" and "Fast" — one blank, one saying nothing.
    for (const p of [fast, thinking]) {
      expect(paramValueLabel(p, 'true')).toBe('on');
      expect(paramValueLabel(p, 'false')).toBe('off');
    }
    // Everything else keeps the catalog's own word.
    const context = OPUS.parameters!.find((p) => p.id === 'context')!;
    expect(paramValueLabel(context, '1m')).toBe('1M');
    // U+200B is Cursor's own uniqueness padding, invisible in a menu.
    expect(paramLabel({ id: 'fast', label: 'Fast​​', values: [] })).toBe('Fast');
    // An unknown value still says something.
    expect(paramValueLabel(thinking, 'maybe')).toBe('maybe');
  });

  it('states one fact per line, from what the catalog really carries', () => {
    // Context window, how far reasoning goes, which switches exist. NOT a price
    // or a speed tier: `/v1/models` has neither, and inventing one would be a
    // number nobody could verify.
    expect(modelAxes(OPUS).facts).toEqual(['300K/1M context', 'Effort Low–Max', 'Thinking', 'Fast']);
    expect(modelAxes(SOL).facts).toEqual(['272K/1M context', 'Reasoning None–Max', 'Fast']);
  });

  it('handles a model with no parameters, and no model at all', () => {
    const axes = modelAxes(AUTO);
    expect(axes.reasoning).toBeNull();
    expect(axes.all).toEqual([]);
    expect(axes.facts).toEqual([]);
    // The pickers render before the catalog arrives; this must not throw.
    expect(modelAxes(null).all).toEqual([]);
    expect(modelAxes(undefined).facts).toEqual([]);
  });
});
