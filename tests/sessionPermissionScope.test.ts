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
vi.mock('@/lib/server/hub/telegram', () => ({
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
let expireStalePendingInteractions: any;
let sweepExpiredInteractions: any;
let subscribeGlobalSessionEvents: any;

  function insertSession(id: string, kind: 'claude' | 'codex') {
  db.insert(schema.agentSessions).values({
    id, vpsId: VPS_ID, cwd: '/tmp/project', name: 'permissions',
    kind, status: 'active', permissionMode: kind === 'codex' ? 'workspace-write' : 'normal',
  }).run();
}

function stream(id: string, kind: 'claude' | 'codex') {
  return new SessionStream({
    id, vpsId: VPS_ID, vpsName: 'test-vps', name: 'permissions',
    status: 'active', permissionMode: kind === 'codex' ? 'workspace-write' : 'normal',
    nativeSessionId: null, kind, cwd: '/tmp/project',
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
  ({
    SessionStream, startNewSession, sweepExpiredInteractions, subscribeGlobalSessionEvents,
  } = await import('@/lib/server/agent/sessionOps'));
  ({ expireStalePendingInteractions } = await import('@/lib/server/agent/pendingInteractions'));
  ({ setSetting } = await import('@/lib/server/hub/settings'));
});

beforeEach(() => {
  agentMocks.call.mockReset();
  agentMocks.call.mockResolvedValue({ ok: true, status: 'active' });
  db.delete(schema.sessionPendingPermissions).run();
  db.delete(schema.agentSessions).run();
  setSetting('codex.default_approvals_reviewer', 'user');
  setSetting('claude.default_permission_mode', 'normal');
  setSetting('codex.default_permission_mode', 'workspace-write');
  setSetting('cursor.default_permission_mode', 'agent');
});

describe('provider-aware permission scope', () => {
  it('never answers a Codex card itself, nor replays an old broad Codex allow rule', async () => {
    const id = '1'.repeat(32);
    insertSession(id, 'codex');
    db.update(schema.agentSessions).set({ alwaysAllowTools: JSON.stringify(['Codex command']) }).run();
    const { withRememberedRules } = await import('@/lib/server/agent/sessionOps');
    expect(withRememberedRules('codex', { model: 'x' }, JSON.stringify(['Codex command'])))
      .toEqual({ model: 'x' });
    const s = stream(id, 'codex');

    s._onAgentEvent({
      event: 'permission_request', session_id: id, id: 'perm-codex',
      tool: 'Codex command', input: { command: 'rm something' }, seq: 1,
    });

    expect(agentMocks.call).not.toHaveBeenCalled();
    expect(db.select().from(schema.sessionPendingPermissions).all())
      .toEqual([expect.objectContaining({ id: 'perm-codex', status: 'pending' })]);
  });

  it('keeps the card pending when the provider rejects the response RPC', async () => {
    const id = '2'.repeat(32);
    insertSession(id, 'codex');
    db.insert(schema.sessionPendingPermissions).values({
      id: 'perm-offline', sessionId: id, toolName: 'Codex command',
      toolInput: '{}', status: 'pending',
    }).run();
    agentMocks.call.mockRejectedValueOnce(new Error('agent offline'));

    await expect(stream(id, 'codex').respondPermission('perm-offline', true, true))
      .rejects.toThrow('agent offline');

    expect(db.select().from(schema.sessionPendingPermissions).all()[0].status).toBe('pending');
    expect(db.select().from(schema.agentSessions).all()[0].alwaysAllowTools).toBeNull();
  });

  it('does not report a late approval as accepted after provider expiry', async () => {
    const id = '7'.repeat(32);
    insertSession(id, 'codex');
    db.insert(schema.sessionPendingPermissions).values({
      id: 'perm-too-late', sessionId: id, toolName: 'Codex command',
      toolInput: '{}', status: 'pending',
    }).run();
    agentMocks.call.mockResolvedValueOnce({ ok: true, resolved: false });

    await expect(stream(id, 'codex').respondPermission('perm-too-late', true))
      .rejects.toThrow('already expired or been cancelled');

    // Never `allowed`: the provider's refusal says the gate is gone, so the
    // row is retired (`cancelled`, published) instead of staying a dead card.
    expect(db.select().from(schema.sessionPendingPermissions).all()[0].status)
      .toBe('cancelled');
  });

  it('stores the provider deadline and closes an expired approval durably', () => {
    const id = '5'.repeat(32);
    insertSession(id, 'codex');
    const s = stream(id, 'codex');

    const expiresAt = Math.floor(Date.now() / 1000) + 1800;
    s._onAgentEvent({
      event: 'permission_request', session_id: id, id: 'perm-expiring',
      tool: 'Codex command', input: { command: 'npm test' },
      expires_at: expiresAt, seq: 3,
    });
    expect(db.select().from(schema.sessionPendingPermissions).all()[0])
      .toEqual(expect.objectContaining({
        id: 'perm-expiring', status: 'pending', expiresAt,
      }));

    s._onAgentEvent({
      event: 'interaction_resolved', session_id: id, id: 'perm-expiring',
      kind: 'permission', outcome: 'expired', seq: 4,
    });
    expect(db.select().from(schema.sessionPendingPermissions).all()[0].status)
      .toBe('expired');
  });

  it('sweeps a provider deadline missed while the hub was offline', () => {
    const id = '6'.repeat(32);
    insertSession(id, 'claude');
    db.insert(schema.sessionPendingPermissions).values({
      id: 'perm-missed', sessionId: id, toolName: 'Bash', toolInput: '{}',
      status: 'pending', expiresAt: Math.floor(Date.now() / 1000) - 1,
    }).run();

    // Returns what it expired, so the caller publishes each (C07, G7).
    expect(expireStalePendingInteractions())
      .toEqual([{ kind: 'permission', id: 'perm-missed', sessionId: id }]);

    expect(db.select().from(schema.sessionPendingPermissions).all()[0].status)
      .toBe('expired');
  });

  it('publishes the sweep and the late answer to an expired approval', async () => {
    const id = '8'.repeat(32);
    insertSession(id, 'claude');
    db.insert(schema.sessionPendingPermissions).values({
      id: 'perm-swept', sessionId: id, toolName: 'Bash', toolInput: '{}',
      status: 'pending', expiresAt: Math.floor(Date.now() / 1000) - 1,
    }).run();
    const frames: any[] = [];
    const off = subscribeGlobalSessionEvents((ev: any) => { frames.push(ev); });
    try {
      expect(sweepExpiredInteractions()).toBe(1);
      // An answer to the swept card refuses AND repeats its outcome: the
      // asker's ghost card goes away instead of failing silently.
      await expect(stream(id, 'claude').respondPermission('perm-swept', true))
        .rejects.toThrow('already expired or been resolved');
    } finally {
      off();
    }
    expect(agentMocks.call).not.toHaveBeenCalled();
    expect(frames.filter((f) => f.type === 'interaction_resolved')).toEqual([
      expect.objectContaining({ sessionId: id, kind: 'permission', id: 'perm-swept', outcome: 'expired' }),
      expect.objectContaining({ sessionId: id, kind: 'permission', id: 'perm-swept', outcome: 'expired' }),
    ]);
  });

  // Claude's "don't ask again" options are the CLI's own (lib/permissionSuggestions.ts).
  const CLI_OPTIONS = JSON.stringify([
    { type: 'setMode', mode: 'plan', destination: 'session' },          // no button
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]);

  function claudeCard(id: string, permId: string) {
    insertSession(id, 'claude');
    db.update(schema.agentSessions).set({ alwaysAllowTools: JSON.stringify(['Edit']) }).run();
    db.insert(schema.sessionPendingPermissions).values({
      id: permId, sessionId: id, toolName: 'Bash',
      toolInput: '{}', status: 'pending', suggestions: CLI_OPTIONS,
    }).run();
  }
  const remembered = () => JSON.parse(db.select().from(schema.agentSessions).all()[0].alwaysAllowTools);

  it('a Claude answer picks a CLI option by index; its rule is remembered once the provider accepts', async () => {
    const id = '3'.repeat(32);
    claudeCard(id, 'perm-claude');

    await stream(id, 'claude').respondPermission('perm-claude', true, false, 1);

    expect(agentMocks.call).toHaveBeenCalledWith('respond_permission', {
      session_id: id, perm_id: 'perm-claude', allow: true, always: false, suggestion: 1,
    });
    expect(db.select().from(schema.sessionPendingPermissions).all()[0].status).toBe('allowed');
    expect(remembered()).toEqual(['Edit', 'Bash(npm test:*)']);
  });

  it('a Claude `always` without an index (Telegram) takes the first option offered', async () => {
    const id = '4'.repeat(32);
    claudeCard(id, 'perm-tg');
    await stream(id, 'claude').respondPermission('perm-tg', true, true);
    expect(agentMocks.call).toHaveBeenCalledWith('respond_permission', {
      session_id: id, perm_id: 'perm-tg', allow: true, always: true, suggestion: 1,
    });
  });

  it('refuses an option the card never offered, and remembers nothing on a rejected RPC', async () => {
    const id = '5'.repeat(32);
    claudeCard(id, 'perm-bad');
    const s = stream(id, 'claude');
    await expect(s.respondPermission('perm-bad', true, false, 0)).rejects.toThrow('not offered');
    expect(agentMocks.call).not.toHaveBeenCalled();

    agentMocks.call.mockRejectedValueOnce(new Error('agent offline'));
    await expect(s.respondPermission('perm-bad', true, false, 1)).rejects.toThrow('agent offline');
    expect(remembered()).toEqual(['Edit']);
    expect(db.select().from(schema.sessionPendingPermissions).all()[0].status).toBe('pending');
  });

  it('a mode-switch option is the agent\'s to apply: nothing is remembered hub-side', async () => {
    const id = '6'.repeat(32);
    claudeCard(id, 'perm-mode');
    await stream(id, 'claude').respondPermission('perm-mode', true, false, 2);
    expect(agentMocks.call).toHaveBeenCalledWith('respond_permission', expect.objectContaining({ suggestion: 2 }));
    expect(remembered()).toEqual(['Edit']);
  });

  it('remembered Claude rules ride every start/resume as allowedTools', async () => {
    const { withRememberedRules, rememberedRules } = await import('@/lib/server/agent/sessionOps');
    expect(withRememberedRules('claude', { skills: 'all' }, JSON.stringify(['Bash', 'Read(//etc/**)'])))
      .toEqual({ skills: 'all', allowedTools: ['Bash', 'Read(//etc/**)'] });
    expect(withRememberedRules('claude', null, JSON.stringify(['Edit']))).toEqual({ allowedTools: ['Edit'] });
    expect(withRememberedRules('claude', { skills: 'all' }, null)).toEqual({ skills: 'all' });
    expect(rememberedRules('not json')).toEqual([]);
    expect(rememberedRules(JSON.stringify(['ok', 3, '', null]))).toEqual(['ok']);
  });

  it('copies the global Codex reviewer default into each new session', async () => {
    setSetting('codex.default_approvals_reviewer', 'auto_review');
    const created = await startNewSession({
      vpsId: VPS_ID, cwd: '/tmp/project', kind: 'codex',
      permissionMode: 'workspace-write',
    });
    const row = db.select().from(schema.agentSessions).all()
      .find((candidate: any) => candidate.id === created.id);

    expect(JSON.parse(row.providerConfig).approvalsReviewer).toBe('auto_review');
    expect(agentMocks.call).toHaveBeenCalledWith('start_session', expect.objectContaining({
      session_id: created.id,
      codex_config: expect.objectContaining({ approvalsReviewer: 'auto_review' }),
    }));
  });

  it('keeps Cursor auto-review mode-derived unless explicitly overridden', async () => {
    const inherited = await startNewSession({
      vpsId: VPS_ID, cwd: '/tmp/project', kind: 'cursor', permissionMode: 'force',
      sessionConfig: { autoReview: null },
    });
    const inheritedConfig = JSON.parse(db.select().from(schema.agentSessions).all()
      .find((candidate: any) => candidate.id === inherited.id).providerConfig);
    expect(inheritedConfig).not.toHaveProperty('autoReview');

    const explicit = await startNewSession({
      vpsId: VPS_ID, cwd: '/tmp/project', kind: 'cursor', permissionMode: 'force',
      sessionConfig: { autoReview: false },
    });
    const explicitConfig = JSON.parse(db.select().from(schema.agentSessions).all()
      .find((candidate: any) => candidate.id === explicit.id).providerConfig);
    expect(explicitConfig.autoReview).toBe(false);
  });

  it.each([
    ['claude', 'claude.default_permission_mode', 'auto'],
    ['codex', 'codex.default_permission_mode', 'accept-all'],
  ] as const)('copies the configured %s mode into a new session', async (kind, key, mode) => {
    setSetting(key, mode);
    const created = await startNewSession({
      vpsId: VPS_ID, cwd: '/tmp/project', kind,
    });
    const row = db.select().from(schema.agentSessions).all()
      .find((candidate: any) => candidate.id === created.id);

    expect(row.permissionMode).toBe(mode);
    expect(agentMocks.call).toHaveBeenCalledWith('start_session', expect.objectContaining({
      session_id: created.id, permission_mode: mode,
    }));
  });
});
