import 'server-only';
import { FOLD_SLICE_EVENT_ROWS, foldSessionEventRows, warmSessionEventRows, type FoldOptions, type FoldRow } from './sessionRowCache';

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

type RecordedFold = { total: Omit<RecordedSessionUsage, 'models'>; models: Set<string> };

/** Event rows per synchronous slice of a cold fold (G1). */
export const RECORDED_FOLD_SLICE_ROWS = FOLD_SLICE_EVENT_ROWS;

const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

function stepRecorded(s: RecordedFold, row: FoldRow): boolean {
  try {
    const event = JSON.parse(row.content);
    if (event?.type !== 'turn_usage') return false;
    const inclusive = event.tree && typeof event.tree === 'object' ? event.tree : null;
    const total = s.total;
    total.turns += 1;
    total.input_tokens += num(inclusive?.input_tokens ?? event.inputTokens);
    total.output_tokens += num(inclusive?.output_tokens ?? event.outputTokens);
    total.cache_read_tokens += num(inclusive?.cache_read_tokens ?? event.cacheReadTokens);
    total.cache_write_tokens += num(inclusive?.cache_write_tokens ?? event.cacheWriteTokens);
    total.duration_ms += num(event.durationMs);
    total.cost_usd += num(inclusive?.cost_usd ?? event.costUsd);
    if (Array.isArray(inclusive?.models)) {
      for (const model of inclusive.models) if (typeof model === 'string') s.models.add(model);
    }
    return true;
  } catch { return false; /* one corrupt historical row cannot hide every good total */ }
}

const RECORDED_FOLD: FoldOptions<RecordedFold> = {
  likes: ['%"type":"turn_usage"%'],
  init: () => ({
    total: {
      turns: 0, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0,
      duration_ms: 0, cost_usd: 0,
    },
    models: new Set(),
  }),
  clone: (s) => ({ total: { ...s.total }, models: new Set(s.models) }),
  step: stepRecorded,
  sliceRows: RECORDED_FOLD_SLICE_ROWS,
};

/** Warm the fold in the background (hub boot, sessionFoldWarmup.ts). */
export function warmRecordedSessionUsage(sessionId: string): void {
  warmSessionEventRows('recorded', sessionId, RECORDED_FOLD);
}

/** Aggregate the provider-neutral final-usage rows recorded since agent 0.67.
 *  This intentionally says "recorded", never "lifetime": older turns predate
 *  the durable event and must not be presented as zero-cost history.
 *  Incremental (sessionRowCache.ts). `pending` = a cold fold still warming:
 *  `usage` is then null, never a partial sum (the context route answers
 *  `recordedPending` and the client asks again shortly). */
export function recordedSessionUsage(sessionId: string): { usage: RecordedSessionUsage | null; pending: boolean } {
  const { state, complete } = foldSessionEventRows<RecordedFold>('recorded', sessionId, RECORDED_FOLD);
  if (!complete) return { usage: null, pending: true };
  if (!state.total.turns) return { usage: null, pending: false };
  return {
    usage: {
      ...state.total,
      cost_usd: Math.round(state.total.cost_usd * 1_000_000) / 1_000_000,
      models: [...state.models].sort(),
    },
    pending: false,
  };
}
