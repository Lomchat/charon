import 'server-only';
import { createHash } from 'node:crypto';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { endpointToken, type StoredEndpoint } from './customEndpoints';
import type { EndpointEngine, EndpointCheck, EndpointModel } from '@/lib/customEndpoints';
import { enrichEndpoint } from './opencodeModels';
import { endpointCatalog, NO_ENDPOINT_CATALOG } from '@/lib/endpointDiscovery';

export type ProbeResult = { ok: boolean; models: EndpointModel[]; check?: EndpointCheck; catalogError?: string };
const cache = new Map<string, { at: number; result: ProbeResult }>();
function fingerprint(endpoint: StoredEndpoint, engine: EndpointEngine, vpsId: string): string {
  return createHash('sha256').update(JSON.stringify([endpoint.baseUrl, endpoint.auth, endpoint.model, endpointToken(endpoint), engine, vpsId])).digest('hex');
}
export function withEndpointChecks(endpoint: StoredEndpoint, vpsId: string): StoredEndpoint {
  const copy = { ...endpoint, checks: { ...endpoint.checks } };
  const previous = new Map(endpoint.models?.map((m) => [m.id, m]));
  for (const engine of ['claude', 'codex'] as const) {
    const hit = cache.get(fingerprint(endpoint, engine, vpsId));
    if (!hit || Date.now() - hit.at > 30 * 60_000) continue;
    // A failed probe often has no catalog; keep the other models' verified checks.
    if (hit.result.models.length) copy.models = hit.result.models;
    if (hit.result.check) copy.checks[engine] = hit.result.check;
  }
  copy.models = (copy.models ?? []).map((model) => {
    const checks = { ...previous.get(model.id)?.checks };
    for (const engine of ['claude', 'codex'] as const) {
      const hit = cache.get(fingerprint({ ...endpoint, model: model.id }, engine, vpsId));
      if (hit?.result.check && Date.now() - hit.at <= 30 * 60_000) checks[engine] = hit.result.check;
    }
    return { ...model, ...(Object.keys(checks).length ? { checks } : {}) };
  });
  return copy;
}
export async function probeEndpoint(endpoint: StoredEndpoint, engine: EndpointEngine, vpsId: string, action: 'models' | 'test'): Promise<ProbeResult> {
  if (action === 'models' && !endpointCatalog(endpoint.baseUrl)) {
    return { ok: false, models: [], catalogError: NO_ENDPOINT_CATALOG };
  }
  const client = getAgentClientForVpsId(vpsId);
  // Older probes always guessed /v1/models, even for a tools-only test.
  const capability = await client.call<{ capabilities?: string[] }>('endpoint_probe', { action: 'capability' });
  if (!capability.capabilities?.includes('endpoint_discovery')) {
    throw new Error('Update the agent on this VPS to test endpoints or load models without automatic discovery requests.');
  }
  const result = await client.call<ProbeResult>('endpoint_probe', {
    engine, action, endpoint: { ...endpoint, secret: undefined, token: endpointToken(endpoint) },
  });
  result.models = (await enrichEndpoint({ ...endpoint, models: result.models })).models ?? result.models;
  if (result.check) result.check.vpsId = vpsId;
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  const key = fingerprint(endpoint, engine, vpsId);
  // Discovering the catalogue must not erase a recent full compatibility test.
  const previous = cache.get(key);
  if (action === 'models' && previous && Date.now() - previous.at <= 30 * 60_000) {
    cache.set(key, { ...previous, result: { ...previous.result, models: result.models } });
  } else cache.set(key, { at: Date.now(), result });
  return result;
}
