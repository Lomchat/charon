import 'server-only';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';

/**
 * What the CLI itself calls each live session on a VPS — the ADDRESSABLE name,
 * the one another agent types after an `@`.
 *
 * This is NOT the transcript title (`rename_session`) and NOT Charon's own
 * `name`. It is set by `--name` at session START, and when nothing sets it the
 * CLI invents one from the directory (`eleven-duel-dev-87`). The dashboard used
 * to derive its @handle from Charon's name and present it as an address, which
 * was simply wrong wherever the two had never been aligned.
 *
 * VPS-scoped and cached: one `claude agents --json` answers for every session
 * on the box, so this must never become a per-session call. The list is polled
 * every 15s by the session list; spawning a CLI process that often, per VPS,
 * would be the expensive mistake.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; names: Map<string, string> }>();

export async function cliNamesForVps(vpsId: string): Promise<Map<string, string>> {
  const hit = cache.get(vpsId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  const names = new Map<string, string>();
  try {
    const client = getAgentClientForVpsId(vpsId);
    if (client.status === 'connected') {
      const r = await client.call('cli_agents', {}) as
        { ok?: boolean; agents?: Array<{ session_id?: string; name?: string }> };
      // Keyed on CHARON's session id, which the agent supplies: joining on
      // claude_session_id was fragile — the hub's copy can be missing right
      // after a resume, and the feature then silently showed nothing.
      for (const a of r?.agents ?? []) {
        if (a?.session_id && typeof a.name === 'string' && a.name) {
          names.set(a.session_id, a.name);
        }
      }
    }
  } catch {
    // Agent too old, VPS unreachable — an empty map means "unknown", and the
    // caller marks the handle unconfirmed rather than asserting a wrong one.
  }
  // Cached even when empty: a VPS whose agent predates the RPC must not be
  // re-asked on every poll.
  cache.set(vpsId, { at: Date.now(), names });
  return names;
}

/** Drop the cache for a VPS — after starting or resuming a session, whose
 *  --name only takes effect at that moment. */
export function invalidateCliNames(vpsId: string): void {
  cache.delete(vpsId);
}
