import 'server-only';
import { and, eq, like } from 'drizzle-orm';
import { db, claudeSessionMessages } from '@/lib/db';

export type RecordedSessionUsage = {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  duration_ms: number;
  cost_usd: number;
  models: string[];
};

/** Aggregate the provider-neutral final-usage rows recorded since agent 0.67.
 *  This intentionally says "recorded", never "lifetime": older turns predate
 *  the durable event and must not be presented as zero-cost history. */
export function recordedSessionUsage(sessionId: string): RecordedSessionUsage | null {
  const rows = db.select({ content: claudeSessionMessages.content })
    .from(claudeSessionMessages)
    .where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      eq(claudeSessionMessages.role, 'event'),
      like(claudeSessionMessages.content, '%"type":"turn_usage"%'),
    )).all();
  const total: RecordedSessionUsage = {
    turns: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0,
    duration_ms: 0, cost_usd: 0, models: [],
  };
  const models = new Set<string>();
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  for (const row of rows) {
    try {
      const event = JSON.parse(row.content);
      if (event?.type !== 'turn_usage') continue;
      const inclusive = event.tree && typeof event.tree === 'object' ? event.tree : null;
      total.turns += 1;
      total.input_tokens += num(inclusive?.input_tokens ?? event.inputTokens);
      total.output_tokens += num(inclusive?.output_tokens ?? event.outputTokens);
      total.cache_read_tokens += num(inclusive?.cache_read_tokens ?? event.cacheReadTokens);
      total.cache_write_tokens += num(inclusive?.cache_write_tokens ?? event.cacheWriteTokens);
      total.duration_ms += num(event.durationMs);
      total.cost_usd += num(inclusive?.cost_usd ?? event.costUsd);
      if (Array.isArray(inclusive?.models)) {
        for (const model of inclusive.models) if (typeof model === 'string') models.add(model);
      }
    } catch { /* one corrupt historical row cannot hide every good total */ }
  }
  if (!total.turns) return null;
  total.cost_usd = Math.round(total.cost_usd * 1_000_000) / 1_000_000;
  total.models = [...models].sort();
  return total;
}
