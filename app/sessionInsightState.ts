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

type ContextUsageEnvelope = {
  ok?: boolean;
  error?: string;
  reason?: string;
} | null;

/**
 * Thread lifecycle and context telemetry are independent. In particular,
 * Codex may report an idle (loaded, ready) thread before this app-server
 * process has observed a tokenUsage notification. Missing numbers must never
 * be presented as if the thread were stopped.
 */
export function contextUsagePresentation(
  context: ContextUsageEnvelope,
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
