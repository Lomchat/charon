import { describe, it, expect, vi, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nodeCrypto from 'node:crypto';

// ── Session-id hashing migration under crash/rerun scenarios (Codex 13.5) ──
// The dangerous property: raw and hashed ids are both 64-hex, so a re-run
// of the migration would double-hash and log everyone out. The marker is
// therefore written INSIDE the same transaction as the rewrites. These
// tests pin: (a) migration correctness (old cookies keep working), (b)
// strict idempotence of a re-run, (c) the marker exists after migration.

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-auth-test-')),
  'test.db',
);
process.env.SESSION_SECRET = 'test-session-secret-for-hmac';

vi.mock('server-only', () => ({}));

let db: any;
let schema: any;
let auth: any;

const RAW_1 = nodeCrypto.randomBytes(32).toString('hex');
const RAW_2 = nodeCrypto.randomBytes(32).toString('hex');

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });

  db.insert(schema.users).values({ passwordHash: 'x', passwordSalt: 'x', keyCheck: 'x' }).run();
  const [u] = db.select().from(schema.users).all();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  // LEGACY rows: raw tokens stored as-is (pre-hash format).
  db.insert(schema.sessions).values({ id: RAW_1, userId: u.id, expiresAt: exp }).run();
  db.insert(schema.sessions).values({ id: RAW_2, userId: u.id, expiresAt: exp }).run();

  auth = await import('@/lib/server/auth');
});

describe('session-id hashing migration', () => {
  it('rewrites ids, keeps old cookies valid, and sets the marker atomically', async () => {
    auth.migrateSessionIdsToHashed();

    const ids = db.select().from(schema.sessions).all().map((r: any) => r.id).sort();
    expect(ids).not.toContain(RAW_1);
    expect(ids).not.toContain(RAW_2);
    ids.forEach((id: string) => expect(id).toMatch(/^[0-9a-f]{64}$/));

    // The browser still holds the RAW token — lookups hash it.
    expect(await auth.getSession(RAW_1)).not.toBeNull();
    expect(await auth.getSession(RAW_2)).not.toBeNull();
    expect(await auth.getSession('f'.repeat(64))).toBeNull();

    const [marker] = db.select().from(schema.claudeSettings).all()
      .filter((r: any) => r.key === 'auth.session_ids_hashed');
    expect(marker?.value).toBe('1');
  });

  it('a re-run is a strict no-op (no double hash — that would log everyone out)', async () => {
    const before = db.select().from(schema.sessions).all().map((r: any) => r.id).sort();
    auth.migrateSessionIdsToHashed();
    const after = db.select().from(schema.sessions).all().map((r: any) => r.id).sort();
    expect(after).toEqual(before);
    expect(await auth.getSession(RAW_1)).not.toBeNull();
  });

  it('createSession stores the hash but returns the raw cookie token', async () => {
    const { id: raw } = await auth.createSession();
    const ids = db.select().from(schema.sessions).all().map((r: any) => r.id);
    expect(ids).not.toContain(raw);
    expect(await auth.getSession(raw)).not.toBeNull();
    await auth.dropSession(raw);
    expect(await auth.getSession(raw)).toBeNull();
  });
});
