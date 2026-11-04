import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '', profileDir: '', spawn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: mocks.spawn.mockImplementation((_binary, args, options) =>
    // sshd starts its command as a process-group leader. Reproduce that
    // topology with real pipes, so setsid's fork can break code delivery.
    original.spawn('/bin/sh', ['-c', args.at(-1)], {
      ...options, detached: true, env: { ...process.env, HOME: mocks.home },
    })) };
});
vi.mock('@/lib/db', () => ({
  vps: { id: 'id' },
  db: { select: () => ({ from: () => ({ where: () => ({ all: () => [{
    id: 'login-test-vps', ip: '127.0.0.1', sshUser: 'test', sshPort: 22,
  }] }) }) }) },
}));
vi.mock('@/lib/server/hub/settings', () => ({ getSetting: () => null }));
vi.mock('@/lib/server/agent/accountProfiles', () => ({
  requireAccountProfile: vi.fn(),
  readProfileStatus: async () => ({ config_dir: mocks.profileDir }),
}));
vi.mock('@/lib/server/agent/claudeLoginCheck', () => ({
  readClaudeAuthStatus: async () => ({ ok: true, loggedIn: false, account: null }),
}));
vi.mock('@/lib/server/agent/sessionOps', () => ({ emitGlobalVpsStatus: vi.fn() }));

import { startLoginSession, stopLoginSession } from '@/lib/server/agent/loginSession';

afterEach(() => {
  rmSync(mocks.home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('Claude login code delivery', () => {
  it.each(['default', '559c4a092fc39884'])('keeps stdin open for profile %s after setsid forks', async (profile) => {
    mocks.home = mkdtempSync(path.join(tmpdir(), 'charon-login-test-'));
    mocks.profileDir = path.join(mocks.home, 'isolated');
    const bin = path.join(mocks.home, '.local/bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
printf 'If the browser did not open, visit: https://example.test/authorize\\nPaste code here if prompted > '
while IFS= read -r code; do
  printf 'Invalid code. Please make sure the full code was copied.\\n' >&2
done
`, { mode: 0o700 });

    const session = startLoginSession('login-test-vps', profile);
    try {
      await vi.waitFor(() => expect(session.status().phase).toBe('pending'));
      session.submitCode('invalid-test-code');
      await vi.waitFor(() => {
        expect(session.status().phase).toBe('pending');
        expect(session.status().error).toContain('Invalid code');
      });
    } finally {
      stopLoginSession('login-test-vps', profile);
    }
  });
});
