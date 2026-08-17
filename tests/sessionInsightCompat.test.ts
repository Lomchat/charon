import { describe, expect, it } from 'vitest';
import {
  hideInternalCodexSubagents,
  normalizeCodexContextUsage,
} from '../lib/server/claude/sessionInsightCompat';

describe('Codex session insight rolling compatibility', () => {
  it('uses the latest request footprint instead of lifetime compute', () => {
    const result = normalizeCodexContextUsage({
      provider: 'codex',
      total_tokens: 216_504_850,
      max_tokens: 258_400,
      percentage: 83_786,
      usage: {
        last: {
          input_tokens: 65_887,
          cached_input_tokens: 64_256,
          output_tokens: 438,
          reasoning_output_tokens: 203,
          total_tokens: 66_325,
        },
        total: { total_tokens: 216_504_850 },
      },
    });
    expect(result.total_tokens).toBe(66_325);
    expect(result.percentage).toBeCloseTo(25.6676, 3);
    expect(result.categories).toEqual([
      { name: 'input', tokens: 65_887 },
      { name: 'cached input', tokens: 64_256 },
      { name: 'output', tokens: 438 },
      { name: 'reasoning', tokens: 203 },
    ]);
  });

  it('leaves Claude and already-normalized payloads intact', () => {
    const claude = { provider: 'claude', total_tokens: 12 };
    const codex = { provider: 'codex', total_tokens: 12 };
    expect(normalizeCodexContextUsage(claude)).toBe(claude);
    expect(normalizeCodexContextUsage(codex)).toBe(codex);
  });

  it('hides Guardian reviewers but preserves real collaborators', () => {
    const result = hideInternalCodexSubagents({ agents: [
      { id: 'guardian', preview: 'The following is the Codex agent history whose request action you are assessing. More' },
      { id: 'worker', preview: 'Investigating the parser', role: 'explorer' },
    ] });
    expect(result.agents).toEqual([
      { id: 'worker', preview: 'Investigating the parser', role: 'explorer' },
    ]);
  });
});
