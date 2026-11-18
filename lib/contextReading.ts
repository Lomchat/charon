/**
 * The last context-window reading of a session (`agent_sessions.context_reading`).
 *
 * The live reading is an RPC to the running CLI, cached in hub memory only: a
 * hub restart, a cold session or a sleeping one had no figure at all, and the
 * header row (gauge AND its compact button) stayed absent until it answered.
 * The stored reading answers at once; its token count follows the prompt
 * cache's prompt size (`promptCache.promptTokens`, written every turn) when
 * that is newer, since the window size is what only a live reading knows.
 */
import type { PromptCacheState } from './promptCache';

export type ContextReading = {
  total: number;
  max: number;
  /** The model the reading was taken under (provider id), when reported. */
  model?: string | null;
  /** ms: when it was taken. */
  at: number;
};

function nonNegative(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseContextReading(raw: unknown): ContextReading | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const total = nonNegative(r.total);
  const max = nonNegative(r.max);
  const at = nonNegative(r.at);
  if (total == null || max == null || max <= 0 || at == null) return null;
  return { total, max, at, model: typeof r.model === 'string' ? r.model : null };
}

/** A live context answer as a reading; null when it lacks the window figures. */
export function contextReadingOf(usage: Record<string, unknown> | null | undefined, at: number): ContextReading | null {
  if (!usage || usage.ok === false) return null;
  const total = nonNegative(usage.total_tokens);
  const max = nonNegative(usage.max_tokens);
  if (total == null || max == null || max <= 0) return null;
  return { total, max, at, model: typeof usage.model === 'string' ? usage.model : null };
}

/** Worth a write: the figures moved (not the clock). */
export function contextReadingChanged(prev: ContextReading | null, next: ContextReading): boolean {
  return !prev || prev.total !== next.total || prev.max !== next.max || (prev.model ?? null) !== (next.model ?? null);
}

/** The context answer to show without a live reading (`lastKnown: true`). */
export function lastKnownContext(reading: ContextReading | null, cache: PromptCacheState | null) {
  if (!reading) return null;
  const newer = cache && cache.at > reading.at && Number.isFinite(cache.promptTokens) && cache.promptTokens > 0;
  const total = newer ? cache!.promptTokens : reading.total;
  const at = newer ? cache!.at : reading.at;
  return {
    ok: true as const,
    total_tokens: total,
    max_tokens: reading.max,
    percentage: (total * 100) / reading.max,
    ...(reading.model ? { model: reading.model } : {}),
    lastKnown: true as const,
    lastKnownAt: at,
  };
}
