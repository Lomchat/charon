import 'server-only';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { AgentClient } from './AgentClient';

// Cache au niveau du globalThis pour survivre aux hot reloads de Next.js dev.
const g = globalThis as unknown as { _agentClientPool?: Map<string, AgentClient> };
if (!g._agentClientPool) g._agentClientPool = new Map();
const pool: Map<string, AgentClient> = g._agentClientPool;

/** Récupère (ou crée à la demande) un AgentClient pour le VPS donné. */
export function getAgentClient(vps: Vps): AgentClient {
  let c = pool.get(vps.id);
  if (!c) {
    c = new AgentClient(vps);
    pool.set(vps.id, c);
    // Lance la connexion immédiatement, mais ne bloque pas l'appelant.
    c.ready().catch(() => {});
  }
  return c;
}

/** Variante : charge le VPS depuis la DB. Throw si introuvable. */
export function getAgentClientForVpsId(vpsId: string): AgentClient {
  const cached = pool.get(vpsId);
  if (cached) return cached;
  const [row] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!row) throw new Error(`vps ${vpsId} not found`);
  return getAgentClient(row);
}

/** Liste les VPS pour lesquels on a un client actif (utile diagnostique). */
export function listAgentClients(): AgentClient[] {
  return Array.from(pool.values());
}

/** Ferme et purge un client (sur delete VPS ou changement de credentials). */
export async function dropAgentClient(vpsId: string): Promise<void> {
  const c = pool.get(vpsId);
  if (!c) return;
  pool.delete(vpsId);
  await c.close();
}
