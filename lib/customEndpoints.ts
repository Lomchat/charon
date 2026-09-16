import { isEffortValue } from './sessionCapabilities';
import { decodeModelParams, encodeModelParams, isModelParamSet } from './modelParams';
import type { CursorModelParameter, ModelPrice } from './types/api';

/** Public connection metadata. Credentials never belong in session list/detail payloads. */
export type EndpointEngine = 'claude' | 'codex';
export type EndpointAuth = 'none' | 'api-key' | 'bearer';
export type EndpointModel = {
  id: string; contextWindow?: number; effortLevels?: string[];
  checks?: Partial<Record<EndpointEngine, EndpointCheck>>;
  info?: { name: string; description?: string; family?: string; releaseDate?: string; input?: string[]; outputTokens?: number;
    reasoning?: boolean; tools?: boolean; price?: ModelPrice; tieredPrice?: boolean };
  /** Trusted catalog metadata, independently mapped to each native API. */
  parameters?: Partial<Record<EndpointEngine, CursorModelParameter[]>>;
};
export type EndpointCheck = {
  ok: boolean; engine: EndpointEngine; model: string; vpsId?: string;
  streaming: boolean; tools: boolean; error?: string;
  effortLevels?: string[]; contextWindow?: number;
};
export type CustomEndpoint = {
  id?: string; name: string; baseUrl: string; auth: EndpointAuth;
  model: string; hasToken?: boolean; models?: EndpointModel[];
  checks?: Partial<Record<EndpointEngine, EndpointCheck>>;
};
export type EndpointInput = CustomEndpoint & {
  /** Omitted retains a credential only from the explicitly selected saved/session endpoint. */
  token?: string; savedId?: string; useSessionCredential?: boolean;
};
export type EndpointState = {
  active: CustomEndpoint | null;
  pending?: { endpoint: CustomEndpoint | null; model: string | null; effort?: string | null } | null;
  error?: string | null;
};
export const ENDPOINT_ENGINES: readonly EndpointEngine[] = ['claude', 'codex'];
export function supportsCustomEndpoint(kind: string): kind is EndpointEngine {
  return ENDPOINT_ENGINES.includes(kind as EndpointEngine);
}
export function endpointModelCheck(endpoint: CustomEndpoint | null | undefined, kind: string, model: string): EndpointCheck | undefined {
  if (!endpoint || !supportsCustomEndpoint(kind)) return undefined;
  const check = endpoint.models?.find((m) => m.id === model)?.checks?.[kind] ?? endpoint.checks?.[kind];
  return check?.model === model ? check : undefined;
}
/** Once models have been tested, offer the verified subset for this engine. */
export function endpointModels(endpoint: CustomEndpoint, kind: string): EndpointModel[] {
  const models = endpoint.models ?? [];
  return models.some((m) => m.checks && Object.keys(m.checks).length)
    ? models.filter((m) => endpointModelCheck(endpoint, kind, m.id)?.ok) : models;
}
export function endpointEfforts(endpoint: CustomEndpoint | null | undefined, kind: string, model: string): string[] {
  if (!endpoint || !supportsCustomEndpoint(kind)) return [];
  const check = endpointModelCheck(endpoint, kind, model);
  return check?.ok && check.model === model ? (check.effortLevels ?? []).filter((value) => isEffortValue(kind, value)) : [];
}
export function endpointParameters(endpoint: CustomEndpoint | null | undefined, kind: string, model: string): CursorModelParameter[] {
  if (!endpoint || !supportsCustomEndpoint(kind) || !endpointModelCheck(endpoint, kind, model)?.ok) return [];
  const declared = endpoint.models?.find((m) => m.id === model)?.parameters?.[kind];
  if (declared) return declared;
  const levels = endpointEfforts(endpoint, kind, model);
  return levels.length ? [{ id: 'effort', label: 'Effort', values: levels.map((value) => ({ value })) }] : [];
}
export function endpointParamValues(effort: string | null | undefined): Record<string, string> {
  return effort?.includes('=') ? decodeModelParams(effort) : effort ? { effort } : {};
}
export function validEndpointEffort(endpoint: CustomEndpoint, kind: string, model: string, effort: string | null): boolean {
  if (!effort) return true;
  if (effort.includes('=') && !isModelParamSet(effort)) return false;
  const params = endpointParamValues(effort);
  const axes = endpointParameters(endpoint, kind, model);
  return Object.keys(params).length > 0 && Object.entries(params).every(([id, value]) =>
    axes.some((p) => p.id === id && p.values.some((v) => v.value === value)))
    && !(params.thinking === 'false' && (params.effort || params.budget_tokens));
}
/** Turning reasoning off clears its dependent knobs; selecting a knob turns it on. */
export function changeEndpointParam(effort: string | null, id: string, value: string): string {
  const params = { ...endpointParamValues(effort), [id]: value };
  if (id === 'thinking' && value === 'false') { delete params.effort; delete params.budget_tokens; }
  if (id === 'effort' || id === 'budget_tokens') {
    if (params.thinking === 'false') params.thinking = 'true';
    delete params[id === 'effort' ? 'budget_tokens' : 'effort'];
  }
  return encodeModelParams(params);
}
export function normalizeEndpointUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid endpoint URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) URL without credentials, query parameters or a fragment.');
  }
  // Accept a server root, /v1, or a copied API endpoint, without doubling /v1.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(messages|responses|chat\/completions)$/, '').replace(/\/v1$/, '');
  return url.toString().replace(/\/+$/, '');
}
