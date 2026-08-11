import { describe, it, expect } from 'vitest';
import { buildGitDecorations } from '../app/gitStore';
import type { GitFileEntry, GitStatusResponse, GitWorkspaceResponse } from '../lib/types/api';

// Git speaks in paths relative to the REPO ROOT; the explorer tree is rooted at
// the SESSION CWD, and the two differ whenever a session was started in a
// subdirectory. This function is the rebase between them, plus the fold that
// gives a collapsed folder the colour of the most significant thing inside it.

function f(path: string, status: string): GitFileEntry {
  return {
    path, status, x: status, y: status, origPath: null,
    untracked: status === '?', added: null, deleted: null,
  };
}
function repo(root: string, files: GitFileEntry[]): GitStatusResponse {
  return { ok: true, isRepo: true, root, files };
}
/** One checkout — the common case, and every pre-0.29.0 test below. */
function st(root: string, files: GitFileEntry[]): GitWorkspaceResponse {
  return { ok: true, mode: 'single', repos: [repo(root, files)] };
}
/** A folder OF projects: several disjoint checkouts under one cwd (§14.82). */
function ws(...repos: GitStatusResponse[]): GitWorkspaceResponse {
  return { ok: true, mode: 'multi', repos };
}

describe('buildGitDecorations', () => {
  it('decorates files and folds the status up onto their folders', () => {
    const d = buildGitDecorations(st('/srv/app', [f('src/api/user.ts', 'M')]), '/srv/app');
    expect(d.get('src/api/user.ts')).toBe('M');
    expect(d.get('src/api')).toBe('M');
    expect(d.get('src')).toBe('M');
    expect(d.get('')).toBeUndefined();     // the root itself is never decorated
  });

  it('a folder takes the status of its child — including A', () => {
    const d = buildGitDecorations(st('/r', [f('lib/new.ts', 'A')]), '/r');
    expect(d.get('lib/new.ts')).toBe('A');
    expect(d.get('lib')).toBe('A');
  });

  it('a folder with several statuses shows the most significant one', () => {
    // A conflict outranks everything; a tracked modification outranks a new file.
    const conflict = buildGitDecorations(
      st('/r', [f('a/x.ts', 'A'), f('a/y.ts', 'U'), f('a/z.ts', 'M')]), '/r');
    expect(conflict.get('a')).toBe('U');
    const modified = buildGitDecorations(st('/r', [f('b/x.ts', 'A'), f('b/y.ts', 'M')]), '/r');
    expect(modified.get('b')).toBe('M');
    // …but each file keeps its own letter.
    expect(modified.get('b/x.ts')).toBe('A');
  });

  it('an untracked-only folder stays untracked, not modified', () => {
    const d = buildGitDecorations(st('/r', [f('drafts/a.md', '?'), f('drafts/b.md', '?')]), '/r');
    expect(d.get('drafts')).toBe('?');
  });

  it('rebases repo-root paths onto a cwd deeper in the repo', () => {
    // Session started in /srv/app/src; git reports src/api/user.ts.
    const d = buildGitDecorations(st('/srv/app', [f('src/api/user.ts', 'M')]), '/srv/app/src');
    expect(d.get('api/user.ts')).toBe('M');
    expect(d.get('api')).toBe('M');
    expect(d.get('src/api/user.ts')).toBeUndefined();
  });

  it('drops changes that live outside the cwd', () => {
    // They are real changes in the repo, but they are not in THIS tree, and
    // decorating a path the tree will never render is just wasted memory.
    const d = buildGitDecorations(
      st('/srv/app', [f('docs/readme.md', 'M'), f('src/a.ts', 'M')]), '/srv/app/src');
    expect(d.get('a.ts')).toBe('M');
    expect([...d.keys()]).toEqual(['a.ts']);
  });

  it('is empty when there is no repo, no root, or no cwd', () => {
    expect(buildGitDecorations(null, '/r').size).toBe(0);
    expect(buildGitDecorations(st('/r', [f('a', 'M')]), null).size).toBe(0);
    expect(buildGitDecorations({ ok: true, mode: 'none', repos: [] }, '/r').size).toBe(0);
    expect(buildGitDecorations(ws({ ok: false, isRepo: false, files: [f('a', 'M')] }), '/r').size).toBe(0);
    expect(buildGitDecorations({ ok: false, mode: 'none', repos: [] }, '/r').size).toBe(0);
  });

  it('tolerates a trailing slash on either path', () => {
    const d = buildGitDecorations(st('/srv/app/', [f('src/a.ts', 'M')]), '/srv/app/');
    expect(d.get('src/a.ts')).toBe('M');
  });

  it('merges every checkout of a folder of projects', () => {
    // The cwd is not a repo at all — the decorations come from the repos
    // BELOW it, each rebased onto its own subtree (§14.82).
    const d = buildGitDecorations(ws(
      repo('/srv/alpha', [f('src/a.ts', 'M')]),
      repo('/srv/nest/beta', [f('README.md', '?')]),
    ), '/srv');
    expect(d.get('alpha/src/a.ts')).toBe('M');
    expect(d.get('alpha/src')).toBe('M');
    expect(d.get('alpha')).toBe('M');
    expect(d.get('nest/beta/README.md')).toBe('?');
    expect(d.get('nest/beta')).toBe('?');
    expect(d.get('nest')).toBe('?');
  });

  it('one broken checkout does not blank the others', () => {
    // A repo with dubious ownership among ten must cost its own section, not
    // the whole tree's colours.
    const d = buildGitDecorations(ws(
      { ok: false, isRepo: false, reason: 'ownership', root: '/srv/bad', files: [] },
      repo('/srv/good', [f('x.ts', 'M')]),
    ), '/srv');
    expect(d.get('good/x.ts')).toBe('M');
    expect(d.get('good')).toBe('M');
  });

  it('does not treat a sibling directory as a prefix match', () => {
    // /srv/app-old must not be read as being inside /srv/app.
    const d = buildGitDecorations(st('/srv/app-old', [f('a.ts', 'M')]), '/srv/app');
    expect(d.size).toBe(0);
  });
});
