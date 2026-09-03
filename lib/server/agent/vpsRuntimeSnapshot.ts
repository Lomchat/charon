import 'server-only';
import { db, vps } from '@/lib/db';
import type { VpsRuntimeSnapshot } from '@/lib/types/api';

/**
 * Read the browser-safe, mutable portion of every VPS row.
 *
 * This deliberately excludes IPs, SSH usernames/keys and all other
 * connection/configuration fields. It is shared by the session-list polling
 * backstop and the initial SSE snapshot so both convergence paths have the
 * exact same field set.
 */
export function listVpsRuntimeSnapshots(): VpsRuntimeSnapshot[] {
  return db.select({
    id: vps.id,
    agentStatus: vps.agentStatus,
    agentVersion: vps.agentVersion,
    agentPyzSha: vps.agentPyzSha,
    agentLastError: vps.agentLastError,
    sdkVersion: vps.sdkVersion,
    codexAvailable: vps.codexAvailable,
    codexSdkVersion: vps.codexSdkVersion,
    codexCliVersion: vps.codexCliVersion,
    claudeLoggedIn: vps.claudeLoggedIn,
    codexLoggedIn: vps.codexLoggedIn,
  }).from(vps).all();
}
