import { describe, expect, it } from 'vitest';
import { isCodeLike, splitTipLabel, tipAttrs, tipFromAttrs, tipFromTitle } from '@/app/tooltipText';

describe('tipFromTitle', () => {
  it('ignores an empty title', () => {
    expect(tipFromTitle('')).toBeNull();
    expect(tipFromTitle('   ')).toBeNull();
    expect(tipFromTitle(undefined)).toBeNull();
  });

  it('turns a short phrase into a headline, sentence-cased', () => {
    expect(tipFromTitle('scan existing sessions to import')).toEqual({
      title: 'Scan existing sessions to import', detail: undefined, lines: undefined, keys: undefined,
    });
    // Not prose: left as written.
    expect(tipFromTitle('Fork conversation')?.title).toBe('Fork conversation');
  });

  it('lifts a trailing shortcut into keys', () => {
    expect(tipFromTitle('save to the VPS (Ctrl+S)')).toMatchObject({ title: 'Save to the VPS', keys: ['Ctrl', 'S'] });
    expect(tipFromTitle('previous change (Alt+↑)')).toMatchObject({ title: 'Previous change', keys: ['Alt', '↑'] });
    expect(tipFromTitle('close (Esc)')).toMatchObject({ title: 'Close', keys: ['Esc'] });
    // A parenthesis that is not a shortcut stays in the text.
    expect(tipFromTitle('open in a new tab (image/png)')?.keys).toBeUndefined();
  });

  it('splits "headline — detail"', () => {
    expect(tipFromTitle('history unavailable — install the agent first')).toMatchObject({
      title: 'History unavailable', detail: 'Install the agent first',
    });
  });

  it('keeps lines as rows', () => {
    expect(tipFromTitle('3 files\n/srv/a.ts\n/srv/b.ts')).toMatchObject({
      title: '3 files', lines: ['/srv/a.ts', '/srv/b.ts'],
    });
  });

  it('puts each " · " fact on its own row, never dots', () => {
    expect(tipFromTitle('2 working · 1 waiting on you · 12 sessions')).toMatchObject({
      title: '2 working', lines: ['1 waiting on you', '12 sessions'],
    });
    // The facts of a detail: rows under the headline, not a dotted paragraph.
    expect(tipFromTitle('Account usage — Claude · Chalom · c@example.com')).toEqual({
      title: 'Account usage', detail: undefined, lines: ['Claude', 'Chalom', 'c@example.com'], keys: undefined,
    });
    // Mixed: reading order kept.
    expect(tipFromTitle('agent down · last OK contact 3m ago — auto-retries\nerror: x · y')?.lines)
      .toEqual(['last OK contact 3m ago', 'auto-retries', 'error: x', 'y']);
    // One explanation stays the muted paragraph.
    expect(tipFromTitle('history unavailable — install the agent first')?.lines).toBeUndefined();
    // A middle dot without its spaces is not a separator.
    expect(tipFromTitle('a·b')).toEqual({ title: 'a·b', detail: undefined, lines: undefined, keys: undefined });
  });

  it('shows a bare value as itself, in monospace', () => {
    expect(tipFromTitle('/srv/checkout-service/src')).toEqual({ detail: '/srv/checkout-service/src', mono: true });
    expect(tipFromTitle('claude-opus-4-8')).toEqual({ detail: 'claude-opus-4-8', mono: true });
    expect(tipFromTitle('menu')?.title).toBe('Menu');
  });

  it('reads a long sentence as body text', () => {
    const long = 'show or hide tool calls, tool results, plans and reasoning in conversations';
    expect(tipFromTitle(long)).toEqual({ detail: 'Show or hide tool calls, tool results, plans and reasoning in conversations' });
  });
});

describe('isCodeLike', () => {
  it('tells values from words', () => {
    expect(isCodeLike('https://example.com/x')).toBe(true);
    expect(isCodeLike('v0.107.0')).toBe(true);
    expect(isCodeLike('copy')).toBe(false);
    expect(isCodeLike('copy the url')).toBe(false);
  });
});

describe('object tooltips', () => {
  it('round-trips name, facts, excerpt and gestures through the attributes', () => {
    const attrs = tipAttrs({
      detail: ['src/middleware/', null, 'modified · git-ignored', false],
      quote: 'Refactor the auth middleware',
      actions: [['Click', 'preview'], false, ['Double-click', 'keep it open']],
    });
    expect(attrs['data-tip-detail']).toBe('src/middleware/\nmodified · git-ignored');
    expect(tipFromAttrs('auth.ts', attrs['data-tip-detail'], attrs['data-tip-quote'], attrs['data-tip-actions'])).toEqual({
      title: 'auth.ts',
      lines: ['src/middleware/', 'modified', 'git-ignored'],
      quote: 'Refactor the auth middleware',
      actions: [['Click', 'preview'], ['Double-click', 'keep it open']],
    });
  });

  it('keeps the name as written (a file name is not a value to monospace)', () => {
    expect(tipFromAttrs('auth.ts', '', undefined, undefined)?.title).toBe('auth.ts');
    // Even with a dot in it: a name is not a list of facts.
    expect(tipFromAttrs('shell · app', 'SSH shell · ended', undefined, undefined)).toMatchObject({
      title: 'shell · app', lines: ['SSH shell', 'ended'],
    });
  });

  it('marks the element as an object even with no facts', () => {
    expect(tipAttrs({})['data-tip-detail']).toBe('');
  });

  it('survives a malformed gesture list', () => {
    expect(tipFromAttrs('x', '', undefined, '{oops')?.actions).toBeUndefined();
    expect(tipFromAttrs('x', '', undefined, '[["Click"],["Drag", 3],["Click","open"]]')?.actions).toEqual([['Click', 'open']]);
  });
});

describe('labelled rows', () => {
  it('opts in through tipAttrs and splits "Label: value" rows only', () => {
    const attrs = tipAttrs({ detail: ['Output: 900 tokens'], labels: true });
    expect(attrs['data-tip-labels']).toBe('');
    expect(tipAttrs({ detail: ['a'] })['data-tip-labels']).toBeUndefined();
    expect(tipFromAttrs('Turn', attrs['data-tip-detail'], undefined, undefined, true)?.labeled).toBe(true);
    expect(tipFromAttrs('Turn', attrs['data-tip-detail'], undefined, undefined)?.labeled).toBeUndefined();
    expect(splitTipLabel('Input cost: 43% of full price')).toEqual(['Input cost', '43% of full price']);
    expect(splitTipLabel('https://example.com/x')).toBeNull();
    expect(splitTipLabel('no label here')).toBeNull();
  });
});

describe('status section', () => {
  it('rides as JSON and comes back under the excerpt, refusing garbage', () => {
    const attrs = tipAttrs({ section: { lines: ['Prompt cache cold since 09:37', '640k tokens'], color: 'var(--info)', icon: 'snow' } });
    const tip = tipFromAttrs('s', attrs['data-tip-detail'], 'first message', undefined, false, attrs['data-tip-section']);
    expect(tip?.section).toEqual({ lines: ['Prompt cache cold since 09:37', '640k tokens'], color: 'var(--info)', icon: 'snow' });
    expect(tipAttrs({ section: null })['data-tip-section']).toBeUndefined();
    expect(tipFromAttrs('s', '', undefined, undefined, false, '{oops')?.section).toBeUndefined();
    expect(tipFromAttrs('s', '', undefined, undefined, false, '{"lines":[]}')?.section).toBeUndefined();
  });
});

