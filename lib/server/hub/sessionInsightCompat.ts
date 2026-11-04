/** Rolling-fleet compatibility for Codex agents before 0.68.0.
 *
 * Those agents exposed lifetime token compute as context occupancy and listed
 * Guardian reviewer threads as sub-agents. Keep the hub truthful while a busy
 * VPS waits for its safe agent-update window; newer agents already return the
 * same normalized shapes, so both helpers are idempotent.
 */

type TokenBreakdown = {
  input_tokens?: number; inputTokens?: number;
  cached_input_tokens?: number; cachedInputTokens?: number;
  output_tokens?: number; outputTokens?: number;
  reasoning_output_tokens?: number; reasoningOutputTokens?: number;
  total_tokens?: number; totalTokens?: number;
};

function numberAt(row: TokenBreakdown, snake: keyof TokenBreakdown, camel: keyof TokenBreakdown) {
  const value = row[snake] ?? row[camel];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeCodexContextUsage(result: Record<string, any>): Record<string, any> {
  if (result?.provider !== 'codex') return result;
  const last = result?.usage?.last as TokenBreakdown | undefined;
  if (!last || typeof last !== 'object') return result;
  const total = numberAt(last, 'total_tokens', 'totalTokens');
  const max = typeof result.max_tokens === 'number' && Number.isFinite(result.max_tokens)
    ? result.max_tokens : null;
  const fields: Array<[keyof TokenBreakdown, keyof TokenBreakdown, string]> = [
    ['input_tokens', 'inputTokens', 'input'],
    ['cached_input_tokens', 'cachedInputTokens', 'cached input'],
    ['output_tokens', 'outputTokens', 'output'],
    ['reasoning_output_tokens', 'reasoningOutputTokens', 'reasoning'],
  ];
  const categories = fields.flatMap(([snake, camel, name]) => {
    const tokens = numberAt(last, snake, camel);
    return tokens == null ? [] : [{ name, tokens }];
  });
  return {
    ...result,
    total_tokens: total,
    percentage: total != null && max ? total * 100 / max : null,
    categories,
  };
}

const GUARDIAN_PREVIEW =
  'The following is the Codex agent history whose request action you are assessing.';

export function hideInternalCodexSubagents(result: Record<string, any>): Record<string, any> {
  if (!Array.isArray(result?.agents)) return result;
  return {
    ...result,
    agents: result.agents.filter((agent: any) =>
      typeof agent?.preview !== 'string' || !agent.preview.startsWith(GUARDIAN_PREVIEW)),
  };
}
