import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeEndpointUrl, endpointEfforts } from '@/lib/customEndpoints';

process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'charon-endpoints-')), 'test.db');
process.env.MASTER_PASSWORD = 'endpoint-test-password';
process.env.MASTER_SALT = '00112233445566778899aabbccddeeff';
vi.mock('server-only', () => ({}));
const runtime = vi.hoisted(() => ({ status: 'active', sleepBusy: false, calls: [] as any[], resumes: [] as string[] }));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  emitGlobalSessionListChanged: vi.fn(),
  peekStream: () => ({ status: runtime.status, hasRunningBgTasks: () => false }),
  resumeSession: async (id: string) => { runtime.resumes.push(id); },
}));
vi.mock('@/lib/server/claude/sessionInsightSnapshot', () => ({ invalidateSessionInsightSnapshot: vi.fn() }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({ getAgentClientForVpsId: () => ({
  status: 'connected', call: async (method: string, params: any) => {
    runtime.calls.push({ method, params });
    if (method === 'list_sessions') return { sessions: [{ session_id: 'one', status: runtime.status }] };
    if (method === 'sleep_session') return { ok: !runtime.sleepBusy, busy: runtime.sleepBusy };
    return { ok: true };
  },
}) }));
let store: typeof import('@/lib/server/customEndpoints');
let ops: typeof import('@/lib/server/agent/endpointOps');
let database: typeof import('@/lib/db');
beforeAll(async () => {
  database = await import('@/lib/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(database.db, { migrationsFolder: './drizzle' });
  store = await import('@/lib/server/customEndpoints');
  ops = await import('@/lib/server/agent/endpointOps');
  database.db.insert(database.vpsFolders).values({ id: 'default', name: 'Default' }).onConflictDoNothing().run();
  database.db.insert(database.vps).values({ id: 'test', name: 'test', ip: '127.0.0.1', sshUser: 'test' }).run();
  for (const id of ['one', 'two']) database.db.insert(database.claudeSessions).values({ id, vpsId: 'test', cwd: '/tmp', model: 'original', effort: 'high', status: 'active', kind: 'claude' }).run();
});
const input = { name: 'Local', baseUrl: 'http://localhost:8000/v1/messages', auth: 'bearer' as const, token: 'test-secret-token', model: 'custom-model' };
function row(id = 'one') { return database.db.select().from(database.claudeSessions).all().find((r) => r.id === id)!; }
describe('custom endpoint isolation', () => {
  it('normalizes roots and copied API paths; rejects credential-bearing URLs', () => {
    expect(normalizeEndpointUrl(input.baseUrl)).toBe('http://localhost:8000');
    expect(normalizeEndpointUrl('https://gateway.example/api/v1/responses')).toBe('https://gateway.example/api');
    for (const url of ['file:///etc/passwd', 'https://user:pass@host', 'https://host?token=secret']) expect(() => normalizeEndpointUrl(url)).toThrow();
  });
  it('encrypts credentials; only the RPC boundary unwraps them', () => {
    const endpoint = store.parseEndpoint(input);
    expect(JSON.stringify(endpoint)).not.toContain(input.token);
    expect(store.endpointToken(endpoint)).toBe(input.token);
    expect(store.publicEndpoint(endpoint)).toMatchObject({ hasToken: true });
    expect(JSON.stringify(store.publicEndpoint(endpoint))).not.toContain(endpoint.secret);
    const cfg = { customEndpoint: endpoint, standardConnection: { model: 'original' } };
    expect((store.runtimeConnection(cfg).customEndpoint as any).token).toBe(input.token);
    expect(store.runtimeConnection(cfg)).not.toHaveProperty('standardConnection');
    expect(cfg.customEndpoint.secret).toBe(endpoint.secret);
  });
  it('never transfers a saved secret to another host or auth scheme', () => {
    const previous = store.parseEndpoint(input);
    expect(store.parseEndpoint({ ...input, token: undefined }, previous).secret).toBe(previous.secret);
    expect(() => store.parseEndpoint({ ...input, token: undefined, baseUrl: 'https://another.example' }, previous)).toThrow('token');
    expect(store.parseEndpoint({ ...input, auth: 'none' }, previous).secret).toBeUndefined();
  });
  it('does not trust claimed browser capability results', () => {
    const endpoint = store.parseEndpoint({ ...input, checks: { claude: { ok: true, effortLevels: ['max'] } } });
    expect(endpointEfforts(endpoint, 'claude', input.model)).toEqual([]);
    const verified = { ...endpoint, checks: { claude: { ok: true, engine: 'claude' as const, model: input.model, streaming: true, tools: true, effortLevels: ['high'] } } };
    expect(endpointEfforts(store.parseEndpoint({ ...input, token: 'replacement' }, verified), 'claude', input.model)).toEqual([]);
  });
  it('saves a session copy and leaves other sessions unchanged', async () => {
    runtime.status = 'active';
    const before = row('two');
    const endpoint = store.parseEndpoint(input);
    const saved = store.saveEndpoint(endpoint);
    const result = await ops.queueEndpoint('one', store.savedEndpoint(saved.id!));
    expect(result.active?.model).toBe(input.model);
    expect(row()).toMatchObject({ model: input.model, effort: null, fallbackModel: null });
    expect(row().codexConfig).not.toContain(input.token);
    store.saveEndpoint({ ...endpoint, name: 'Changed template' }, saved.id);
    expect(store.publicConnection(row().codexConfig).active?.name).toBe('Local');
    expect(row('two')).toEqual(before);
    expect(runtime.calls.find((c) => c.method === 'sleep_session').params.only_if_idle).toBe(true);
  });
  it('queues while thinking, applies when idle, and restores the original effort', async () => {
    runtime.status = 'thinking'; runtime.calls.length = 0;
    const pending = await ops.queueEndpoint('one', null);
    expect(pending.pending).toEqual({ endpoint: null, model: null });
    expect(row().model).toBe(input.model);
    expect(runtime.calls.some((c) => c.method === 'sleep_session')).toBe(false);
    runtime.status = 'active'; runtime.sleepBusy = true;
    await ops.applyPendingEndpoint('one');
    expect(row().model).toBe(input.model);
    runtime.sleepBusy = false;
    await ops.applyPendingEndpoint('one');
    expect(row()).toMatchObject({ model: 'original', effort: 'high' });
    expect(store.publicConnection(row().codexConfig).active).toBeNull();
    expect(store.connectionConfig(row().codexConfig).standardConnection).toBeUndefined();
  });
});
