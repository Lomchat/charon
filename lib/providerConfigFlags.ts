// Flags read straight off a session's private construction JSON
// (`agent_sessions.provider_config`), for surfaces that may only see the
// flag, never the rest (env, credentials).

/** Claude's ultracode switch (§14.56): standing dynamic-workflow
 *  orchestration, beside effort. */
export function ultracodeOf(providerConfig: string | null | undefined): boolean {
  return flagOf(providerConfig, 'ultracode');
}

/** Claude's fast mode, beside effort (read at construction). */
export function fastModeOf(providerConfig: string | null | undefined): boolean {
  return parse(providerConfig)?.fastMode === true;
}

/** Codex's speed tier (§14.59); null = inherit. */
export function serviceTierOf(providerConfig: string | null | undefined): string | null {
  const v = parse(providerConfig)?.serviceTier;
  return isServiceTierId(v) ? v : null;
}

/** A speed tier id: catalog (`priority`, `ultrafast`…), legacy `fast`/`flex`,
 *  or `default` (standard). The agent applies the same shape. */
export function isServiceTierId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(v);
}

function flagOf(providerConfig: string | null | undefined, key: 'ultracode'): boolean {
  return parse(providerConfig)?.[key] === true;
}

function parse(providerConfig: string | null | undefined): Record<string, unknown> | null {
  if (!providerConfig) return null;
  try {
    const v = JSON.parse(providerConfig) as unknown;
    return v && typeof v === 'object' ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
