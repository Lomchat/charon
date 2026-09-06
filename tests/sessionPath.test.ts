import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/claude/settings', () => ({ getSetting: () => null }));
import { sessionPathScript } from '@/lib/server/claude/sessionPath';

const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'charon-path-test-')); dirs.push(dir); return dir; }
function run(path: string, create: boolean, cwd?: string) {
  return spawnSync('/bin/sh', ['-c', sessionPathScript(path, create)], { cwd, encoding: 'utf8' });
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('session directory preparation', () => {
  it('previews without writes and creates only the missing leaf', () => {
    const root = fixture();
    const target = join(root, 'c');
    expect(run(target, false).status).toBe(2);
    expect(existsSync(target)).toBe(false);
    expect(run(target + '///', true).status).toBe(0);
    expect(run(target, true).status).toBe(0);
  });
  it('rejects multiple missing levels without creating any of them', () => {
    const root = fixture();
    for (const create of [false, true]) expect(run(join(root, 'b/c'), create).status).toBe(3);
    expect(existsSync(join(root, 'b'))).toBe(false);
    expect(run(root + '/b/../c', true).status).toBe(3);
  });
  it('rejects files and dangling symlinks', () => {
    const root = fixture();
    writeFileSync(join(root, 'file'), 'preserve');
    symlinkSync(join(root, 'absent'), join(root, 'link'));
    for (const name of ['file', 'link']) expect(run(join(root, name), true).status).toBe(4);
  });
  it('handles relative paths, symlinked parents and shell metacharacters literally', () => {
    const root = fixture();
    mkdirSync(join(root, 'parent'));
    symlinkSync(join(root, 'parent'), join(root, 'alias'));
    const name = "spaces ' $(touch INJECTED) `touch INJECTED`";
    expect(run('alias/' + name, true, root).status).toBe(0);
    expect(existsSync(join(root, 'parent', name))).toBe(true);
    expect(existsSync(join(root, 'INJECTED'))).toBe(false);
  });
});
