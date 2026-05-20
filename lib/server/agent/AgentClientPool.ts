import 'server-only';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { AgentClient } from './AgentClient';

// Cache at the globalThis level to survive Next.js dev hot reloads.
const g = globalThis as unknown as { _agentClientPool?: Map<string, AgentClient> };
if (!g._agentClientPool) g._agentClientPool = new Map();
const pool: Map<string, AgentClient> = g._agentClientPool;

/** Get (or lazily create) an AgentClient for the given VPS. */
export function getAgentClient(vps: Vps): AgentClient {
  let c = pool.get(vps.id);
  if (!c) {
    c = new AgentClient(vps);
    pool.set(vps.id, c);
    // Start the connection immediately, but don't block the caller.
    c.ready().catch(() => {});
  }
  return c;
}

/** Variant: load the VPS from the DB. Throws if not found. */
export function getAgentClientForVpsId(vpsId: string): AgentClient {
  const cached = pool.get(vpsId);
  if (cached) return cached;
  const [row] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!row) throw new Error(`vps ${vpsId} not found`);
  return getAgentClient(row);
}

/** List VPS for which we have an active client (useful for diagnostics). */
export function listAgentClients(): AgentClient[] {
  return Array.from(pool.values());
}

/** Close and purge a client (on VPS delete or credentials change). */
export async function dropAgentClient(vpsId: string): Promise<void> {
  const c = pool.get(vpsId);
  if (!c) return;
  pool.delete(vpsId);
  await c.close();
}
