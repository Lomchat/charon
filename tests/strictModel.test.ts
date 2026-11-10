import { describe, it, expect } from 'vitest';
import { sameModel } from '../lib/strictModel';

/**
 * A strict session (§14.118) stops its turn when another model answers. A
 * false "different" kills a good benchmark run; a false "same" lets a fallback
 * through. Pairs below are what the fleet actually reports.
 */
describe('sameModel', () => {
  it('accepts what providers report for the model asked', () => {
    const same: Array<[string | null, string]> = [
      ['opus', 'claude-opus-5-5'], ['fable', 'claude-fable-5-2'], ['haiku', 'claude-haiku-5-5'],
      ['opus[1m]', 'claude-opus-5-5'], ['claude-opus-5-5', 'claude-opus-5-5'],
      ['claude-opus-5-5', 'claude-opus-5-5-20261001'],
      ['gpt-6.1-sol', 'gpt-6.1-sol'], ['deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash'],
      [null, 'claude-sonnet-5-5'], ['default', 'composer-2.5'],
    ];
    for (const [want, got] of same) expect(sameModel(want, got), `${want} ← ${got}`).toBe(true);
  });

  it('rejects another model, fallback or family', () => {
    const different: Array<[string, string]> = [
      ['opus', 'claude-sonnet-5-5'], ['fable', 'claude-opus-5-5'],
      ['claude-opus-5-5', 'claude-sonnet-5-5'], ['claude-haiku-5-5', 'claude-haiku-5-5-mini'],
      ['gpt-6.1-sol', 'gpt-6-luna'], ['deepseek-v4.1-flash', 'deepseek-v4.1-pro'],
    ];
    for (const [want, got] of different) expect(sameModel(want, got), `${want} ← ${got}`).toBe(false);
  });
});
