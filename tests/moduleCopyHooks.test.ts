import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vps } from '@/lib/db/schema';

// Hook slots across module copies (CLAUDE.md §14.106, G12). Next evaluates
// sessionOps/AgentClient/autoConnect in ≥3 copies (instrumentation, routes,
// login action); the boot (instrumentation) copy owns the attached streams and
// the connecting AgentClients, while usagePoll wires its hooks from another
// copy. `vi.resetModules()` reproduces it: copy 1 SETS a hook,
// copy 2's code READS it — through `hubHooks()` on globalThis. As module-level
// `let`s, every one of these read null in copy 2.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: vi.fn(async () => {}) }));
vi.mock('@/lib/server/hub/codexBgState', () => ({ readCodexBgState: vi.fn(async () => []) }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: vi.fn(async () => {}),
  sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: vi.fn(async () => {}),
  sendPlainToTelegram: vi.fn(async () => {}),
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {},
    call: async () => ({ status: 'active' }),
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));
// autoConnect's own side channels (only the armed-set identity is under test).
vi.mock('@/lib/server/agent/usagePoll', () => ({ armUsageWatch: vi.fn(), armCodexUsageWatch: vi.fn() }));
vi.mock('@/lib/server/agent/loginSweeps', () => ({ sweepProviderLogins: vi.fn() }));
vi.mock('@/lib/server/agent/shellNotify', () => ({ ensureShellIdleWatch: vi.fn() }));
vi.mock('@/lib/server/agent/accountProfiles', () => ({ armAccountProfileWatch: vi.fn() }));
vi.mock('@/lib/server/hub/modelSync', () => ({ refreshModelsIfStale: vi.fn(async () => {}) }));

const VPS_ID = 'copyvps';
const SID = 'd'.repeat(32);

type Ops = typeof import('@/lib/server/agent/sessionOps');
let db: any;
let schema: any;

/** Two distinct evaluations of sessionOps (two module copies). */
async function twoCopies(): Promise<[Ops, Ops]> {
  vi.resetModules();
  const one = await import('@/lib/server/agent/sessionOps');
  vi.resetModules();
  const two = await import('@/lib/server/agent/sessionOps');
  expect(two).not.toBe(one);
  expect(two.SessionStream).not.toBe(one.SessionStream);
  return [one, two];
}

function stream(ops: Ops, kind: 'claude' | 'codex' = 'claude') {
  return new ops.SessionStream({
    id: SID, vpsId: VPS_ID, name: 'build', status: 'thinking',
    permissionMode: kind === 'codex' ? 'workspace-write' : 'normal', nativeSessionId: null, kind,
  }) as any;
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test-vps', ip: '127.0.0.1', sshUser: 'root' })
    .onConflictDoNothing().run();
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
});

beforeEach(() => {
  db.delete(schema.sessionMessages).run();
  db.delete(schema.agentSessions).run();
  db.insert(schema.agentSessions).values({ id: SID, vpsId: VPS_ID, cwd: '/tmp', name: 'build', status: 'thinking' }).run();
});

describe('hook slots shared by every module copy', () => {
  it('hubHooks() is one globalThis object, whatever the copy', async () => {
    vi.resetModules();
    const a = await import('@/lib/server/agent/hubHooks');
    vi.resetModules();
    const b = await import('@/lib/server/agent/hubHooks');
    expect(b.hubHooks).not.toBe(a.hubHooks);
    expect(b.hubHooks()).toBe(a.hubHooks());
    expect((globalThis as any).__charonHooks).toBe(a.hubHooks());
  });

  it('usage triggers and handlers set by copy 1 fire from copy-2 streams', async () => {
    const [one, two] = await twoCopies();
    const poll = vi.fn();
    const codexPoll = vi.fn();
    const codexPush = vi.fn();
    const windows = vi.fn();
    const resetResolver = vi.fn((): number | null => null);
    one.setUsagePollTrigger(poll);
    one.setCodexUsagePollTrigger(codexPoll);
    one.setCodexUsagePushHandler(codexPush);
    one.setUsageWindowsHandler(windows);
    one.setUsageResetResolver(resetResolver);

    const claude = stream(two, 'claude');
    claude._onAgentEvent({ event: 'stop', session_id: SID, seq: 1, subtype: 'end_turn' });
    expect(poll).toHaveBeenCalledWith(VPS_ID, 'default');
    expect(codexPoll).not.toHaveBeenCalled();
    const win = { five_hour: { utilization: 12 } };
    claude._onAgentEvent({ event: 'rate_limit', session_id: SID, seq: 2, status: 'allowed', windows: win });
    // Unstamped (old agent) ⇒ the stream's own profile, never a guess.
    expect(windows).toHaveBeenCalledWith(VPS_ID, win, expect.any(Number), 'default', undefined);
    claude._onAgentEvent({ event: 'error', session_id: SID, seq: 3, fatal: true, msg: 'SDK crashed' });
    expect(resetResolver).toHaveBeenCalledWith(VPS_ID, 'claude', 'default');

    const codex = stream(two, 'codex');
    codex._onAgentEvent({ event: 'stop', session_id: SID, seq: 4, subtype: 'end_turn' });
    expect(codexPoll).toHaveBeenCalledWith(VPS_ID, 'default');
    const detail = { primary: { used_percent: 3 } };
    codex._onAgentEvent({ event: 'codex_signal', session_id: SID, seq: 5, kind: 'account_limits', detail });
    expect(codexPush).toHaveBeenCalledWith(VPS_ID, detail, 'default', undefined);
  });

  it('the vps_status emitter wired by sessionOps reaches a copy-2 AgentClient (no sessionOps in that copy)', async () => {
    vi.resetModules();
    const ops = await import('@/lib/server/agent/sessionOps');   // wires setVpsStatusEmitter at load
    const events: any[] = [];
    const off = ops.subscribeGlobalSessionEvents((ev) => { if (ev.type === 'vps_status') events.push(ev); });
    vi.resetModules();
    const { AgentClient } = await import('@/lib/server/agent/AgentClient');
    const client = new AgentClient({ id: VPS_ID, name: 'test-vps' } as Vps, new Promise<void>(() => {}));
    (client as any)._scheduleReconnect = () => {};
    (client as any).stderrBuf = "python3.12: can't open file '/root/.charon/charon-agent.pyz': [Errno 2] No such file or directory";
    (client as any)._handleExit(2);
    off();
    expect(events).toEqual([expect.objectContaining({
      type: 'vps_status', sessionId: VPS_ID, agentStatus: 'missing', agentLastError: null,
    })]);
  });

  it('armAgentClientHooks arms a client ONCE across module copies', async () => {
    vi.resetModules();
    const a = await import('@/lib/server/agent/autoConnect');
    vi.resetModules();
    const b = await import('@/lib/server/agent/autoConnect');
    expect(b.armAgentClientHooks).not.toBe(a.armAgentClientHooks);
    const client = { onStatus: vi.fn(), status: 'idle', hello: null };
    a.armAgentClientHooks(client as any, VPS_ID);
    b.armAgentClientHooks(client as any, VPS_ID);
    a.armAgentClientHooks(client as any, VPS_ID);
    expect(client.onStatus).toHaveBeenCalledTimes(1);
    // A recreated client (dropAgentClient → getAgentClient) is armed again.
    const fresh = { onStatus: vi.fn(), status: 'idle', hello: null };
    b.armAgentClientHooks(fresh as any, VPS_ID);
    expect(fresh.onStatus).toHaveBeenCalledTimes(1);
  });
});
