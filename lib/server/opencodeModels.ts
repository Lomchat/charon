import 'server-only';
import { getSetting, setSetting } from './claude/settings';
import { isOpenCodeGo, mergeOpenCodeModels, parseOpenCodeModels } from '@/lib/opencodeModels';
import type { CustomEndpoint, EndpointModel } from '@/lib/customEndpoints';

const CACHE = 'opencode.model_metadata';
const TTL = 6 * 60 * 60_000;
const CACHE_VERSION = 2;
let inflight: Promise<Record<string, EndpointModel>> | null = null;
let retryAt = 0;
function cached(): { table: Record<string, EndpointModel>; current: boolean } {
  try {
    const value = JSON.parse(getSetting(CACHE) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cache');
    return { table: value.models || (value.version ? {} : value), current: value.version === CACHE_VERSION };
  } catch { return { table: {}, current: false }; }
}
async function refresh() {
  try {
    const response = await fetch('https://models.dev/api.json', {
      signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { 'User-Agent': 'Charon', Accept: 'application/json' },
    });
    if (!response.ok || !response.body) throw new Error('Catalog unavailable');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error('Catalog too large');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const table = parseOpenCodeModels(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!Object.keys(table).length) throw new Error('Empty catalog');
    setSetting(CACHE, JSON.stringify({ version: CACHE_VERSION, models: table })); setSetting(`${CACHE}_at`, String(Date.now()));
    return table;
  } catch { retryAt = Date.now() + 60_000; return cached().table; }
}
export async function enrichEndpoint<T extends CustomEndpoint>(endpoint: T): Promise<T> {
  if (!isOpenCodeGo(endpoint.baseUrl)) return endpoint;
  let { table, current } = cached();
  if ((!current || !Object.keys(table).length || Date.now() > Number(getSetting(`${CACHE}_at`) || 0) + TTL) && Date.now() >= retryAt) {
    inflight ??= refresh().finally(() => { inflight = null; });
    if (!current || !Object.keys(table).length) table = await inflight;
  }
  return mergeOpenCodeModels(endpoint, table);
}
