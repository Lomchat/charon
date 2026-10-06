import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageLink, MessageMarkdown } from '@/app/Message';
import { messageFileTarget } from '@/app/messageLinks';
import { openTab } from '@/app/tabStore';
import { revealLine } from '@/app/revealLine';

vi.mock('@/app/tabStore', () => ({ openTab: vi.fn() }));
vi.mock('@/app/revealLine', () => ({ revealLine: vi.fn() }));

const target = (href: string, cwd: string | null = '/srv/project') => messageFileTarget(href, 'remote-vps', cwd);

describe('transcript file links', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the reported file on the session VPS, even outside the cwd', () => {
    expect(target('/srv/immersio/.codex-inspect/hammerhead-alternatives-20261006/prompt-b.txt'))
      .toMatchObject({ vpsId: 'remote-vps', root: '/srv/immersio/.codex-inspect/hammerhead-alternatives-20261006', path: 'prompt-b.txt' });
  });

  it('reuses the explorer tab identity for relative and absolute workspace files', () => {
    for (const href of ['./docs/readme.md', 'docs/readme.md', '/srv/project/docs/readme.md', 'file:///srv/project/docs/readme.md']) {
      expect(target(href)).toMatchObject({ root: '/srv/project', path: 'docs/readme.md' });
    }
    expect(target('README.md')).toMatchObject({ root: '/srv/project', path: 'README.md' });
    expect(target('../notes/test.txt')).toMatchObject({ root: '/srv/notes', path: 'test.txt' });
    expect(target('~/notes.txt', null)).toMatchObject({ root: '~', path: 'notes.txt' });
    expect(target('/srv/project-sibling/note.txt')).toMatchObject({ root: '/srv/project-sibling', path: 'note.txt' });
    expect(target('./docs/../readme.md')).toMatchObject({ root: '/srv/project', path: 'readme.md' });
  });

  it('preserves encoded filename characters and extracts citation lines', () => {
    expect(target('/srv/notes/a%20b%23c%3Fd.txt:12:3'))
      .toMatchObject({ root: '/srv/notes', path: 'a b#c?d.txt', line: 12 });
    expect(target('/srv/notes/readme.md#L12')).toMatchObject({ root: '/srv/notes', path: 'readme.md', line: 12 });
  });

  it('leaves web, hub and anchor links alone and rejects malformed paths', () => {
    for (const href of [
      'https://example.org/test.txt', '//example.org/test.txt', 'mailto:a@example.org',
      '#section', '/api/vps/v/fs/file?root=x&path=y', '/login', '/desk', '/',
      'file://other-server/srv/test.txt', '/srv/%ZZ.txt', '/srv/%00bad.txt',
      '/srv/notes/', './..', 'guide',
    ]) expect(target(href), href).toBeNull();
    expect(messageFileTarget('/srv/file.txt')).toBeNull();
    expect(messageFileTarget('./file.txt', 'vps')).toBeNull();
  });

  it('renders a file link without a browser-tab target or a leaked markdown node', () => {
    const html = renderToStaticMarkup(createElement(MessageMarkdown, {
      content: '[Prompt testé](/srv/immersio/prompt-b.txt)', vpsId: 'session-vps', cwd: '/srv/other',
    }));
    expect(html).toContain('href="/srv/immersio/prompt-b.txt"');
    expect(html).not.toContain('target=');
    expect(html).not.toContain('node=');
    expect(html).toContain('Prompt testé');
  });

  it('intercepts a click and opens the same file preview as the explorer', () => {
    const link = MessageLink({ href: '/srv/project/docs/readme.md:12', vpsId: 'vps', cwd: '/srv/project' });
    const preventDefault = vi.fn();
    link.props.onClick({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openTab).toHaveBeenCalledWith({ vpsId: 'vps', path: '/srv/project', kind: 'file', ref: 'docs/readme.md', pin: false });
    expect(revealLine).toHaveBeenCalledWith('vps', '/srv/project', 'docs/readme.md', 12);
  });

  it('keeps web links in browser tabs and preserves markdown URL sanitization', () => {
    const html = renderToStaticMarkup(createElement(MessageMarkdown, {
      content: '[web](https://example.org) [bad](javascript:alert%281%29) [file](file:///srv/note.txt) ![image](/srv/image.png)',
      vpsId: 'vps', cwd: '/srv/project',
    }));
    expect(html).toContain('href="https://example.org" target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="file:///srv/note.txt"');
    expect(html).toContain('src="/srv/image.png"');
    const link = MessageLink({ href: 'https://example.org', vpsId: 'vps', cwd: '/srv/project' });
    expect(link.props.onClick).toBeUndefined();
    expect(openTab).not.toHaveBeenCalled();
  });
});
