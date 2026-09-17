import catalogs from '@/agent/charon_agent/endpoint_catalogs.json';
import { normalizeEndpointUrl } from './customEndpoints';

/** Shared, reviewed routes only. A compatible inference API does not imply a catalog. */
export function endpointCatalog(baseUrl: string) {
  try {
    const normalized = normalizeEndpointUrl(baseUrl);
    return catalogs.find((catalog) => catalog.baseUrl === normalized);
  } catch { return undefined; }
}
export const NO_ENDPOINT_CATALOG = 'Automatic model discovery is not available for this endpoint. Enter a model ID or use an existing saved model.';
