// Flags read straight off a session's private construction JSON
// (`agent_sessions.provider_config`), for surfaces that may only see the
// flag, never the rest (env, credentials).

/** Claude's ultracode switch (§14.56): standing dynamic-workflow
 *  orchestration, beside effort. */
export function ultracodeOf(providerConfig: string | null | undefined): boolean {
  if (!providerConfig) return false;
  try {
    const v = JSON.parse(providerConfig) as { ultracode?: unknown } | null;
    return !!v && typeof v === 'object' && v.ultracode === true;
  } catch {
    return false;
  }
}
