import { describe, expect, it } from 'vitest';
import { formatQuote, insertQuoteBlock, splitQuotedLines, QUOTABLE_SELECTOR } from '@/app/chatQuote';

describe('formatQuote', () => {
  it('prefixes every line', () => {
    expect(formatQuote('one\ntwo')).toBe('> one\n> two');
  });

  it('normalises line endings, trims edges and trailing spaces', () => {
    expect(formatQuote('\n\n  first  \r\nsecond\t\r\n\n')).toBe('>   first\n> second');
  });

  it('keeps one bare `>` per paragraph break', () => {
    expect(formatQuote('a\n\n\n\nb')).toBe('> a\n>\n> b');
  });

  it('turns non-breaking spaces into spaces', () => {
    expect(formatQuote('a b')).toBe('> a b');
  });

  it('is empty for whitespace only', () => {
    expect(formatQuote(' \n\t\n')).toBe('');
  });
});

describe('insertQuoteBlock', () => {
  it('into an empty composer: quote, blank line, caret', () => {
    const r = insertQuoteBlock('', 0, '> q');
    expect(r.next).toBe('> q\n\n');
    expect(r.caret).toBe(r.next.length);
  });

  it('after text: separated by a blank line', () => {
    const r = insertQuoteBlock('my answer', 9, '> q');
    expect(r.next).toBe('my answer\n\n> q\n\n');
    expect(r.caret).toBe(r.next.length);
  });

  it('after a line break: completes the blank line only', () => {
    expect(insertQuoteBlock('a\n', 2, '> q').next).toBe('a\n\n> q\n\n');
    expect(insertQuoteBlock('a\n\n', 3, '> q').next).toBe('a\n\n> q\n\n');
  });

  it('chains quotes point by point', () => {
    let cur = insertQuoteBlock('', 0, '> one');
    const typed = cur.next + 'yes';
    cur = insertQuoteBlock(typed, typed.length, '> two');
    expect(cur.next).toBe('> one\n\nyes\n\n> two\n\n');
  });

  it('mid-text: keeps what followed the caret below the answer line', () => {
    const r = insertQuoteBlock('before after', 6, '> q');
    expect(r.next).toBe('before\n\n> q\n\n\n\nafter');
    expect(r.next.slice(0, r.caret)).toBe('before\n\n> q\n\n');
  });

  it('clamps an out-of-range caret', () => {
    expect(insertQuoteBlock('x', 99, '> q').next).toBe('x\n\n> q\n\n');
  });
});

describe('splitQuotedLines', () => {
  it('quotes only lines that START with `> `', () => {
    expect(splitQuotedLines('hello\n> not at\nstart')).toEqual([
      { quote: false, text: 'hello' },
      { quote: true, text: 'not at' },
      { quote: false, text: 'start' },
    ]);
    expect(splitQuotedLines('a > b')).toEqual([{ quote: false, text: 'a > b' }]);
  });

  it('groups runs of quote lines and strips the marker', () => {
    expect(splitQuotedLines('> one\n>\n> two\n\nanswer')).toEqual([
      { quote: true, text: 'one\n\ntwo' },
      { quote: false, text: 'answer' },
    ]);
  });

  it('drops the line break on each side of a quote block', () => {
    expect(splitQuotedLines('intro\n\n> q\n\nreply')).toEqual([
      { quote: false, text: 'intro' },
      { quote: true, text: 'q' },
      { quote: false, text: 'reply' },
    ]);
  });

  it('round-trips a formatted quote', () => {
    const segs = splitQuotedLines(formatQuote('x\ny') + '\n\nreply');
    expect(segs[0]).toEqual({ quote: true, text: 'x\ny' });
    expect(segs[1].quote).toBe(false);
    expect(segs[1].text.trim()).toBe('reply');
  });

  it('does not treat `>>` or `>text` as a quote', () => {
    expect(splitQuotedLines('>>x\n>y').every((x) => !x.quote)).toBe(true);
  });
});

describe('QUOTABLE_SELECTOR', () => {
  it('targets final assistant answers and thinking only', () => {
    expect(QUOTABLE_SELECTOR).toContain('.bubble.role-assistant:not(.streaming) > .content');
    expect(QUOTABLE_SELECTOR).toContain('.bubble.thinking');
    expect(QUOTABLE_SELECTOR).not.toContain('role-user');
  });
});
