import type { AgentKind } from '@/lib/types/api';
import { supportsSessionCapability } from '@/lib/sessionCapabilities';
/**
 * MCP providers do not use one status enum: Codex reports `ready`, while
 * Claude SDK releases have used `connected` (and compatible servers may expose
 * `running`). Keep the presentation rule provider-neutral: reconnect is useful
 * only when the server is not already healthy.
 */
export function isMcpServerReady(status: string | null | undefined): boolean {
  const normalized = String(status ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return normalized === 'ready'
    || normalized === 'connected'
    || normalized === 'running'
    || normalized === 'started'
    || normalized === 'ok';
}

export type SessionContextUsage = {
  ok?: boolean;
  error?: string;
  reason?: string;
  total_tokens?: number | string;
  max_tokens?: number | string;
  percentage?: number | string;
  auto_compact_threshold?: number | string;
  model?: string;
  status?: { type?: string; activeFlags?: string[]; active_flags?: string[] };
  categories?: Array<{ name?: string | null; tokens?: number | null }>;
  /** Claude (agent >= 0.134.0, §14.119): the messages' make-up, the load
   *  re-sent every turn, and the 5-hour price of a cold resume. */
  breakdown?: import('@/lib/usageDrivers').ContextBreakdown;
  fixed?: import('@/lib/usageDrivers').ContextFixed;
  cold_resume_quota?: import('@/lib/usageDrivers').ColdResumeQuota;
  identity?: { name?: string | null; cli_title?: string | null; cli_error?: string };
  recorded_usage?: {
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    duration_ms: number;
    /** null when the provider's cost is not a charge, or behind a custom
     *  endpoint whose rates Charon does not know (§14.102 `turnCost`). */
    cost_usd: number | null;
    models?: string[];
  } | null;
  /** The hub's recorded-usage fold is still warming (`recorded_usage` is then
   *  null, not zero); ask again shortly. */
  recordedPending?: boolean;
  /** No live reading: the stored one (lib/contextReading.ts), taken at
   *  `lastKnownAt` (ms). */
  lastKnown?: boolean;
  lastKnownAt?: number;
  /** The session runs no CLI to ask (asleep): nothing to retry. */
  asleep?: boolean;
  _snapshot?: {
    state?: 'loading' | 'fresh' | 'refreshing' | 'stale' | 'error';
    updated_at?: number;
    retry_after_ms?: number;
    last_error?: string;
  };
};

/** Interpret the non-blocking server snapshot envelope used by Tools/header. */
/** Answers that a retry cannot change: no backend surface, no CLI to ask. */
const SETTLED_REASONS = new Set(['unsupported', 'unavailable', 'asleep', 'missing']);

export function insightSnapshotRequestState(value: unknown): {
  waiting: boolean;
  refreshing: boolean;
  /** The reading failed (hub snapshot `error`, an HTTP error, a timeout):
   *  worth a few spaced retries — an agent reconnecting after a hub restart
   *  answers seconds later. */
  failed: boolean;
  shouldRetry: boolean;
  retryAfterMs: number;
} {
  const row = value && typeof value === 'object' ? value as Record<string, any> : {};
  const snapshot = row._snapshot && typeof row._snapshot === 'object'
    ? row._snapshot as Record<string, any> : {};
  const state = typeof snapshot.state === 'string' ? snapshot.state : '';
  const waiting = row.reason === 'loading' || state === 'loading';
  const refreshing = state === 'refreshing' || state === 'stale';
  const failed = !waiting && !refreshing && !row.asleep && (state === 'error'
    || (!state && row.ok === false && !SETTLED_REASONS.has(String(row.reason ?? ''))));
  const requestedDelay = Number(snapshot.retry_after_ms);
  const retryAfterMs = Number.isFinite(requestedDelay)
    ? Math.min(15_000, Math.max(500, requestedDelay))
    : 1_000;
  return {
    waiting,
    refreshing,
    failed,
    shouldRetry: waiting || refreshing,
    retryAfterMs,
  };
}

/** The answer to show for one session: a `recordedPending` answer (the
 *  hub's recorded-usage fold re-warming after an eviction, a restart or a
 *  rewind) knows NOTHING about the recorded figure — null there means
 *  unknown, not zero — so the last known figure of the same session stays
 *  on screen until a warm answer replaces it. */
export function keepRecordedUsage<T extends SessionContextUsage>(previous: SessionContextUsage | null | undefined, next: T | null): T | null {
  if (!next?.recordedPending || next.recorded_usage != null || previous?.recorded_usage == null) return next;
  return { ...next, recorded_usage: previous.recorded_usage };
}

/** Delay of the one re-request after a `recordedPending` answer (the hub's
 *  cold recorded-usage fold warms in slices). */
export const RECORDED_PENDING_RETRY_MS = 2_000;

/** Whether a context answer earns that ONE re-request: the first pending
 *  answer of a streak only (any answer that is not pending ends the streak),
 *  and not when a snapshot retry is already due (it re-reads the usage too).
 *  Later refreshes (turn end, focus) cover a slower warm-up. */
export function recordedPendingRetry(
  context: { recordedPending?: boolean } | null | undefined,
  alreadyRetried: boolean,
  snapshotRetryDue: boolean,
): { retry: boolean; retried: boolean } {
  if (!context?.recordedPending) return { retry: false, retried: false };
  if (alreadyRetried || snapshotRetryDue) return { retry: false, retried: alreadyRetried };
  return { retry: true, retried: true };
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One provider-neutral occupancy value for both header and Tools gauges. */
export function contextUsagePercentage(context: SessionContextUsage | null): number | null {
  const explicit = finiteNumber(context?.percentage);
  if (explicit != null) return explicit;
  const total = finiteNumber(context?.total_tokens);
  const maximum = finiteNumber(context?.max_tokens);
  return total != null && maximum != null && maximum > 0
    ? total * 100 / maximum
    : null;
}

function compactTokenCount(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/** The same concise token pair is shown beside both occupancy gauges. */
export function contextWindowTokenLabel(context: SessionContextUsage | null): string | null {
  const total = finiteNumber(context?.total_tokens);
  const maximum = finiteNumber(context?.max_tokens);
  if (total == null || maximum == null) return null;
  return `${compactTokenCount(total)} / ${compactTokenCount(maximum)}`;
}

/** Native compaction requires an idle provider session; a sleeping one is
 *  resumed by the compact route first (as a send wakes it, §14.49). */
export function canCompactSession(
  status: string | null | undefined,
  kind?: AgentKind,
): boolean {
  // A backend with no compaction primitive must not offer the button: the
  // agent used to fall through to Claude's mechanism, which sends the literal
  // string "/compact" to the model as a prompt (§14.103).
  if (kind && !supportsSessionCapability(kind, 'compact')) return false;
  return status === 'active' || status === 'failed' || status === 'background' || status === 'sleeping';
}

/**
 * Thread lifecycle and context telemetry are independent. In particular,
 * Codex may report an idle (loaded, ready) thread before this app-server
 * process has observed a tokenUsage notification. Missing numbers must never
 * be presented as if the thread were stopped.
 */
export function contextUsagePresentation(
  context: SessionContextUsage | null,
  percentage: number | null,
): { meta: string; empty: string | null } {
  if (typeof percentage === 'number' && Number.isFinite(percentage)) {
    return { meta: `${Math.round(percentage)}% used${context?.lastKnown ? ' · last known' : ''}`, empty: null };
  }

  let explicitFailure: string | null = null;
  if (context?.reason === 'unsupported') explicitFailure = 'needs a newer agent on this VPS';
  // `unavailable` ≠ `unsupported`: the backend has no such surface at all, so
  // telling the user to update an already-current agent would be a lie.
  else if (context?.reason === 'unavailable') explicitFailure = 'not reported by this backend';
  else if (context?.reason === 'offline') explicitFailure = 'the VPS agent is offline';
  else if (context?.error) explicitFailure = context.error;

  if (explicitFailure) return { meta: 'unavailable', empty: explicitFailure };
  if (context?.ok) {
    return {
      meta: 'usage not reported yet',
      empty: 'context usage has not been reported yet',
    };
  }
  return { meta: 'unavailable', empty: 'context data unavailable' };
}
