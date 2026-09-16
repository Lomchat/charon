import { isEffortValue } from './sessionCapabilities';

/** Public connection metadata. Credentials never belong in session list/detail payloads. */
export type EndpointEngine = 'claude' | 'codex';
export type EndpointAuth = 'none' | 'api-key' | 'bearer';
export type EndpointModel = { id: string; contextWindow?: number; effortLevels?: string[]; checks?: Partial<Record<EndpointEngine, EndpointCheck>> };
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
  pending?: { endpoint: CustomEndpoint | null; model: string | null } | null;
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
