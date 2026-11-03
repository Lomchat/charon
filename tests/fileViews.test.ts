import { describe, expect, it } from 'vitest';
import {
  absUnderRoot, isMarkdownName, isSystemPath, markdownSlug, nextMountedFiles, resolveDocPath, rootedPath, wheelFactor,
} from '../app/fileViews';

// §14.111: rendered views of a file and the panes kept mounted across tabs.

describe('which file panes stay mounted', () => {
  const open = (...keys: string[]) => new Set(keys);
  const none = new Set<string>();

  it('keeps the newest ones, the shown one last', () => {
    let m: string[] = [];
    for (const k of ['a', 'b', 'c', 'd', 'e']) m = nextMountedFiles(m, k, open('a', 'b', 'c', 'd', 'e'), none, 4);
    expect(m).toEqual(['b', 'c', 'd', 'e']);
    expect(nextMountedFiles(m, 'c', open('a', 'b', 'c', 'd', 'e'), none, 4)).toEqual(['b', 'd', 'e', 'c']);
  });

  it('never evicts unsaved edits, even past the cap', () => {
    const all = open('a', 'b', 'c', 'd', 'e');
    expect(nextMountedFiles(['a', 'b', 'c', 'd'], 'e', all, new Set(['a']), 4)).toEqual(['a', 'c', 'd', 'e']);
    expect(nextMountedFiles(['a', 'b', 'c', 'd'], 'e', all, new Set(['a', 'b', 'c', 'd']), 4)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops a pane whose tab closed, and keeps the rest while nothing is shown', () => {
    expect(nextMountedFiles(['a', 'b', 'c'], null, open('a', 'c'), none, 4)).toEqual(['a', 'c']);
    expect(nextMountedFiles(['a', 'b'], 'b', open('a'), new Set(['b']), 4)).toEqual(['a']);
  });
});

describe('Markdown documents', () => {
  it('offers a View to Markdown files only', () => {
    expect(isMarkdownName('README.md')).toBe(true);
    expect(isMarkdownName('notes.MARKDOWN')).toBe(true);
    expect(isMarkdownName('page.mdx')).toBe(false);
    expect(isMarkdownName('md.txt')).toBe(false);
  });

  it('anchors headings the GitHub way, numbering repeats', () => {
    const seen = new Map<string, number>();
    expect(markdownSlug('Getting started!', seen)).toBe('getting-started');
    expect(markdownSlug('Étape 2 : déployer', seen)).toBe('étape-2--déployer');
    expect(markdownSlug('Getting started', seen)).toBe('getting-started-1');
    expect(markdownSlug('getting-started', seen)).toBe('getting-started-2');
  });

  it('resolves links and images from the document’s folder', () => {
    const dir = '/srv/app/docs';
    expect(resolveDocPath(dir, 'runbook.md')).toBe('/srv/app/docs/runbook.md');
    expect(resolveDocPath(dir, './img/a%20b.png')).toBe('/srv/app/docs/img/a b.png');
    expect(resolveDocPath(dir, '../README.md#setup')).toBe('/srv/app/README.md#setup');
    expect(resolveDocPath(dir, '/etc/hosts')).toBe('/etc/hosts');
    expect(resolveDocPath(dir, 'src/x.ts:12')).toBe('/srv/app/docs/src/x.ts:12');
    expect(resolveDocPath(dir, 'a.png?raw=1')).toBe('/srv/app/docs/a.png');
    for (const ref of ['https://x.org/a.png', 'mailto:a@b.c', '#intro', '//cdn.x/a.png', '', 'data:image/png;base64,AA', '%ZZ.md']) {
      expect(resolveDocPath(dir, ref), ref).toBeNull();
    }
  });

  it('roots a path in the tab when it can, in its own folder otherwise', () => {
    expect(rootedPath('/srv/app', '/srv/app/docs/a.png')).toEqual({ root: '/srv/app', path: 'docs/a.png' });
    expect(rootedPath('/srv/app/', '/srv/app/a.png')).toEqual({ root: '/srv/app/', path: 'a.png' });
    expect(rootedPath('/srv/app', '/srv/other/a.png')).toEqual({ root: '/srv/other', path: 'a.png' });
    expect(rootedPath('/srv/app', '/a.png')).toEqual({ root: '/', path: 'a.png' });
  });
});

describe('Ctrl+wheel zoom', () => {
  it('follows a trackpad pinch, but caps a mouse notch', () => {
    expect(wheelFactor({ deltaY: -4, deltaMode: 0 })).toBeCloseTo(Math.exp(0.032));
    expect(wheelFactor({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(Math.exp(0.48));
    expect(wheelFactor({ deltaY: 100, deltaMode: 0 })).toBeCloseTo(Math.exp(-0.48));
    expect(wheelFactor({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(Math.exp(0.384));
    expect(wheelFactor({ deltaY: -1, deltaMode: 2 })).toBeLessThan(1.7);
  });
});

describe('a tree path as an absolute one', () => {
  it('never doubles the slash of a root at /', () => {
    expect(absUnderRoot('/', 'etc/hosts')).toBe('/etc/hosts');
    expect(absUnderRoot('/srv/app', 'src/a.ts')).toBe('/srv/app/src/a.ts');
    expect(absUnderRoot('/srv/app/', 'src/a.ts')).toBe('/srv/app/src/a.ts');
  });
});

describe('what counts as a system path', () => {
  it('is everything outside the sites, in an explorer rooted at /', () => {
    expect(isSystemPath('/', 'etc/hosts')).toBe(true);
    expect(isSystemPath('/', 'var/www')).toBe(true);
    expect(isSystemPath('/', 'var/www/dev/a.ts')).toBe(false);
  });
  it('never applies to an explorer rooted at a project', () => {
    expect(isSystemPath('/opt/charon', 'app/a.ts')).toBe(false);
  });
});
