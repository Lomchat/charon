import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-assistant-finality-')),
  'test.db',
);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/claude/telegram', () => ({
  sendPermissionToTelegram: vi.fn(async () => {}),
  sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: vi.fn(async () => {}),
  sendPlainToTelegram: vi.fn(async () => {}),
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {},
    call: async () => ({ status: 'active' }),
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'finality-vps';
const SID = 'f'.repeat(32);
let db: any;
let schema: any;
let SessionStream: any;

function stream() {
  return new SessionStream({
    id: SID, vpsId: VPS_ID, vpsName: 'test', name: 'chat',
    status: 'active', permissionMode: 'normal', claudeSessionId: null,
    kind: 'claude',
  }) as any;
}

function event(streamInstance: any, seq: number, name: string, extra: Record<string, unknown> = {}) {
  streamInstance._onAgentEvent({ event: name, session_id: SID, seq, ts: Date.now() / 1000, ...extra });
}

function assistantRows() {
  return db.select().from(schema.claudeSessionMessages).all()
    .filter((row: any) => row.role === 'assistant');
}

beforeAll(async () => {
  const mod = await import('@/lib/db');
  db = mod.db;
  schema = mod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  db.insert(schema.claudeSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ({ SessionStream } = await import('@/lib/server/agent/sessionOps'));
});

beforeEach(() => {
  db.delete(schema.claudeSessionMessages).run();
  db.delete(schema.claudeSessions).run();
  db.insert(schema.claudeSessions).values({
    id: SID, vpsId: VPS_ID, cwd: '/tmp', status: 'active',
  }).run();
});

describe('durable assistant finality', () => {
  it('marks only the last assistant text of each completed turn final', () => {
    const s = stream();
    event(s, 1, 'assistant_text', { delta: 'I will inspect it.' });
    event(s, 2, 'thinking', { text: 'checking' });
    event(s, 3, 'assistant_text', { delta: 'Here is the answer.' });
    event(s, 4, 'stop');
    expect(assistantRows().map((row: any) => [row.content, row.assistantFinal]))
      .toEqual([['I will inspect it.', 0], ['Here is the answer.', 1]]);

    s._persist('user', 'Next question');
    event(s, 5, 'assistant_text', { delta: 'Next answer.' });
    event(s, 6, 'stop');
    expect(assistantRows().map((row: any) => row.assistantFinal)).toEqual([0, 1, 1]);
  });

  it('finalizes after a hub restart and never reuses an old provisional row', () => {
    const first = stream();
    event(first, 1, 'assistant_text', { delta: 'Interrupted answer.' });
    event(first, 2, 'thinking', { text: 'checking' });
    expect(assistantRows()[0].assistantFinal).toBe(0);

    const resumed = stream();
    event(resumed, 3, 'stop');
    expect(assistantRows()[0].assistantFinal).toBe(1);

    resumed._persist('user', 'Another question');
    event(resumed, 4, 'stop');
    expect(assistantRows()[0].assistantFinal).toBe(1);

    event(resumed, 5, 'assistant_text', { delta: 'Unfinished.' });
    event(resumed, 6, 'thinking', { text: 'checking again' });
    event(resumed, 7, 'stop', { ts: (Date.now() - 10_000) / 1000 });
    expect(assistantRows().map((row: any) => row.assistantFinal)).toEqual([1, 0]);
    resumed._persist('user', 'New turn after interruption');
    event(resumed, 8, 'stop');
    expect(assistantRows().map((row: any) => row.assistantFinal)).toEqual([1, 0]);
  });
});
