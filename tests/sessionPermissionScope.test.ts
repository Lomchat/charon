import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-permission-scope-test-')),
  'test.db',
);

const agentMocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/claude/telegram', () => ({
  sendPermissionToTelegram: vi.fn(async () => {}),
  sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: vi.fn(async () => {}),
  sendPlainToTelegram: vi.fn(async () => {}),
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    resubscribe: () => {},
    call: agentMocks.call,
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'permission-vps';
let db: any;
let schema: any;
let SessionStream: any;
let startNewSession: any;
let setSetting: any;

function insertSession(id: string, kind: 'claude' | 'codex') {
  db.insert(schema.claudeSessions).values({
    id, vpsId: VPS_ID, cwd: '/tmp/project', name: 'permissions',
    kind, status: 'active', permissionMode: kind === 'codex' ? 'workspace-write' : 'normal',
  }).run();
}

function stream(id: string, kind: 'claude' | 'codex') {
  return new SessionStream({
    id, vpsId: VPS_ID, vpsName: 'test-vps', name: 'permissions',
    status: 'active', permissionMode: kind === 'codex' ? 'workspace-write' : 'normal',
    claudeSessionId: null, kind, cwd: '/tmp/project',
  }) as any;
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 })
    .onConflictDoNothing().run();
  db.insert(schema.vps).values({
    id: VPS_ID, name: 'test-vps', ip: '127.0.0.1', sshUser: 'root', codexAvailable: 1,
  }).onConflictDoNothing().run();
  ({ SessionStream, startNewSession } = await import('@/lib/server/agent/sessionOps'));
  ({ setSetting } = await import('@/lib/server/claude/settings'));
});

beforeEach(() => {
  agentMocks.call.mockReset();
  agentMocks.call.mockResolvedValue({ ok: true, status: 'active' });
  db.delete(schema.claudePendingPermissions).run();
  db.delete(schema.claudeSessions).run();
  setSetting('codex.default_approvals_reviewer', 'user');
});

describe('provider-aware permission scope', () => {
  it('never hydrates an old broad Codex allow rule', () => {
    const id = '1'.repeat(32);
    insertSession(id, 'codex');
    const s = stream(id, 'codex');
    s.hydrateAlwaysAllow(JSON.stringify(['Codex command']));

    s._onAgentEvent({
      event: 'permission_request', session_id: id, id: 'perm-codex',
      tool: 'Codex command', input: { command: 'rm something' }, seq: 1,
    });

    expect(agentMocks.call).not.toHaveBeenCalled();
    expect(db.select().from(schema.claudePendingPermissions).all())
      .toEqual([expect.objectContaining({ id: 'perm-codex', status: 'pending' })]);
  });

  it('keeps the card pending when the provider rejects the response RPC', async () => {
    const id = '2'.repeat(32);
    insertSession(id, 'codex');
    db.insert(schema.claudePendingPermissions).values({
      id: 'perm-offline', sessionId: id, toolName: 'Codex command',
      toolInput: '{}', status: 'pending',
    }).run();
    agentMocks.call.mockRejectedValueOnce(new Error('agent offline'));

    await expect(stream(id, 'codex').respondPermission('perm-offline', true, true))
      .rejects.toThrow('agent offline');

    expect(db.select().from(schema.claudePendingPermissions).all()[0].status).toBe('pending');
    expect(db.select().from(schema.claudeSessions).all()[0].alwaysAllowTools).toBeNull();
  });

  it('persists Claude always-allow only after the provider accepts it', async () => {
    const id = '3'.repeat(32);
    insertSession(id, 'claude');
    db.insert(schema.claudePendingPermissions).values({
      id: 'perm-claude', sessionId: id, toolName: 'Bash',
      toolInput: '{}', status: 'pending',
    }).run();

    await stream(id, 'claude').respondPermission('perm-claude', true, true);

    expect(agentMocks.call).toHaveBeenCalledWith('respond_permission', {
      session_id: id, perm_id: 'perm-claude', allow: true, always: true,
    });
    expect(db.select().from(schema.claudePendingPermissions).all()[0].status).toBe('allowed');
    expect(JSON.parse(db.select().from(schema.claudeSessions).all()[0].alwaysAllowTools))
      .toEqual(['Bash']);
  });

  it('auto-applies a remembered Claude grant without losing failure recovery', async () => {
    const id = '4'.repeat(32);
    insertSession(id, 'claude');
    const s = stream(id, 'claude');
    s.hydrateAlwaysAllow(JSON.stringify(['Bash']));

    s._onAgentEvent({
      event: 'permission_request', session_id: id, id: 'perm-remembered',
      tool: 'Bash', input: { command: 'npm test' }, seq: 2,
    });

    await vi.waitFor(() => expect(agentMocks.call).toHaveBeenCalledWith(
      'respond_permission',
      { session_id: id, perm_id: 'perm-remembered', allow: true, always: false },
    ));
    expect(db.select().from(schema.claudePendingPermissions).all()[0].status).toBe('allowed');
  });

  it('copies the global Codex reviewer default into each new session', async () => {
    setSetting('codex.default_approvals_reviewer', 'auto_review');
    const created = await startNewSession({
      vpsId: VPS_ID, cwd: '/tmp/project', kind: 'codex',
      permissionMode: 'workspace-write',
    });
    const row = db.select().from(schema.claudeSessions).all()
      .find((candidate: any) => candidate.id === created.id);

    expect(JSON.parse(row.codexConfig).approvalsReviewer).toBe('auto_review');
    expect(agentMocks.call).toHaveBeenCalledWith('start_session', expect.objectContaining({
      session_id: created.id,
      codex_config: expect.objectContaining({ approvalsReviewer: 'auto_review' }),
    }));
  });
});
