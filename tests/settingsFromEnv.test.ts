import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `.env` AMORCES a setting; it never commands it (§14.100).
 *
 * The two ways to get this wrong are symmetric and both make the UI look
 * broken: re-applying the env var on every boot silently reverts what the
 * operator saved, while never applying it makes a scripted install land on the
 * built-in default with no way to say otherwise. The rule that avoids both is
 * "apply only when the key has no row at all" — and the marker has to be the
 * ROW, not getSetting(), which happily returns the built-in default forever.
 */
process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-settings-env-test-')), 'test.db');
vi.mock('server-only', () => ({}));

let settings: typeof import('@/lib/server/claude/settings');
let schema: typeof import('@/lib/db');

beforeAll(async () => {
  schema = await import('@/lib/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(schema.db, { migrationsFolder: './drizzle' });
  settings = await import('@/lib/server/claude/settings');
});

afterEach(() => {
  delete process.env.CHARON_CLAUDE_SETTING_SOURCES;
  schema.db.delete(schema.claudeSettings).run();
  // setSetting caches in a globalThis Map; drop it so each case starts cold.
  (globalThis as any)._claudeSettingsCache?.clear();
});

function storedRow(key: string) {
  return schema.db.select().from(schema.claudeSettings).all()
    .find((r) => r.key === key) ?? null;
}

describe('seedSettingsFromEnv', () => {
  it('does nothing without the env var', () => {
    settings.seedSettingsFromEnv();
    expect(storedRow('claude.setting_sources')).toBeNull();
    // …and the built-in default still answers.
    expect(settings.getSetting('claude.setting_sources')).toBe('project');
  });

  it('writes the value on a fresh database', () => {
    process.env.CHARON_CLAUDE_SETTING_SOURCES = 'user,project';
    settings.seedSettingsFromEnv();
    expect(storedRow('claude.setting_sources')?.value).toBe('user,project');
  });

  it('never overwrites a value the operator already saved', () => {
    settings.setSetting('claude.setting_sources', 'project');
    process.env.CHARON_CLAUDE_SETTING_SOURCES = 'user,project,local';
    settings.seedSettingsFromEnv();
    settings.seedSettingsFromEnv(); // every boot re-runs this step
    expect(storedRow('claude.setting_sources')?.value).toBe('project');
  });

  it('is idempotent across boots', () => {
    process.env.CHARON_CLAUDE_SETTING_SOURCES = 'none';
    settings.seedSettingsFromEnv();
    settings.setSetting('claude.setting_sources', 'project'); // the user changes it
    settings.seedSettingsFromEnv();                           // the hub restarts
    expect(storedRow('claude.setting_sources')?.value).toBe('project');
  });

  it('ignores a value that is not a valid scope', () => {
    process.env.CHARON_CLAUDE_SETTING_SOURCES = 'user,typo';
    settings.seedSettingsFromEnv();
    expect(storedRow('claude.setting_sources')).toBeNull();
  });
});
