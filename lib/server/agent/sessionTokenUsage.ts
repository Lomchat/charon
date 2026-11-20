import 'server-only';
import type { SessionTokenUsage } from '@/lib/sessionTokenUsage';
import { FOLD_SLICE_EVENT_ROWS, foldSessionEventRows, warmSessionEventRows, type FoldOptions, type FoldRow } from './sessionRowCache';

const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

type TokenFold = { usage: SessionTokenUsage; requests: Set<string> };

const TOKEN_LIKES = ['%"type":"endpoint_usage"%', '%"type":"turn_usage"%'];
/** Event rows per synchronous slice of a cold fold (G1). */
export const TOKEN_FOLD_SLICE_ROWS = FOLD_SLICE_EVENT_ROWS;

/** One row of the left fold, in id order. True when it set `revision`. */
function stepTokens(s: TokenFold, row: FoldRow): boolean {
  let e;
  try { e = JSON.parse(row.content); } catch { return false; }
  if (!e || !['endpoint_usage', 'turn_usage'].includes(e.type)) return false;
  const result = s.usage;
  // Set before the dedup exits below: a replayed duplicate still moves the
  // revision, as the full scan always did.
  result.revision = row.id;
  let input: number | null, output: number | null, total: number | null;
  if (e.type === 'endpoint_usage') {
    if (typeof e.requestId !== 'string' || s.requests.has(e.requestId)) return true;
    s.requests.add(e.requestId);
    result.requests++;
    input = count(e.inputTokens); output = count(e.outputTokens); total = count(e.totalTokens);
    if (e.partial) result.partial = true;
  } else {
    if (e.endpointAccounted) return true;
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
  return true;
}

/** A fold that finished warming in the background: publish its totals (the
 *  caller that started it got null). Loaded lazily: sessionOps imports this
 *  module. */
function publishWarmed(sessionId: string, usage: SessionTokenUsage): void {
  void import('./sessionOps')
    .then((m) => m.broadcastSessionTokenUsage(sessionId, usage))
    .catch(() => { /* the next GET/poll reads the warm fold anyway */ });
}

function tokenFold(sessionId: string): FoldOptions<TokenFold> {
  return {
    likes: TOKEN_LIKES,
    init: () => ({
      usage: {
        revision: 0, inputTokens: null, outputTokens: null, totalTokens: null,
        requests: 0, legacyTurns: 0, missingInput: 0, missingOutput: 0, missingTotal: 0, partial: false,
      },
      requests: new Set(),
    }),
    // `usage` is copied (it is what callers publish). The request-id Set is
    // this module's private dedup index, never handed out, so it is shared
    // rather than copied on every read (one entry per request).
    clone: (s) => ({ usage: { ...s.usage }, requests: s.requests }),
    step: stepTokens,
    sliceRows: TOKEN_FOLD_SLICE_ROWS,
    onComplete: (s) => publishWarmed(sessionId, s.usage),
  };
}

/** Warm the fold in the background (hub boot, sessionFoldWarmup.ts). */
export function warmSessionTokenUsage(sessionId: string): void {
  warmSessionEventRows('tokens', sessionId, tokenFold(sessionId));
}

/** Full session, independent of chat pagination. Request rows include tool
 * round trips and survive aborted turns; SDK final rows must not count twice.
 * Incremental (sessionRowCache.ts): only rows newer than the cached fold are
 * read. NULL while a cold fold still warms — "unknown, keep the last value"
 * (`mergeSessionTokenUsage(prev, null) = prev`); its completion broadcasts. */
export function sessionTokenUsage(sessionId: string): SessionTokenUsage | null {
  const { state, complete } = foldSessionEventRows<TokenFold>('tokens', sessionId, tokenFold(sessionId));
  return complete ? state.usage : null;
}
