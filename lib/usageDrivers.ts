// What drives a session's usage (CLAUDE.md §14.119): the CLI's `/usage`
// explanations, rebuilt from what the hub already holds — the context's
// make-up (`get_context_usage`), the per-turn cache ledgers, background work,
// effort and ultracode. Pure: the Tools panel and the composer's cold-resume
// notice both read it.
import { ledgerIsCold, ledgerMissFactor, type TurnLedger } from '@/lib/promptCache';

export type ContextBreakdown = {
  tool_calls?: number | null; tool_results?: number | null; attachments?: number | null;
  assistant?: number | null; user?: number | null;
  tools?: Array<{ name: string; call: number; result: number }>;
};
export type ContextFixed = {
  memory_files?: number | null; mcp_tools?: number | null; agents?: number | null; skills?: number | null;
};
export type ColdResumeQuota = { percent_per_million: number; min_percent: number };

export type DriverTone = 'hot' | 'warm' | 'calm';
export type UsageDriver = {
  key: 'cache' | 'tool_results' | 'always_on' | 'background' | 'effort' | 'conversation';
  label: string;
  /** Tokens it accounts for (context share, or tokens re-written / spent). */
  tokens: number | null;
  detail: string;
  advice: string;
  tone: DriverTone;
};

export type DriverInput = {
  contextTokens: number | null;
  breakdown?: ContextBreakdown | null;
  fixed?: ContextFixed | null;
  /** The final rows' ledgers in the loaded window, oldest first. */
  ledgers: TurnLedger[];
  /** Background work's own token usage (sub-agents, workflows). */
  background: { tokens: number; items: number; workflows: number };
  effort: string | null;
  ultracode: boolean;
  ttlS: number | null;
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

function ttlWords(ttlS: number | null): string {
  if (!ttlS) return 'the cache lifetime';
  return ttlS >= 3600 ? `${Math.round(ttlS / 3600)} h` : `${Math.round(ttlS / 60)} min`;
}

/** The drivers worth showing, heaviest first. */
export function usageDrivers(input: DriverInput): UsageDriver[] {
  const out: UsageDriver[] = [];
  const ctx = num(input.contextTokens);

  // Cache misses: a turn that starts cold re-sends the whole prefix at the
  // write price; the ledgers say how many did and what they rewrote.
  const ledgers = input.ledgers.filter((l) => (l.requests ?? 0) > 0 || l.read + l.write + l.uncached > 0);
  if (ledgers.length) {
    const cold = ledgers.filter(ledgerIsCold);
    const rewritten = cold.reduce((a, l) => a + num(l.missWrite ?? l.write), 0);
    const worst = cold.reduce((a, l) => Math.max(a, ledgerMissFactor(l) ?? 0), 0);
    out.push({
      key: 'cache', label: 'Cache misses', tokens: rewritten || null,
      detail: cold.length
        ? `${cold.length} of ${ledgers.length} turns started cold: ${fmtTokens(rewritten)} tokens re-sent without the cache${worst >= 2 ? ` (up to ${worst.toFixed(1)}× a warm turn)` : ''}.`
        : `All ${ledgers.length} recent turns read the cache.`,
      advice: cold.length
        ? `A message sent after more than ${ttlWords(input.ttlS)} idle, or after a model or account switch, re-sends everything. Reply sooner, or compact before a long pause.`
        : 'Keep the gaps between messages under the cache lifetime.',
      tone: cold.length === 0 ? 'calm' : cold.length * 3 >= ledgers.length ? 'hot' : 'warm',
    });
  }

  // Tool results: they stay in the context until a compaction.
  const results = num(input.breakdown?.tool_results);
  if (results > 0) {
    const share = ctx ? results / ctx : null;
    const top = (input.breakdown?.tools ?? []).filter((t) => t.result > 0)
      .sort((a, b) => b.result - a.result).slice(0, 3)
      .map((t) => `${t.name} ${fmtTokens(t.result)}`).join(' · ');
    out.push({
      key: 'tool_results', label: 'Tool results in context', tokens: results,
      detail: `${fmtTokens(results)} tokens${share != null ? ` (${Math.round(share * 100)}% of the context)` : ''}${top ? ` — ${top}` : ''}.`,
      advice: 'File reads, logs and command output are re-read on every turn until compaction. Ask for narrower reads, or compact.',
      tone: share != null && share >= 0.4 ? 'hot' : share != null && share >= 0.2 ? 'warm' : 'calm',
    });
  }

  // Always-on context: sent with every request, before any conversation.
  const f = input.fixed ?? {};
  const fixedParts: Array<[string, number]> = [
    ['MCP tools', num(f.mcp_tools)], ['memory files', num(f.memory_files)],
    ['skills', num(f.skills)], ['agents', num(f.agents)],
  ];
  const fixed = fixedParts.reduce((a, [, n]) => a + n, 0);
  if (fixed > 0) {
    out.push({
      key: 'always_on', label: 'Always-on context', tokens: fixed,
      detail: `${fmtTokens(fixed)} tokens with every request: ${fixedParts.filter(([, n]) => n > 0)
        .map(([name, n]) => `${name} ${fmtTokens(n)}`).join(' · ')}.`,
      advice: 'Turn off MCP servers and skills this session does not use (Tools › session), trim CLAUDE.md / memory files.',
      tone: fixed >= 30_000 ? 'warm' : 'calm',
    });
  }

  // Background agents and workflows: each has a context of its own.
  if (input.background.tokens > 0) {
    out.push({
      key: 'background', label: 'Background agents & workflows', tokens: input.background.tokens,
      detail: `${fmtTokens(input.background.tokens)} tokens across ${input.background.items} item${input.background.items === 1 ? '' : 's'}`
        + `${input.background.workflows ? `, ${input.background.workflows} workflow${input.background.workflows === 1 ? '' : 's'}` : ''}.`,
      advice: input.ultracode
        ? 'Ultracode plans big tasks as many parallel agents: switch it off (effort menu) for small work.'
        : 'Each sub-agent re-reads its own context: fewer, larger tasks cost less than many small ones.',
      tone: input.background.tokens >= 1_000_000 ? 'hot' : input.background.tokens >= 200_000 ? 'warm' : 'calm',
    });
  }

  // Effort: thinking is output, the dearest tokens.
  const high = input.effort === 'max' || input.effort === 'xhigh';
  if (high || input.ultracode) {
    out.push({
      key: 'effort', label: 'Effort', tokens: null,
      detail: `${input.effort ?? 'default'} effort${input.ultracode ? ' + ultracode' : ''}: more thinking (output tokens) on every turn${input.ultracode ? ', and workflows of agents for big tasks' : ''}.`,
      advice: 'Lower it for routine edits; keep it for hard problems.',
      tone: input.effort === 'max' ? 'warm' : 'calm',
    });
  }

  // The conversation itself.
  const talk = num(input.breakdown?.assistant) + num(input.breakdown?.user);
  if (talk > 0) {
    out.push({
      key: 'conversation', label: 'Conversation', tokens: talk,
      detail: `${fmtTokens(talk)} tokens of messages${ctx ? ` (${Math.round((talk / ctx) * 100)}% of the context)` : ''}.`,
      advice: 'Compact, or start a fresh session for an unrelated task.',
      tone: 'calm',
    });
  }

  const rank: Record<DriverTone, number> = { hot: 0, warm: 1, calm: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone] || (b.tokens ?? 0) - (a.tokens ?? 0));
}

/** What sending the next message costs when the cache is cold: the share of
 *  the 5-hour limit (the CLI's own rate, subscription accounts only), and
 *  whether it is worth saying (the CLI's own threshold). */
export function coldResumeShare(
  promptTokens: number, quota: ColdResumeQuota | null | undefined,
): { percent: number; worthSaying: boolean } | null {
  if (!quota || !(quota.percent_per_million > 0) || !(promptTokens > 0)) return null;
  const percent = (promptTokens / 1_000_000) * quota.percent_per_million;
  return { percent, worthSaying: percent >= (quota.min_percent || 1) };
}
