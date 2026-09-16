import { invalidateSessionInsightSnapshot } from '@/lib/server/claude/sessionInsightSnapshot';
import 'server-only';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { connectionConfig, publicConnection, type StoredEndpoint } from '@/lib/server/customEndpoints';
import { emitGlobalSessionListChanged, peekStream, resumeSession } from './sessionOps';
import { getAgentClientForVpsId } from './AgentClientPool';
import { endpointModelCheck } from '@/lib/customEndpoints';

const inflight = new Map<string, Promise<void>>();
export async function applyPendingEndpoint(id: string): Promise<void> {
  if (inflight.has(id)) return inflight.get(id);
  const promise = (async () => {
    let row = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get();
    if (!row || row.archived) return;
    const config = connectionConfig(row.codexConfig);
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
    row = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get();
    if (!row || row.archived) return;
    const current = connectionConfig(row.codexConfig);
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
    const effort = pending.endpoint ? null : restored?.effort ?? null;
    current.customEndpoint = pending.endpoint;
    if (!pending.endpoint) delete current.standardConnection;
    current.pendingConnection = null;
    current.endpointError = null;
    db.update(claudeSessions).set({ codexConfig: JSON.stringify(current), model, fallbackModel, effort, effectiveModel: null })
      .where(eq(claudeSessions.id, id)).run();
    if (stream) {
      stream.model = model; stream.fallbackModel = fallbackModel;
      stream.effort = effort as any; stream.effectiveModel = null;
    }
    invalidateSessionInsightSnapshot(id);
    emitGlobalSessionListChanged(id);
    if (running) await resumeSession(id);
  })().catch((error) => {
    const row = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get();
    if (row) {
      const cfg = connectionConfig(row.codexConfig);
      cfg.endpointError = error instanceof Error ? error.message.slice(0, 300) : 'Could not apply endpoint.';
      db.update(claudeSessions).set({ codexConfig: JSON.stringify(cfg) }).where(eq(claudeSessions.id, id)).run();
      emitGlobalSessionListChanged(id);
    }
    throw error;
  }).finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return promise;
}
export async function queueEndpoint(id: string, endpoint: StoredEndpoint | null) {
  const row = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get();
  if (!row) throw new Error('Session not found.');
  if (endpoint) {
    const check = endpointModelCheck(endpoint, row.kind, endpoint.model);
    endpoint = { ...endpoint, checks: { ...endpoint.checks, ...(check ? { [row.kind]: check } : {}) } };
  }
  // Feature discovery before writing anything: old agents must never ignore a route.
  await getAgentClientForVpsId(row.vpsId).call('endpoint_probe', { action: 'capability' });
  if (inflight.has(id)) await inflight.get(id);
  const cfg = connectionConfig(db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get()!.codexConfig);
  cfg.pendingConnection = { endpoint, model: endpoint?.model ?? null };
  cfg.endpointError = null;
  db.update(claudeSessions).set({ codexConfig: JSON.stringify(cfg) }).where(eq(claudeSessions.id, id)).run();
  emitGlobalSessionListChanged(id);
  await applyPendingEndpoint(id);
  return publicConnection(db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get()?.codexConfig);
}
