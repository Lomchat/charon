import { describe, expect, it } from 'vitest';
import {
  BIG_PROMPT_TOKENS, cacheHeat, cacheReading, cacheStateFromUsage, cacheTipLines, ledgerCachedPct,
  ledgerFromUsage, ledgerRelativeCost, ledgerWarmCost, parsePromptCache, parseTurnLedger,
  type PromptCacheState,
} from '@/lib/promptCache';
import { PROVIDERS } from '@/lib/sessionCapabilities';

const T0 = 1_700_000_000_000;
const state = (over: Partial<PromptCacheState> = {}): PromptCacheState => ({
  at: T0, expiresAt: T0 + 3_600_000, ttlS: 3600, promptTokens: 193_000, model: 'opus', account: 'default', ...over,
});

describe('cacheReading', () => {
  it('counts the TTL down in four quarters, then goes cold', () => {
    const at = (min: number) => cacheReading(state(), { now: T0 + min * 60_000, model: 'opus', account: 'default' });
    expect(at(5)).toMatchObject({ phase: 'warm', level: 4 });
    expect(at(20)).toMatchObject({ phase: 'warm', level: 3 });
    expect(at(40)).toMatchObject({ phase: 'warm', level: 2 });
    expect(at(55)).toMatchObject({ phase: 'warm', level: 1 });
    expect(at(61)).toMatchObject({ phase: 'cold', reason: 'expired' });
  });

  it('a running turn is live; a small cold cache is quiet', () => {
    expect(cacheReading(state(), { now: T0 + 7_200_000, busy: true })?.phase).toBe('live');
    const small = state({ promptTokens: BIG_PROMPT_TOKENS - 1 });
    expect(cacheReading(small, { now: T0 + 7_200_000 })?.phase).toBe('small');
  });

  it('a model or account switch since the write starts cold', () => {
    expect(cacheReading(state(), { now: T0, model: 'sonnet', account: 'default' })).toMatchObject({ phase: 'cold', reason: 'model' });
    expect(cacheReading(state(), { now: T0, model: 'opus', account: 'other' })).toMatchObject({ phase: 'cold', reason: 'account' });
  });

  it('colours with theme tokens only, and says one fact per tooltip line', () => {
    const warm = cacheReading(state(), { now: T0 + 60_000 })!;
    expect(cacheHeat(warm)).toMatch(/^color-mix\(in oklab, var\(--attention\) \d+%, var\(--info\)\)$/);
    const cold = cacheReading(state(), { now: T0 + 7_200_000 })!;
    expect(cacheHeat(cold)).toBe('var(--info)');
    expect(cacheTipLines(cold)[1]).toBe('193k tokens of context');
  });
});

describe('ledgerFromUsage', () => {
  // A cold Claude turn of 6 requests: the first rewrote 193k at 2× (1 h TTL),
  // the next five read it at 0.05× (Opus 5.5).
  const usage = {
    output_tokens: 900, duration_ms: 24_000, duration_api_ms: 18_000,
    turn_cache: {
      requests: 6, hits: 5, misses: 1, miss_write_tokens: 193_000,
      read_tokens: 975_000, write_tokens: 206_000, uncached_tokens: 360,
      ttl_s: 3600, last_request_at: T0, last_prompt_tokens: 197_000,
    },
  };

  it('counts per request and prices with the model multipliers', () => {
    const l = ledgerFromUsage('claude', usage, { model: 'claude-opus-5-5', ttlS: null })!;
    expect(l).toMatchObject({ requests: 6, hits: 5, misses: 1, readX: 0.05, writeX: 2, durMs: 24_000, apiMs: 18_000 });
    expect(ledgerCachedPct(l)).toBe(83);
    const rel = ledgerRelativeCost(l)!;
    expect(rel).toBeGreaterThan(0.38);
    expect(rel).toBeLessThan(0.4);
    // Had the first request hit, the turn would have cost ~5× less.
    expect(rel / ledgerWarmCost(l)!).toBeGreaterThan(4.5);
  });

  it('round-trips through JSON and refuses garbage', () => {
    const l = ledgerFromUsage('claude', usage, { model: 'claude-opus-5-5', ttlS: null })!;
    expect(parseTurnLedger(JSON.stringify(l))).toEqual(l);
    expect(parseTurnLedger('{"read":1}')).toBeNull();
    expect(parseTurnLedger('nope')).toBeNull();
  });

  it('an old Claude agent still gets a ledger from the flat fields; Codex and Cursor do not', () => {
    const flat = { output_tokens: 10, input_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 20 };
    expect(ledgerFromUsage('claude', flat, { model: null, ttlS: 300 })).toMatchObject({ read: 100, write: 20, uncached: 5, writeX: 1.25 });
    expect(ledgerFromUsage('codex', flat, { model: 'gpt-5.6-sol', ttlS: null })).toBeNull();
    expect(PROVIDERS.cursor.promptCache).toBeNull();
    expect(ledgerFromUsage('cursor', flat, { model: null, ttlS: null })).toBeNull();
  });
});

describe('cacheStateFromUsage', () => {
  it('expires one TTL after the last request; Codex is an estimate', () => {
    const tc = { requests: 2, last_request_at: T0, last_prompt_tokens: 50_000, ttl_s: 3600 };
    expect(cacheStateFromUsage('claude', tc, { previousTtlS: null, model: 'opus', account: 'a' }))
      .toEqual({ at: T0, expiresAt: T0 + 3_600_000, ttlS: 3600, promptTokens: 50_000, model: 'opus', account: 'a' });
    const codex = cacheStateFromUsage('codex', { ...tc, ttl_s: null }, { previousTtlS: null, model: 'gpt-5.6-sol', account: 'a' })!;
    expect(codex).toMatchObject({ ttlS: 1800, approx: true });
    expect(parsePromptCache(JSON.stringify(codex))).toEqual(codex);
    expect(cacheStateFromUsage('claude', { requests: 1 }, { previousTtlS: null, model: null, account: null })).toBeNull();
  });
});
