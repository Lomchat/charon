import { invalidateSessionInsightSnapshot } from '@/lib/server/hub/sessionInsightSnapshot';
import 'server-only';
import { eq } from 'drizzle-orm';
import { db, agentSessions } from '@/lib/db';
import { connectionConfig, parseEndpoint, publicConnection, savedEndpoint, type StoredEndpoint } from '@/lib/server/customEndpoints';
import { withEndpointChecks } from '@/lib/server/endpointProbe';
import { emitGlobalSessionListChanged, peekStream, resumeSession } from './sessionOps';
import { getAgentClientForVpsId } from './AgentClientPool';
import { endpointModelCheck, supportsCustomEndpoint, validEndpointEffort } from '@/lib/customEndpoints';
import { enrichEndpoint } from '@/lib/server/opencodeModels';

const inflight = new Map<string, Promise<void>>();
export async function applyPendingEndpoint(id: string): Promise<void> {
  if (inflight.has(id)) return inflight.get(id);
  const promise = (async () => {
    let row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
    if (!row || row.archived) return;
    const config = connectionConfig(row.providerConfig);
    if (!config.pendingConnection || config.endpointError) return;
    const stream = peekStream(id);
    if (['thinking', 'starting', 'background'].includes(stream?.status ?? row.status) || stream?.hasRunningBgTasks()) return;
    const client = getAgentClientForVpsId(row.vpsId);
    if (client.status !== 'connected') return;
    // Ask the resident owner too: SSE/DB may still be catching up with a new turn.
    const sessions = await client.call<any>('list_sessions');
    const entries = Array.isArray(sessions) ? sessions : sessions.sessions ?? [];
    const remote = entries.find((s: any) => s.session_id === id);
    if (remote && ['thinking', 'starting'].includes(remote.status)) return;
    const running = remote && remote.status === 'active';
    if (running) {
      const stopped = await client.call('sleep_session', { session_id: id, only_if_idle: true });
      if (stopped.busy) return;
    }
    row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
    if (!row || row.archived) return;
    const current = connectionConfig(row.providerConfig);
    const pending = current.pendingConnection;
    if (!pending) {
      if (running) await resumeSession(id);
      return;
    }
    if (!current.customEndpoint && pending.endpoint && !current.standardConnection) {
      current.standardConnection = { model: row.model, fallbackModel: row.fallbackModel, effort: row.effort };
    }
    const restored = current.standardConnection;
    const model = pending.endpoint ? pending.model : restored?.model ?? null;
    const fallbackModel = pending.endpoint ? null : restored?.fallbackModel ?? null;
    const effort = pending.endpoint ? pending.effort ?? null : restored?.effort ?? null;
    current.customEndpoint = pending.endpoint;
    if (!pending.endpoint) delete current.standardConnection;
    current.pendingConnection = null;
    current.endpointError = null;
    db.update(agentSessions).set({ providerConfig: JSON.stringify(current), model, fallbackModel, effort, effectiveModel: null })
      .where(eq(agentSessions.id, id)).run();
    if (stream) {
      stream.model = model; stream.fallbackModel = fallbackModel;
      stream.effort = effort as any; stream.effectiveModel = null;
      stream.customEndpoint = !!pending.endpoint;
    }
    invalidateSessionInsightSnapshot(id);
    emitGlobalSessionListChanged(id);
    if (running) await resumeSession(id);
  })().catch((error) => {
    const row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
    if (row) {
      const cfg = connectionConfig(row.providerConfig);
      cfg.endpointError = error instanceof Error ? error.message.slice(0, 300) : 'Could not apply endpoint.';
      db.update(agentSessions).set({ providerConfig: JSON.stringify(cfg) }).where(eq(agentSessions.id, id)).run();
      emitGlobalSessionListChanged(id);
    }
    throw error;
  }).finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return promise;
}
export async function queueEndpoint(id: string, endpoint: StoredEndpoint | null, effort?: string | null) {
  const row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  if (!row) throw new Error('Session not found.');
  if (endpoint) {
    endpoint = await enrichEndpoint(endpoint);
    const check = endpointModelCheck(endpoint, row.kind, endpoint.model);
    endpoint = { ...endpoint, checks: { ...endpoint.checks, ...(check ? { [row.kind]: check } : {}) } };
  }
  // Feature discovery before writing anything: old agents must never ignore a route.
  const capability = await getAgentClientForVpsId(row.vpsId).call<{ capabilities?: string[] }>('endpoint_probe', { action: 'capability' });
  if (effort !== undefined) {
    if (!capability.capabilities?.includes('endpoint_parameters')) throw new Error('Update the agent on this VPS to configure endpoint parameters.');
    if (!endpoint || !validEndpointEffort(endpoint, row.kind, endpoint.model, effort)) throw new Error('These parameters are not supported by this endpoint model.');
  }
  if (inflight.has(id)) await inflight.get(id);
  const cfg = connectionConfig(db.select().from(agentSessions).where(eq(agentSessions.id, id)).get()!.providerConfig);
  if (effort !== undefined && (cfg.customEndpoint?.model !== endpoint?.model
    || cfg.customEndpoint?.baseUrl !== endpoint?.baseUrl || cfg.customEndpoint?.secret !== endpoint?.secret)) {
    throw new Error('The session connection changed. Refresh before changing parameters.');
  }
  if (effort !== undefined && cfg.pendingConnection && cfg.pendingConnection.effort === undefined) throw new Error('Apply or cancel the pending connection change before changing parameters.');
  cfg.pendingConnection = { endpoint, model: endpoint?.model ?? null, ...(effort !== undefined ? { effort } : {}) };
  cfg.endpointError = null;
  db.update(agentSessions).set({ providerConfig: JSON.stringify(cfg) }).where(eq(agentSessions.id, id)).run();
  emitGlobalSessionListChanged(id);
  await applyPendingEndpoint(id);
  return publicConnection(db.select().from(agentSessions).where(eq(agentSessions.id, id)).get()?.providerConfig);
}
/** A session BORN on a saved endpoint (`POST /api/sessions` `endpoint`). Applying
 *  one afterwards needs an idle sleep + resume, and a session that never ran a
 *  turn has no native conversation to resume: the endpoint must ride the create. */
export async function endpointForNewSession(vpsId: string, kind: string, savedId: string, model: string | null, effort: string | null): Promise<StoredEndpoint> {
  if (!supportsCustomEndpoint(kind)) throw new Error('Custom endpoints are not supported by this engine.');
  const saved = savedEndpoint(savedId);
  let endpoint = withEndpointChecks(parseEndpoint({ name: saved.name, baseUrl: saved.baseUrl, auth: saved.auth, model: model || saved.model }, saved), vpsId);
  endpoint = await enrichEndpoint(endpoint);
  const check = endpointModelCheck(endpoint, kind, endpoint.model);
  endpoint = { ...endpoint, checks: { ...endpoint.checks, ...(check ? { [kind]: check } : {}) } };
  const capability = await getAgentClientForVpsId(vpsId).call<{ capabilities?: string[] }>('endpoint_probe', { action: 'capability' });
  if (effort) {
    if (!capability.capabilities?.includes('endpoint_parameters')) throw new Error('Update the agent on this VPS to configure endpoint parameters.');
    if (!validEndpointEffort(endpoint, kind, endpoint.model, effort)) throw new Error('These parameters are not supported by this endpoint model.');
  }
  return endpoint;
}
