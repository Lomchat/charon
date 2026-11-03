import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkifiedText, MessageLink, MessageMarkdown } from '@/app/Message';
import { findTextLinks, findTextPaths, findTextUrls, messageFileTarget, remarkFilePaths, wholeTextPath, wholeTextUrl } from '@/app/messageLinks';
import { openTab } from '@/app/tabStore';
import { revealLine, revealView } from '@/app/revealLine';

vi.mock('@/app/tabStore', () => ({ openTab: vi.fn() }));
vi.mock('@/app/revealLine', () => ({ revealLine: vi.fn(), revealView: vi.fn() }));

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
    // A line is a place in the SOURCE: no rendered view asked for.
    expect(revealView).not.toHaveBeenCalled();
  });

  it('a bare file link asks for the rendered view (HTML live, Markdown read)', () => {
    const link = MessageLink({ href: '/srv/project/docs/page.html', vpsId: 'vps', cwd: '/srv/project' });
    link.props.onClick({ preventDefault: vi.fn() });
    expect(revealView).toHaveBeenCalledWith('vps', '/srv/project', 'docs/page.html', 'rendered');
    expect(revealLine).not.toHaveBeenCalled();
    expect(openTab).toHaveBeenCalledWith({ vpsId: 'vps', path: '/srv/project', kind: 'file', ref: 'docs/page.html', pin: false });
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

describe('file paths written as plain text', () => {
  const paths = (text: string) => findTextPaths(text).map((h) => h.href);

  it('finds the path in a sentence, without the sentence’s full stop', () => {
    const text = 'Le doc est prêt : /srv/charon/docs/usage-gauges-proposals.html. C\'est un seul fichier.';
    const [hit] = findTextPaths(text);
    expect(hit.href).toBe('/srv/charon/docs/usage-gauges-proposals.html');
    expect(text.slice(hit.start, hit.end)).toBe(hit.href);
  });

  it('knows home, relative, cited and Next-style paths', () => {
    expect(paths('see ~/notes/todo.md and ./scripts/run.sh')).toEqual(['~/notes/todo.md', './scripts/run.sh']);
    expect(paths('fixed in app/Message.tsx:251, then ../lib/api.ts:12:3.')).toEqual(['app/Message.tsx:251', '../lib/api.ts:12:3']);
    expect(paths('route app/api/vps/[id]/fs/preview/route.ts and app/api/preview/[token]/[[...path]]/route.ts'))
      .toEqual(['app/api/vps/[id]/fs/preview/route.ts', 'app/api/preview/[token]/[[...path]]/route.ts']);
    expect(paths('(docs/été/résumé.md)')).toEqual(['docs/été/résumé.md']);
    expect(paths('/srv/app/Dockerfile, /srv/app/.env')).toEqual(['/srv/app/Dockerfile', '/srv/app/.env']);
  });

  it('leaves words, ratios, routes and URLs alone', () => {
    for (const text of [
      'Next.js and Node.js', 'TCP/IP', 'read and/or write', 'about 1/2.5 of it', 'at 30 km/h',
      'the /v1/models endpoint', 'GET /api/claude/sessions', 'on 2026/10/22', '/README.md',
      'https://example.org/docs/a.html', 'github.com/org/repo/blob/x.md', 'a/b',
    ]) expect(paths(text), text).toEqual([]);
  });

  it('accepts a code span only when it is one whole path', () => {
    expect(wholeTextPath(' docs/readme.md ')).toBe('docs/readme.md');
    expect(wholeTextPath('cat docs/readme.md')).toBeNull();
    expect(wholeTextPath('README.md')).toBeNull();
  });

  it('links bare and code paths in an answer, never inside code blocks or links', () => {
    const html = renderToStaticMarkup(createElement(MessageMarkdown, {
      content: [
        'Le doc est prêt : /srv/charon/docs/x.html. Fin.',
        'Voir `app/Message.tsx:251` et [ici /srv/z.md](/srv/other/y.md).',
      ].join('\n\n'),
      vpsId: 'vps', cwd: '/srv/charon',
    }));
    expect(html).toContain('<a title="Open /srv/charon/docs/x.html in the explorer" class="file-path-link" href="/srv/charon/docs/x.html">/srv/charon/docs/x.html</a>. Fin.');
    expect(html).toContain('<a title="Open /srv/charon/app/Message.tsx:251 in the explorer" class="file-path-link" href="app/Message.tsx:251"><code>app/Message.tsx:251</code></a>');
    expect(html).toContain('<a title="Open /srv/other/y.md in the explorer" href="/srv/other/y.md">ici /srv/z.md</a>');
    expect(html.match(/file-path-link/g)).toHaveLength(2);
    expect(html).not.toContain('target=');

    // Code blocks are code: the tree walk never enters them.
    const tree = { type: 'root', children: [
      { type: 'code', value: 'cat /srv/charon/docs/x.html' },
      { type: 'paragraph', children: [{ type: 'text', value: 'open /srv/charon/docs/x.html' }] },
    ] };
    remarkFilePaths({ accept: () => true })(tree);
    expect(tree.children[0]).toEqual({ type: 'code', value: 'cat /srv/charon/docs/x.html' });
    expect(JSON.stringify(tree.children[1])).toContain('"type":"link"');
  });

  it('links a code span that is one whole web URL, with or without a VPS', () => {
    const content = '- Charon : `https://95-133-254-146.sslip.io`\n- Modèle : `glm53-flash-local`, voir `curl https://x.example/a`';
    for (const props of [{ content }, { content, vpsId: 'vps', cwd: '/srv/charon' }]) {
      const html = renderToStaticMarkup(createElement(MessageMarkdown, props));
      expect(html).toContain('<a href="https://95-133-254-146.sslip.io" target="_blank" rel="noopener noreferrer"><code>https://95-133-254-146.sslip.io</code></a>');
      expect(html.match(/<a /g)).toHaveLength(1);
    }
    expect(wholeTextUrl(' https://x.example/a ')).toBe('https://x.example/a');
    expect(wholeTextUrl('javascript:alert(1)')).toBeNull();
    expect(wholeTextUrl('see https://x.example/a')).toBeNull();
  });

  it('links nothing without a VPS to open it on', () => {
    const html = renderToStaticMarkup(createElement(MessageMarkdown, { content: 'see /srv/charon/docs/x.html' }));
    expect(html).not.toContain('<a');
  });

  it('links paths in plain-text bubbles and opens them like the explorer', () => {
    const html = renderToStaticMarkup(createElement(LinkifiedText, {
      text: 'ouvre /srv/charon/docs/x.html stp', vpsId: 'vps', cwd: '/srv/charon',
    }));
    expect(html).toBe('ouvre <a title="Open /srv/charon/docs/x.html in the explorer" class="file-path-link" href="/srv/charon/docs/x.html">/srv/charon/docs/x.html</a> stp');
    expect(renderToStaticMarkup(createElement(LinkifiedText, { text: 'ouvre /srv/x/y.html' }))).toBe('ouvre /srv/x/y.html');
    const link = MessageLink({ href: '/srv/charon/docs/x.html', vpsId: 'vps', cwd: '/srv/charon' });
    link.props.onClick({ preventDefault: vi.fn() });
    expect(openTab).toHaveBeenCalledWith({ vpsId: 'vps', path: '/srv/charon', kind: 'file', ref: 'docs/x.html', pin: false });
  });
});

describe('web URLs written as plain text', () => {
  const urls = (text: string) => findTextUrls(text).map((h) => h.href);

  it('finds http(s) URLs without the prose around them', () => {
    const text = 'Lequel : ce nouvel essai https://immersio.example.app/api/files/TEST-HL-0035.png ou OR-0023 https://x.example/TEST-OR-0023.png ? Fin.';
    expect(urls(text)).toEqual(['https://immersio.example.app/api/files/TEST-HL-0035.png', 'https://x.example/TEST-OR-0023.png']);
    const [hit] = findTextUrls(text);
    expect(text.slice(hit.start, hit.end)).toBe(hit.href);
    expect(urls('voir https://a.example/x. Puis (https://b.example/y), et « https://c.example/z »!'))
      .toEqual(['https://a.example/x', 'https://b.example/y', 'https://c.example/z']);
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar).')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(urls('http://127.0.0.1:10556/?session=abc&x=1')).toEqual(['http://127.0.0.1:10556/?session=abc&x=1']);
  });

  it('never links another scheme, a hostless URL or a glued word', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,x', 'https://', 'https://.', 'xhttps://a.example/b', 'ftp://a.example/b'])
      expect(urls(text), text).toEqual([]);
  });

  it('lets a URL win over a path inside it', () => {
    const hits = findTextLinks('see https://a.example/x,/srv/charon/docs/x.html and /srv/charon/docs/y.html', () => true);
    expect(hits.map((h) => [h.kind, h.href])).toEqual([
      ['url', 'https://a.example/x,/srv/charon/docs/x.html'], ['path', '/srv/charon/docs/y.html'],
    ]);
  });

  it('links URLs in plain-text bubbles, with or without a VPS, in a new tab', () => {
    expect(renderToStaticMarkup(createElement(LinkifiedText, { text: 'look https://a.example/x.png ?' })))
      .toBe('look <a href="https://a.example/x.png" target="_blank" rel="noopener noreferrer">https://a.example/x.png</a> ?');
    const html = renderToStaticMarkup(createElement(LinkifiedText, {
      text: 'https://a.example/x and /srv/charon/docs/x.html', vpsId: 'vps', cwd: '/srv/charon',
    }));
    expect(html).toContain('<a href="https://a.example/x" target="_blank"');
    expect(html).toContain('class="file-path-link" href="/srv/charon/docs/x.html"');
  });
});
