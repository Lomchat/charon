import { describe, expect, it } from 'vitest';
import { ledgerIsCold, ledgerMissFactor, ledgerRelativeCost, type TurnLedger } from '../lib/promptCache';

// §14.116: a turn is marked cold only when its miss at least doubled the input
// cost, never on "any miss" nor on the cache share. Opus 5.5, 1 h TTL.
const opus = { readX: 0.05, writeX: 2, uncached: 36, out: 0 };

describe('turn ledger cold mark', () => {
  it('one miss diluted in a long turn is not cold', () => {
    const l: TurnLedger = { ...opus, read: 1_806_348, write: 119_862, requests: 18, hits: 17, misses: 1, missWrite: 32_470 };
    expect(ledgerRelativeCost(l)).toBeCloseTo(0.171, 3);
    expect(ledgerMissFactor(l)).toBeCloseTo(1.24, 2);
    expect(ledgerIsCold(l)).toBe(false);
  });

  it('a short turn that rewrote its whole context is cold despite a high cache share', () => {
    const l: TurnLedger = { ...opus, read: 4_800_000, write: 780_000, requests: 7, hits: 6, misses: 1, missWrite: 752_000 };
    expect(l.read / (l.read + l.write + l.uncached)).toBeGreaterThan(0.85);
    expect(ledgerMissFactor(l)!).toBeGreaterThan(2);
    expect(ledgerIsCold(l)).toBe(true);
  });

  it('no miss, or unknown prices, is never cold', () => {
    expect(ledgerIsCold({ ...opus, read: 100, write: 5_000_000, misses: 0, missWrite: 0 })).toBe(false);
    expect(ledgerIsCold({ read: 10, write: 1_000, uncached: 0, out: 0, misses: 1, missWrite: 1_000 })).toBe(false);
  });
});
