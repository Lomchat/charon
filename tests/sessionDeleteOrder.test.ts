import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-delete-order-test-')), 'test.db',
);
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ call: async () => ({ ok: true }) }),
}));

let db: typeof import('@/lib/db').db;
let schema: typeof import('@/lib/db');
let deleteSession: typeof import('@/lib/server/agent/sessionOps').deleteSession;

beforeAll(async () => {
  schema = await import('@/lib/db');
  db = schema.db;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default' })
    .onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: 'vps1', name: 'test', ip: '127.0.0.1', sshUser: 'root' }).run();
  ({ deleteSession } = await import('@/lib/server/agent/sessionOps'));
});

beforeEach(() => { db.delete(schema.claudeSessions).run(); });

describe('session deletion keeps sidebar path order', () => {
  it('packs surviving paths in the order shown before deleting their first card', async () => {
    const rows = [
      { id: 'a1', cwd: '/srv/a', position: 0 },
      { id: 'b1', cwd: '/srv/b', position: 1 },
      { id: 'a2', cwd: '/srv/a/', position: 2 },
      { id: 'c1', cwd: '/srv/c', position: 3 },
      { id: 'a3', cwd: '/srv/a', position: 4 },
    ];
    for (const [i, row] of rows.entries()) {
      db.insert(schema.claudeSessions).values({
        ...row, vpsId: 'vps1', status: 'sleeping', createdAt: i + 1,
      }).run();
    }

    expect((await deleteSession('a1')).deleted).toBe(true);
    const remaining = db.select({ id: schema.claudeSessions.id, position: schema.claudeSessions.position })
      .from(schema.claudeSessions).all().sort((a, b) => a.position - b.position);
    expect(remaining).toEqual([
      { id: 'a2', position: 0 }, { id: 'a3', position: 1 },
      { id: 'b1', position: 2 }, { id: 'c1', position: 3 },
    ]);
  });

  it('does not let an archived card hide a visible path move', async () => {
    const rows = [
      { id: 'a-archived', cwd: '/srv/a', position: 0, archived: 1 },
      { id: 'b1', cwd: '/srv/b', position: 1, archived: 0 },
      { id: 'a1', cwd: '/srv/a', position: 2, archived: 0 },
      { id: 'c1', cwd: '/srv/c', position: 3, archived: 0 },
      { id: 'a2', cwd: '/srv/a', position: 4, archived: 0 },
    ];
    for (const [i, row] of rows.entries()) {
      db.insert(schema.claudeSessions).values({
        ...row, vpsId: 'vps1', status: 'sleeping', createdAt: i + 1,
      }).run();
    }

    await deleteSession('a1');
    const remaining = db.select({
      id: schema.claudeSessions.id,
      position: schema.claudeSessions.position,
      archived: schema.claudeSessions.archived,
    }).from(schema.claudeSessions).all().sort((a, b) => a.position - b.position);
    expect(remaining).toEqual([
      { id: 'b1', position: 0, archived: 0 },
      { id: 'a2', position: 1, archived: 0 },
      { id: 'c1', position: 2, archived: 0 },
      { id: 'a-archived', position: 3, archived: 1 },
    ]);
  });
});
