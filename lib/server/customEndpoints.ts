import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, customEndpoints } from '@/lib/db';
import { encrypt, decrypt } from './crypto';
import { getEnvAesKey } from './masterKey';
import { normalizeEndpointUrl, type CustomEndpoint, type EndpointInput, type EndpointState } from '@/lib/customEndpoints';

export type StoredEndpoint = CustomEndpoint & { secret?: string };
export type ConnectionConfig = {
  customEndpoint?: StoredEndpoint | null;
  standardConnection?: { model: string | null; fallbackModel: string | null; effort: string | null };
  pendingConnection?: { endpoint: StoredEndpoint | null; model: string | null } | null;
  endpointError?: string | null;
  [key: string]: any;
};
export function connectionConfig(raw: string | null | undefined): ConnectionConfig {
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}
export function sealToken(token: string): string {
  const key = getEnvAesKey();
  if (!key) throw new Error('Configure MASTER_PASSWORD and MASTER_SALT before storing endpoint credentials.');
  return encrypt(token, key);
}
export function endpointToken(endpoint: StoredEndpoint): string {
  if (!endpoint.secret) return '';
  const key = getEnvAesKey();
  if (!key) throw new Error('Endpoint credentials cannot be decrypted.');
  try { return decrypt(endpoint.secret, key); }
  catch { throw new Error('Endpoint credentials cannot be decrypted. Re-enter the token.'); }
}
export function publicEndpoint(endpoint?: StoredEndpoint | null): CustomEndpoint | null {
  if (!endpoint) return null;
  const { secret: _secret, ...rest } = endpoint;
  return { ...rest, hasToken: !!endpoint.secret };
}
export function publicConnection(raw: string | null | undefined): EndpointState {
  const cfg = connectionConfig(raw);
  return {
    active: publicEndpoint(cfg.customEndpoint),
    pending: cfg.pendingConnection ? { ...cfg.pendingConnection, endpoint: publicEndpoint(cfg.pendingConnection.endpoint) } : null,
    error: cfg.endpointError ?? null,
  };
}
export function savedEndpoint(id: string): StoredEndpoint {
  const row = db.select().from(customEndpoints).where(eq(customEndpoints.id, id)).get();
  if (!row) throw new Error('Saved endpoint not found.');
  return { ...JSON.parse(row.config), id: row.id };
}
export function parseEndpoint(input: unknown, previous?: StoredEndpoint | null): StoredEndpoint {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Endpoint configuration required.');
  const raw = input as EndpointInput;
  const baseUrl = normalizeEndpointUrl(String(raw.baseUrl || ''));
  if (baseUrl.length > 2048) throw new Error('Endpoint URL is too long.');
  const auth = raw.auth;
  if (!['none', 'api-key', 'bearer'].includes(auth)) throw new Error('Invalid authentication type.');
  const model = String(raw.model || '').trim();
  if (!model || model.length > 256 || /[\r\n\x00]/.test(model)) throw new Error('Enter a model ID (up to 256 characters).');
  const sameAddress = previous?.baseUrl === baseUrl && previous.auth === auth;
  // A changed host must never silently inherit the old host's credential.
  let secret = sameAddress ? previous?.secret : undefined;
  if (typeof raw.token === 'string') {
    if (raw.token.length > 8192 || /[\r\n\x00]/.test(raw.token)) throw new Error('Invalid endpoint token.');
    secret = raw.token ? sealToken(raw.token) : undefined;
  }
  if (auth === 'none') secret = undefined;
  if (auth !== 'none' && !secret) throw new Error('Enter a token for this endpoint.');
  const sameCredential = sameAddress && (auth === 'none' || raw.token === undefined
    || raw.token === endpointToken(previous!));
  // Test results are populated server-side, never accepted from a form.
  return { name: String(raw.name || new URL(baseUrl).host).trim().slice(0, 100), baseUrl, auth, model, secret,
    ...(sameCredential ? { models: previous?.models, checks: previous?.checks } : {}) };
}
export function saveEndpoint(endpoint: StoredEndpoint, id?: string): CustomEndpoint {
  const key = id || randomUUID();
  db.insert(customEndpoints).values({ id: key, config: JSON.stringify(endpoint) })
    .onConflictDoUpdate({ target: customEndpoints.id, set: { config: JSON.stringify(endpoint) } }).run();
  return publicEndpoint({ ...endpoint, id: key })!;
}
/** Only the SSH RPC boundary receives plaintext. All DB/fork/config copies retain ciphertext. */
export function runtimeConnection<T extends object | null>(config: T): T {
  if (!config) return config;
  const cfg = { ...config } as ConnectionConfig;
  delete cfg.standardConnection; delete cfg.pendingConnection; delete cfg.endpointError;
  if (cfg.customEndpoint) {
    cfg.customEndpoint = { ...publicEndpoint(cfg.customEndpoint), token: endpointToken(cfg.customEndpoint) } as any;
  }
  return cfg as T;
}
