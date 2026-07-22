import { describe, it, expect, vi, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Fail-closed behavior of at-rest secrets (Codex 16.6) ────────────────────
// Scenarios: a DB holding a HISTORICAL plaintext secret while the MASTER key
// is missing/invalid must, in production, refuse to SERVE the plaintext (not
// just refuse new writes); with a valid key the boot migration encrypts it
// and reads work transparently.
//
// Order matters: the invalid-key scenarios run FIRST (masterKey caches a
// successfully derived key — once cached, it can't be un-derived).

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-secrets-test-')),
  'test.db',
);
delete process.env.MASTER_PASSWORD;
delete process.env.MASTER_SALT;

vi.mock('server-only', () => ({}));

let db: any;
let schema: any;
let settings: any;

const PLAINTEXT = '123456:legacy-telegram-token';

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  // Historical plaintext secret row (pre-encryption deployment).
  db.insert(schema.claudeSettings).values({ key: 'telegram.bot_token', value: PLAINTEXT })
    .onConflictDoNothing().run();
  settings = await import('@/lib/server/claude/settings');
});

describe('secrets at rest — fail-closed policy', () => {
  it('production + missing key: a historical plaintext secret is REFUSED at read', () => {
    const prev = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'production';
    try {
      expect(settings.getSetting('telegram.bot_token')).toBe('');
    } finally {
      (process.env as any).NODE_ENV = prev;
    }
  });

  it('production + missing key: writing a NEW secret throws (fail-closed)', () => {
    const prev = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'production';
    try {
      expect(() => settings.setSetting('claude.api_key', 'sk-ant-new')).toThrow();
    } finally {
      (process.env as any).NODE_ENV = prev;
    }
  });

  it('invalid (non-hex) MASTER_SALT derives NO key — same refusal as missing', async () => {
    process.env.MASTER_PASSWORD = 'pw';
    process.env.MASTER_SALT = 'zz-not-hex-zz';
    const { getEnvAesKey } = await import('@/lib/server/masterKey');
    expect(getEnvAesKey()).toBeNull();
    const prev = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'production';
    try {
      expect(settings.getSetting('telegram.bot_token')).toBe('');
    } finally {
      (process.env as any).NODE_ENV = prev;
    }
  });

  it('valid key: boot migration encrypts the historical value; reads stay transparent', async () => {
    process.env.MASTER_PASSWORD = 'pw';
    process.env.MASTER_SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const { getEnvAesKey } = await import('@/lib/server/masterKey');
    expect(getEnvAesKey()).not.toBeNull();

    settings.encryptSecretsAtRest();
    const [row] = db.select().from(schema.claudeSettings).all()
      .filter((r: any) => r.key === 'telegram.bot_token');
    expect(row.value.startsWith('enc:v1:')).toBe(true);      // encrypted at rest
    expect(settings.getSetting('telegram.bot_token')).toBe(PLAINTEXT); // transparent read

    // New writes encrypt too, and round-trip.
    settings.setSetting('claude.api_key', 'sk-ant-xyz');
    const [row2] = db.select().from(schema.claudeSettings).all()
      .filter((r: any) => r.key === 'claude.api_key');
    expect(row2.value.startsWith('enc:v1:')).toBe(true);
    expect(settings.getSetting('claude.api_key')).toBe('sk-ant-xyz');
  });
});
