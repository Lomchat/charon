import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Vps } from '@/lib/db/schema';
import type { VpsRuntimeSnapshot } from '@/lib/types/api';
import { mergeVpsRuntimeSnapshots } from '@/app/vpsRuntimeState';

process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'charon-vps-runtime-test-')), 'test.db');
vi.mock('server-only', () => ({}));

let listVpsRuntimeSnapshots: () => VpsRuntimeSnapshot[];

beforeAll(async () => {
  const schema = await import('@/lib/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(schema.db, { migrationsFolder: './drizzle' });
  schema.db.insert(schema.vpsFolders).values({ id: 'default', name: 'default' }).onConflictDoNothing().run();
  schema.db.insert(schema.vps).values({
    id: 'snapshot-vps', name: 'secret box', ip: '192.0.2.99', sshUser: 'private-user',
    agentStatus: 'ok', sdkVersion: '0.2.152', codexCliVersion: '0.153.0',
  }).run();
  ({ listVpsRuntimeSnapshots } = await import('@/lib/server/agent/vpsRuntimeSnapshot'));
});

function vps(overrides: Partial<Vps> = {}): Vps {
  return {
    id: 'v1',
    name: 'box',
    ip: '192.0.2.10',
    sshUser: 'root',
    sshPort: 22,
    folderId: 'default',
    position: 0,
    defaultPath: null,
    agentStatus: 'ok',
    agentLastError: null,
    agentVersion: '0.78.0',
    agentPyzSha: 'old',
    sdkVersion: '0.2.151',
    codexAvailable: 1,
    codexSdkVersion: '0.146.0',
    codexCliVersion: '0.152.1',
    agentLastSeenAt: 1,
    claudeLoggedIn: 1,
    claudeLoggedInCheckedAt: 1,
    codexLoggedIn: 1,
    codexLoggedInCheckedAt: 1,
    claudeSettingSources: null,
    createdAt: 1,
    ...overrides,
  };
}

function snapshot(overrides: Partial<VpsRuntimeSnapshot> = {}): VpsRuntimeSnapshot {
  const row = vps();
  return {
    id: row.id,
    agentStatus: row.agentStatus,
    agentVersion: row.agentVersion,
    agentPyzSha: row.agentPyzSha,
    agentLastError: row.agentLastError,
    sdkVersion: row.sdkVersion,
    codexAvailable: row.codexAvailable,
    codexSdkVersion: row.codexSdkVersion,
    codexCliVersion: row.codexCliVersion,
    claudeLoggedIn: row.claudeLoggedIn,
    codexLoggedIn: row.codexLoggedIn,
    ...overrides,
  };
}

describe('mergeVpsRuntimeSnapshots', () => {
  it('reads only the browser-safe runtime columns', () => {
    const row = listVpsRuntimeSnapshots().find((item) => item.id === 'snapshot-vps');
    expect(row).toBeDefined();
    expect(Object.keys(row!).sort()).toEqual([
      'agentLastError', 'agentPyzSha', 'agentStatus', 'agentVersion',
      'claudeLoggedIn', 'codexAvailable', 'codexCliVersion', 'codexLoggedIn',
      'codexSdkVersion', 'id', 'sdkVersion',
    ].sort());
    expect(row).not.toHaveProperty('ip');
    expect(row).not.toHaveProperty('sshUser');
  });

  it('converges installed versions while preserving static connection data', () => {
    const current = [vps()];
    const result = mergeVpsRuntimeSnapshots(current, [snapshot({
      agentVersion: '0.79.0',
      sdkVersion: '0.2.152',
      codexSdkVersion: '0.147.0',
      codexCliVersion: '0.153.0',
      agentPyzSha: 'new',
    })]);

    expect(result).not.toBe(current);
    expect(result[0]).toMatchObject({
      ip: '192.0.2.10',
      agentVersion: '0.79.0',
      sdkVersion: '0.2.152',
      codexSdkVersion: '0.147.0',
      codexCliVersion: '0.153.0',
      agentPyzSha: 'new',
    });
  });

  it('applies authoritative nulls and preserves array identity when unchanged', () => {
    const current = [vps({ agentLastError: 'old error' })];
    const cleared = mergeVpsRuntimeSnapshots(current, [snapshot({ agentLastError: null })]);
    expect(cleared[0].agentLastError).toBeNull();
    expect(mergeVpsRuntimeSnapshots(cleared, [snapshot()])).toBe(cleared);
  });

  it('ignores snapshots for VPSes absent from the current layout', () => {
    const current = [vps()];
    expect(mergeVpsRuntimeSnapshots(current, [snapshot({ id: 'other' })])).toBe(current);
  });
});
