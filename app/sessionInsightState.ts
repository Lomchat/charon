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
