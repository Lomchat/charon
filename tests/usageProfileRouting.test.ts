import { beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A session's live account state (Claude `rate_limit` windows, Codex
// `account_limits`) belongs to THAT session's account profile. Agents before
// 0.103.3 sent it unstamped from the live reader; the hub used to file it under
// the VPS DEFAULT profile, so account 2's turns repainted account 1's gauges.
process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'charon-usage-routing-')), 'test.db');

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: vi.fn(async () => {}), sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: vi.fn(async () => {}), sendPlainToTelegram: vi.fn(async () => {}),
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, call: async () => ({ status: 'active' }) }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'routing-vps';
let SessionStream: any;
let hooks: any;

beforeAll(async () => {
  const mod = await import('@/lib/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(mod.db, { migrationsFolder: './drizzle' });
  mod.db.insert(mod.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  mod.db.insert(mod.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  ({ SessionStream } = await import('@/lib/server/agent/sessionOps'));
  hooks = (await import('@/lib/server/agent/hubHooks')).hubHooks();
});

function stream(id: string, kind: 'claude' | 'codex', accountProfile?: string) {
  return new SessionStream({ id, vpsId: VPS_ID, vpsName: 'test', name: 'chat', status: 'active',
    permissionMode: 'normal', nativeSessionId: null, kind, accountProfile }) as any;
}
const windows = { five_hour: { utilization: 0.25, resets_at: Date.now() / 1000 + 3600 } };

it('files an unstamped Claude rate_limit under the session\'s own profile', () => {
  const seen: unknown[][] = [];
  const prev = hooks.usageWindowsHandler;
  hooks.usageWindowsHandler = (...args: unknown[]) => { seen.push(args); };
  try {
    stream('a'.repeat(32), 'claude', 'profile-2')._onAgentEvent({ event: 'rate_limit', session_id: 'a'.repeat(32), seq: 1, ts: Date.now() / 1000, windows });
    stream('b'.repeat(32), 'claude')._onAgentEvent({ event: 'rate_limit', session_id: 'b'.repeat(32), seq: 1, ts: Date.now() / 1000, windows });
    // A stamped reading keeps the agent's word.
    stream('c'.repeat(32), 'claude', 'profile-2')._onAgentEvent({ event: 'rate_limit', session_id: 'c'.repeat(32), seq: 1,
      ts: Date.now() / 1000, windows, account_profile: 'profile-3', account_key: 'K' });
  } finally { hooks.usageWindowsHandler = prev; }
  expect(seen.map((a) => [a[3], a[4]])).toEqual([['profile-2', undefined], ['default', undefined], ['profile-3', 'K']]);
});

it('files an unstamped Codex account_limits under the session\'s own profile', () => {
  const seen: unknown[][] = [];
  const prev = hooks.codexUsagePushHandler;
  hooks.codexUsagePushHandler = (...args: unknown[]) => { seen.push(args); };
  try {
    stream('d'.repeat(32), 'codex', 'profile-2')._onAgentEvent({ event: 'codex_signal', kind: 'account_limits',
      session_id: 'd'.repeat(32), seq: 1, ts: Date.now() / 1000, detail: {} });
  } finally { hooks.codexUsagePushHandler = prev; }
  expect(seen.map((a) => a[2])).toEqual(['profile-2']);
});
