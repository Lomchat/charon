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
  identity?: { name?: string | null; cli_title?: string | null; cli_error?: string };
  recorded_usage?: {
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    duration_ms: number;
    cost_usd: number;
    models?: string[];
  } | null;
  _snapshot?: {
    state?: 'loading' | 'fresh' | 'refreshing' | 'stale' | 'error';
    updated_at?: number;
    retry_after_ms?: number;
    last_error?: string;
  };
};

/** Interpret the non-blocking server snapshot envelope used by Tools/header. */
export function insightSnapshotRequestState(value: unknown): {
  waiting: boolean;
  refreshing: boolean;
  shouldRetry: boolean;
  retryAfterMs: number;
} {
  const row = value && typeof value === 'object' ? value as Record<string, any> : {};
  const snapshot = row._snapshot && typeof row._snapshot === 'object'
    ? row._snapshot as Record<string, any> : {};
  const state = typeof snapshot.state === 'string' ? snapshot.state : '';
  const waiting = row.reason === 'loading' || state === 'loading';
  const refreshing = state === 'refreshing' || state === 'stale';
  const requestedDelay = Number(snapshot.retry_after_ms);
  const retryAfterMs = Number.isFinite(requestedDelay)
    ? Math.min(15_000, Math.max(500, requestedDelay))
    : 1_000;
  return {
    waiting,
    refreshing,
    shouldRetry: waiting || refreshing,
    retryAfterMs,
  };
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

/** Native compaction requires an idle, loaded provider session. */
export function canCompactSession(status: string | null | undefined): boolean {
  return status === 'active' || status === 'failed' || status === 'background';
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
    return { meta: `${Math.round(percentage)}% used`, empty: null };
  }

  let explicitFailure: string | null = null;
  if (context?.reason === 'unsupported') explicitFailure = 'needs a newer agent on this VPS';
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
