import 'server-only';
import { db, vps } from '@/lib/db';
import type { VpsRuntimeSnapshot } from '@/lib/types/api';
import { VPS_RUNTIME_KEYS } from '@/lib/vpsRuntimeFields';

/**
 * Read the browser-safe, mutable portion of every VPS row.
 *
 * This deliberately excludes IPs, SSH usernames/keys and all other
 * connection/configuration fields. It is shared by the session-list polling
 * backstop and the initial SSE snapshot so both convergence paths have the
 * exact same field set — and that set comes from the provider registry
 * (`lib/vpsRuntimeFields`), so a new backend's columns cannot be left out of
 * one path and present in another (§14.52/§14.102).
 */
export function listVpsRuntimeSnapshots(): VpsRuntimeSnapshot[] {
  const columns: Record<string, unknown> = { id: vps.id };
  for (const key of VPS_RUNTIME_KEYS) {
    columns[key] = (vps as unknown as Record<string, unknown>)[key];
  }
  return db.select(columns as never).from(vps).all() as unknown as VpsRuntimeSnapshot[];
}
