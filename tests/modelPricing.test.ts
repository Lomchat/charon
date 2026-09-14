import { describe, it, expect } from 'vitest';
import {
  parsePricingDoc, priceFor, priceKey, sortedPriceKey, fastPriceKey,
  formatPrice, fastMultiplier, priceTier,
} from '@/lib/modelPricing';

/**
 * Prices come from a DOCUMENT, not from the model catalog (§14.103).
 *
 * The fixture is a verbatim excerpt of `models-and-pricing.md` — the same
 * shapes the real file has, because every one of them is a way the parse can go
 * wrong: a linked model name, a `-` for an absent cache rate, a `(Fast)` row
 * that is a PRICE and not a model, several tables in one document, and a table
 * that is not about pricing at all.
 */
const DOC = `
# Models & Pricing

Some prose that mentions | a pipe | but is not a table.

## Cursor Models

| Model                                                | Provider | Input | Cache write | Cache read | Output | Notes  |
| ---------------------------------------------------- | -------- | ----- | ----------- | ---------- | ------ | ------ |
| Grok 4.6                                             | Cursor   | $2    | -           | $0.5       | $6     | Jointly trained |
| Grok 4.6 (Fast)                                      | Cursor   | $4    | -           | $1         | $12    | Jointly trained |
| [Composer 2.5](https://cursor.com/blog/composer-2-5) | Cursor   | $0.5  | -           | $0.2       | $2.5   | -      |

## Other Models

### Model pricing

| Model                                                      | Provider  | Input | Cache write | Cache read | Output |
| ---------------------------------------------------------- | --------- | ----- | ----------- | ---------- | ------ |
| [Claude Opus 5](https://www.anthropic.com/claude/opus)     | Anthropic | $5    | $6.25       | $0.5       | $25    |
| [Claude 4.6 Sonnet](https://www.anthropic.com/claude/sonnet) | Anthropic | $3  | $3.75       | $0.3       | $15    |
| Claude Opus 4.7 (fast mode)                                | Anthropic | $30   | $37.5       | $3         | $150   |
| GPT-5.6 Luna                                               | OpenAI    | $0.2  | $0.25       | $0.02      | $1.2   |

## Plans

| Plan | Price |
| ---- | ----- |
| Pro  | $20   |
`;

describe('parsing the published price doc', () => {
  const table = parsePricingDoc(DOC);

  it('reads a rate, a linked name and an absent cache cell', () => {
    expect(table[priceKey('Claude Opus 5')])
      .toMatchObject({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, provider: 'Anthropic' });
    // The name is a markdown link; the price belongs to its TEXT.
    expect(table[priceKey('Composer 2.5')]).toMatchObject({ input: 0.5, output: 2.5 });
    // `-` is "not offered", which is null — never 0, which would read as free.
    expect(table[priceKey('Grok 4.6')].cacheWrite).toBeNull();
  });

  it('keeps a `(Fast)` row as a PRICE of its model, not as another model', () => {
    // Two rows, one model: `Grok 4.6` must not be shadowed by its fast lane.
    expect(table[priceKey('Grok 4.6')]).toMatchObject({ input: 2, output: 6 });
    expect(table[fastPriceKey('Grok 4.6')]).toMatchObject({ input: 4, output: 12 });
    expect(table[priceKey('Grok 4.6 (Fast)')]).toBeUndefined();
    // "(fast mode)" is the same idea spelled differently.
    expect(table[fastPriceKey('Claude Opus 4.7')]).toMatchObject({ output: 150 });
  });

  it('ignores tables that are not per-model pricing', () => {
    // The Plans table has no Input/Output columns, so its rows must not enter.
    expect(table[priceKey('Pro')]).toBeUndefined();
    // Nor may prose containing a pipe start a table.
    expect(Object.keys(table).some((k) => k.includes('prose'))).toBe(false);
  });

  it('matches a catalog name whose WORDS are ordered differently', () => {
    // The catalog says "Claude Sonnet 4.6", the doc says "Claude 4.6 Sonnet".
    // Seven models were silently unpriced on that difference alone, which
    // reads exactly like "Cursor doesn't publish this one".
    expect(sortedPriceKey('Claude Sonnet 4.6')).toBe(sortedPriceKey('Claude 4.6 Sonnet'));
    expect(priceFor(table, 'Claude Sonnet 4.6', 'claude-sonnet-4-6').price)
      .toMatchObject({ input: 3, output: 15 });
    // An exact hit still wins over the loose one.
    expect(priceFor(table, 'Claude Opus 5', 'claude-opus-5').price).toMatchObject({ output: 25 });
  });

  it('strips the vendor prefix the catalog adds to first-party models', () => {
    // Catalog: "Cursor Grok 4.6". Doc: "Grok 4.6".
    const { price, fastPrice } = priceFor(table, 'Cursor Grok 4.6', 'grok-4.6');
    expect(price).toMatchObject({ input: 2, output: 6 });
    expect(fastPrice).toMatchObject({ output: 12 });
  });

  it('reports nothing for a model the doc does not list', () => {
    // `Auto` is a router with no single rate. Silence, never a guessed number:
    // a wrong price is worse than none, because it gets acted on.
    expect(priceFor(table, 'Auto', 'default').price).toBeUndefined();
    expect(formatPrice(undefined)).toBeNull();
    expect(priceTier(null)).toBeNull();
  });
});

describe('saying a price', () => {
  const cheap = { input: 0.2, output: 1.2, cacheRead: null, cacheWrite: null, provider: null };
  const dear = { input: 10, output: 50, cacheRead: null, cacheWrite: null, provider: null };

  it('echoes the doc’s own precision', () => {
    expect(formatPrice(cheap)).toBe('$0.2 in · $1.2 out /Mtok');
    expect(formatPrice(dear)).toBe('$10 in · $50 out /Mtok');
  });

  it('tiers by output rate, which dominates a coding turn', () => {
    expect(priceTier(cheap)).toBe('$');
    expect(priceTier(dear)).toBe('$$$$');
    expect(priceTier({ ...cheap, output: 25 })).toBe('$$$');
  });

  it('turns the fast lane into a multiplier, and stays quiet when it is not one', () => {
    expect(fastMultiplier({ ...cheap, output: 6 }, { ...cheap, output: 12 })).toBe('2x');
    expect(fastMultiplier({ ...cheap, output: 2.5 }, { ...cheap, output: 15 })).toBe('6x');
    // Same price ⇒ nothing to say; a missing half ⇒ nothing to say.
    expect(fastMultiplier({ ...cheap, output: 6 }, { ...cheap, output: 6 })).toBeNull();
    expect(fastMultiplier({ ...cheap, output: 6 }, undefined)).toBeNull();
    expect(fastMultiplier(undefined, { ...cheap, output: 6 })).toBeNull();
  });
});
