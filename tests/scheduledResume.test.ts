import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'charon-scheduled-test-')), 'test.db');
const agentCall = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ call: agentCall }),
  getAgentClient: () => ({}), dropAgentClient: async () => {},
}));
vi.mock('@/lib/server/claude/telegram', () => ({
  sendPermissionToTelegram: async () => {}, sendQuestionToTelegram: async () => {},
  markInteractionResolvedInTelegram: async () => {}, sendPlainToTelegram: async () => {},
}));

let db: any;
let schema: any;
let createScheduledResume: any;
let cancelScheduledResume: any;
let runScheduledResumesDue: any;

beforeAll(async () => {
  schema = await import('@/lib/db');
  db = schema.db;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default' }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: 'vps', name: 'vps', ip: '127.0.0.1', sshUser: 'root' }).run();
  db.insert(schema.claudeSessions).values({ id: 's'.repeat(32), vpsId: 'vps', cwd: '/tmp', status: 'failed' }).run();
  ({ createScheduledResume, cancelScheduledResume, runScheduledResumesDue } = await import('@/lib/server/agent/scheduledResume'));
});

describe('durable scheduled resume', () => {
  it('creates one visible card per rate-limit error and can cancel it', () => {
    const sessionId = 's'.repeat(32);
    const source = db.insert(schema.claudeSessionMessages).values({
      sessionId, role: 'error', content: '{}', tsMs: Date.now(),
    }).run();
    const resetAt = Date.now() + 3_600_000;
    const first = createScheduledResume({
      sessionId, sourceMessageId: Number(source.lastInsertRowid), resetAt,
    });
    const second = createScheduledResume({
      sessionId, sourceMessageId: Number(source.lastInsertRowid), resetAt,
    });
    expect(second.id).toBe(first.id);
    expect(first.runAt).toBe(resetAt + 120_000);

    const cards = db.select().from(schema.claudeSessionMessages).all()
      .filter((row: any) => row.role === 'scheduled_resume');
    expect(cards).toHaveLength(1);
    expect(JSON.parse(cards[0].content)).toMatchObject({
      scheduleId: first.id, status: 'scheduled', attempts: 0,
    });

    const cancelled = cancelScheduledResume(sessionId, first.id);
    expect(cancelled.status).toBe('cancelled');
    const card = db.select().from(schema.claudeSessionMessages).all()
      .find((row: any) => row.id === first.messageId);
    expect(JSON.parse(card.content).status).toBe('cancelled');
  });

  it('delivers after the safety delay and records the user prompt once', async () => {
    vi.useFakeTimers();
    agentCall.mockClear();
    const sessionId = 's'.repeat(32);
    const source = db.insert(schema.claudeSessionMessages).values({
      sessionId, role: 'error', content: '{}', tsMs: Date.now(),
    }).run();
    const job = createScheduledResume({
      sessionId, sourceMessageId: Number(source.lastInsertRowid), resetAt: Date.now() - 1,
    });
    vi.setSystemTime(Date.now() + 121_000);
    await runScheduledResumesDue();

    const sent = db.select().from(schema.sessionScheduledResumes).all()
      .find((row: any) => row.id === job.id);
    expect(sent.status).toBe('sent');
    expect(agentCall).toHaveBeenCalledTimes(1);
    expect(db.select().from(schema.claudeSessionMessages).all().filter((row: any) =>
      row.sessionId === sessionId && row.role === 'user' && row.content.includes('limit has now reset')))
      .toHaveLength(1);
    vi.useRealTimers();
  });
});
