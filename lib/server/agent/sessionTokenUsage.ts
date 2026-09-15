import 'server-only';
import { and, asc, eq, or, like } from 'drizzle-orm';
import { db, claudeSessionMessages } from '@/lib/db';
import type { SessionTokenUsage } from '@/lib/sessionTokenUsage';

const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Full session, independent of chat pagination. Request rows include tool
 * round trips and survive aborted turns; SDK final rows must not count twice. */
export function sessionTokenUsage(sessionId: string): SessionTokenUsage {
  const rows = db.select({ id: claudeSessionMessages.id, content: claudeSessionMessages.content })
    .from(claudeSessionMessages).where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      eq(claudeSessionMessages.role, 'event'),
      or(like(claudeSessionMessages.content, '%"type":"endpoint_usage"%'),
        like(claudeSessionMessages.content, '%"type":"turn_usage"%')),
    )).orderBy(asc(claudeSessionMessages.id)).all();
  const result: SessionTokenUsage = {
    revision: 0, inputTokens: null, outputTokens: null, totalTokens: null,
    requests: 0, legacyTurns: 0, missingInput: 0, missingOutput: 0, missingTotal: 0, partial: false,
  };
  const requests = new Set<string>();
  for (const row of rows) {
    let e;
    try { e = JSON.parse(row.content); } catch { continue; }
    if (!e || !['endpoint_usage', 'turn_usage'].includes(e.type)) continue;
    result.revision = row.id;
    let input: number | null, output: number | null, total: number | null;
    if (e.type === 'endpoint_usage') {
      if (typeof e.requestId !== 'string' || requests.has(e.requestId)) continue;
      requests.add(e.requestId);
      result.requests++;
      input = count(e.inputTokens); output = count(e.outputTokens); total = count(e.totalTokens);
      if (e.partial) result.partial = true;
    } else {
      if (e.endpointAccounted) continue;
      result.legacyTurns++;
      // Older Codex records hold the last round trip, not every request in a
      // tool loop. Keep useful historical counts but explicitly mark coverage.
      result.partial = true;
      const u = e.tree;
      input = count(u?.input_tokens ?? e.inputTokens);
      output = count(u?.output_tokens ?? e.outputTokens);
      if (e.provider === 'claude' && input !== null) {
        input += count(u?.cache_read_tokens ?? e.cacheReadTokens) ?? 0;
        input += count(u?.cache_write_tokens ?? e.cacheWriteTokens) ?? 0;
      }
      // The old SDK bridge fabricated zero/zero when usage was absent.
      if (input === 0 && output === 0) input = output = null;
      total = input !== null && output !== null ? input + output : null;
    }
    if (input === null) result.missingInput++; else result.inputTokens = (result.inputTokens ?? 0) + input;
    if (output === null) result.missingOutput++; else result.outputTokens = (result.outputTokens ?? 0) + output;
    if (total === null) result.missingTotal++; else result.totalTokens = (result.totalTokens ?? 0) + total;
  }
  return result;
}
