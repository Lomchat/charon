import 'server-only';
import { createHash } from 'node:crypto';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { endpointToken, type StoredEndpoint } from './customEndpoints';
import type { EndpointEngine, EndpointCheck, EndpointModel } from '@/lib/customEndpoints';

export type ProbeResult = { ok: boolean; models: EndpointModel[]; check?: EndpointCheck; catalogError?: string };
const cache = new Map<string, { at: number; result: ProbeResult }>();
function fingerprint(endpoint: StoredEndpoint, engine: EndpointEngine, vpsId: string): string {
  return createHash('sha256').update(JSON.stringify([endpoint.baseUrl, endpoint.auth, endpoint.model, endpointToken(endpoint), engine, vpsId])).digest('hex');
}
export function withEndpointChecks(endpoint: StoredEndpoint, vpsId: string): StoredEndpoint {
  const copy = { ...endpoint, checks: { ...endpoint.checks } };
  for (const engine of ['claude', 'codex'] as const) {
    const hit = cache.get(fingerprint(endpoint, engine, vpsId));
    if (!hit || Date.now() - hit.at > 30 * 60_000) continue;
    copy.models = hit.result.models;
    if (hit.result.check) copy.checks[engine] = hit.result.check;
  }
  return copy;
}
export async function probeEndpoint(endpoint: StoredEndpoint, engine: EndpointEngine, vpsId: string, action: 'models' | 'test'): Promise<ProbeResult> {
  const result = await getAgentClientForVpsId(vpsId).call<ProbeResult>('endpoint_probe', {
    engine, action, endpoint: { ...endpoint, secret: undefined, token: endpointToken(endpoint) },
  });
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
