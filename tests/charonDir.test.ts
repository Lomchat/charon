import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({}));

import { CHARON_DIRNAME, CHARON_FORK_DIR, CHARON_UPLOADS_DIR, charonDirCommand } from '@/lib/server/hub/charonDir';

// The real shell, run against real repos: `.charon/` is excluded only when the
// command itself created it, never when the user already had one.

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** Exit 0 = ignored, 1 = not (check-ignore's own verdict). */
function ignored(cwd: string, rel: string): boolean {
  try {
    git(cwd, 'check-ignore', '-q', rel);
    return true;
  } catch {
    return false;
  }
}

const made: string[] = [];
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charon-dir-'));
  made.push(dir);
  return dir;
}

function repo(gitignore?: string): string {
  const dir = tmp();
  git(dir, 'init', '-q');
  if (gitignore != null) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
  return dir;
}

function prepare(cwd: string, sub = CHARON_UPLOADS_DIR) {
  execFileSync('sh', ['-c', charonDirCommand(cwd, sub)]);
  fs.writeFileSync(path.join(cwd, sub, 'shot.png'), 'x');
}

const read = (p: string) => fs.readFileSync(p, 'utf8');
const exclude = (dir: string) => read(path.join(dir, '.git', 'info', 'exclude'));

describe('charonDirCommand', () => {
  it('a created folder joins the existing .gitignore, once', () => {
    const dir = repo('node_modules');
    prepare(dir);
    prepare(dir, CHARON_FORK_DIR);
    expect(read(path.join(dir, '.gitignore'))).toBe('node_modules\n.charon/\n');
    expect(ignored(dir, CHARON_DIRNAME)).toBe(true);
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('?? .gitignore\n');
  });

  it('an existing unignored folder is the user\'s: nothing is added', () => {
    const dir = repo('node_modules\n');
    fs.mkdirSync(path.join(dir, CHARON_DIRNAME));
    prepare(dir);
    expect(read(path.join(dir, '.gitignore'))).toBe('node_modules\n');
    expect(exclude(dir)).not.toContain(CHARON_DIRNAME);
    expect(ignored(dir, CHARON_DIRNAME)).toBe(false);
  });

  it('an already ignored folder leaves .gitignore untouched', () => {
    const dir = repo('.*\n');
    prepare(dir);
    expect(read(path.join(dir, '.gitignore'))).toBe('.*\n');
  });

  it('no .gitignore: the repo\'s info/exclude, no file created', () => {
    const dir = repo();
    prepare(dir);
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
    expect(exclude(dir).split('\n')).toContain('/.charon/');
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('a cwd below the toplevel uses its own .gitignore, else the toplevel one', () => {
    const top = repo('dist/\n');
    const own = path.join(top, 'pkg a');
    const bare = path.join(top, "it's");
    fs.mkdirSync(own);
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(own, '.gitignore'), '*.log\n');
    prepare(own);
    prepare(bare);
    expect(read(path.join(own, '.gitignore'))).toBe('*.log\n.charon/\n');
    expect(read(path.join(top, '.gitignore'))).toBe('dist/\n.charon/\n');
    expect(ignored(top, `pkg a/${CHARON_DIRNAME}`)).toBe(true);
    expect(ignored(top, `it's/${CHARON_DIRNAME}`)).toBe(true);
  });

  it('never fails outside a repo', () => {
    const dir = tmp();
    expect(() => prepare(dir)).not.toThrow();
    expect(fs.existsSync(path.join(dir, CHARON_UPLOADS_DIR, 'shot.png'))).toBe(true);
  });
});
