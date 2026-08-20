import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Killing ONE background item (§14.91) crosses a provider seam: Claude answers
// `stop_bg_task` (the SDK's stop_task), Codex has no such thing — its rows in
// the same bar are native background TERMINALS reconciled into the common
// bg_task lifecycle (§14.95), and the kill is `stop_background_terminal`.
// Routing them both through one hub function is what these tests pin; sending
// a Codex row to `stop_bg_task` is a 500 the user sees as "could not stop".

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-bg-stop-test-')),
  'test.db',
);

const rpc = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; params: any }>,
  result: {} as any,
}));

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
    call: async (method: string, params: any) => {
      rpc.calls.push({ method, params });
      return rpc.result;
    },
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'stopvps';
const CLAUDE_SID = 'a'.repeat(32);
const CODEX_SID = 'b'.repeat(32);

let db: any;
let schema: any;
let stopBackgroundTask: (sessionId: string, taskId: string) => Promise<void>;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });

  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 })
    .onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test-vps', ip: '127.0.0.1', sshUser: 'root' })
    .onConflictDoNothing().run();
  for (const [id, kind] of [[CLAUDE_SID, 'claude'], [CODEX_SID, 'codex']] as const) {
    db.insert(schema.claudeSessions).values({
      id, vpsId: VPS_ID, name: kind, cwd: '/srv/app', kind, status: 'active',
      permissionMode: kind === 'codex' ? 'workspace-write' : 'normal',
    }).onConflictDoNothing().run();
  }

  ({ stopBackgroundTask } = await import('@/lib/server/agent/sessionOps'));
});

beforeEach(() => {
  rpc.calls.length = 0;
  rpc.result = { ok: true };
});

describe('stopBackgroundTask', () => {
  it('sends a Claude task to stop_bg_task', async () => {
    await stopBackgroundTask(CLAUDE_SID, 'task-7');
    expect(rpc.calls).toEqual([
      { method: 'stop_bg_task', params: { session_id: CLAUDE_SID, task_id: 'task-7' } },
    ]);
  });

  it('sends a Codex background terminal to stop_background_terminal, unwrapping the process id', async () => {
    rpc.result = { ok: true, terminated: true };
    await stopBackgroundTask(CODEX_SID, 'codex-terminal:pty-3');
    expect(rpc.calls).toEqual([
      {
        method: 'stop_background_terminal',
        params: { session_id: CODEX_SID, process_id: 'pty-3' },
      },
    ]);
  });

  it('refuses a Codex item with no per-item stop WITHOUT spending an RPC', async () => {
    await expect(stopBackgroundTask(CODEX_SID, 'agent-thread-42')).rejects.toThrow(/interrupt the turn/);
    expect(rpc.calls).toEqual([]);
  });

  it('treats a refusal envelope as a failure (the RPC does not raise)', async () => {
    rpc.result = { ok: false, error: 'Codex thread is not running' };
    await expect(stopBackgroundTask(CODEX_SID, 'codex-terminal:pty-3'))
      .rejects.toThrow(/thread is not running/);
  });

  it('treats terminated:false as a failure, not an ack', async () => {
    rpc.result = { ok: true, terminated: false };
    await expect(stopBackgroundTask(CODEX_SID, 'codex-terminal:pty-3'))
      .rejects.toThrow(/did not terminate/);
  });
});
