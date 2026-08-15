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
// A FAILED read is remembered for far less time than a good one. Caching a
// failure for the full TTL is how this broke in the first place: right after a
// hub restart the AgentClients have not finished reconnecting, so the map came
// back empty, got frozen for a minute, and every @handle in the UI rendered as
// an unconfirmed prediction — indistinguishable from "we do not support this".
// Same rule as the usage poll (§14.72e): a failed read must never become the
// answer.
const FAIL_TTL_MS = 5_000;

type Entry = { at: number; names: Map<string, string>; ok: boolean };
const cache = new Map<string, Entry>();

export async function cliNamesForVps(vpsId: string): Promise<Map<string, string>> {
  const hit = cache.get(vpsId);
  if (hit && Date.now() - hit.at < (hit.ok ? TTL_MS : FAIL_TTL_MS)) return hit.names;

  const names = new Map<string, string>();
  let ok = false;
  try {
    const client = getAgentClientForVpsId(vpsId);
    if (client.status === 'connected') {
      const r = await client.call('cli_agents', {}) as
        { ok?: boolean; agents?: Array<{ session_id?: string; name?: string }> };
      // Keyed on CHARON's session id, which the agent supplies: joining on
      // claude_session_id was fragile — the hub's copy can be missing right
      // after a resume, and the feature then silently showed nothing.
      if (r?.ok) {
        ok = true;
        for (const a of r.agents ?? []) {
          if (a?.session_id && typeof a.name === 'string' && a.name) {
            names.set(a.session_id, a.name);
          }
        }
      }
    }
  } catch {
    // Agent too old, VPS unreachable — `ok` stays false, so this is retried
    // seconds later rather than held for a minute.
  }

  // Never let a failed read erase a good one: the previous names are still the
  // best answer we have, and a wrong "unknown" is what the user sees as the
  // bug. Only a successful read replaces them.
  if (!ok && hit?.ok) {
    cache.set(vpsId, { ...hit, at: Date.now() - TTL_MS + FAIL_TTL_MS });
    return hit.names;
  }
  cache.set(vpsId, { at: Date.now(), names, ok });
  return names;
}

/** Drop the cache for a VPS — after starting or resuming a session, whose
 *  --name only takes effect at that moment. */
export function invalidateCliNames(vpsId: string): void {
  cache.delete(vpsId);
}
