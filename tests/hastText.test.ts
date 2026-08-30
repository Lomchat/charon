import { describe, it, expect } from 'vitest';
import { hastText } from '../app/hastText';

// What the per-code-block copy button puts on the clipboard (§ Message §
// CodeBlock). The shapes below are what react-markdown + rehype-highlight
// actually hand a custom `pre` component.
describe('hastText', () => {
  // A HIGHLIGHTED block: the source is split across nested hljs spans, and
  // the whole point is that copying yields the source, not the markup.
  it('concatenates the text leaves of a highlighted block, in order', () => {
    const node = {
      type: 'element',
      tagName: 'pre',
      children: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['hljs', 'language-js'] },
          children: [
            { type: 'element', tagName: 'span', properties: { className: ['hljs-keyword'] }, children: [{ type: 'text', value: 'const' }] },
            { type: 'text', value: ' x = ' },
            { type: 'element', tagName: 'span', properties: { className: ['hljs-number'] }, children: [{ type: 'text', value: '1' }] },
            { type: 'text', value: ';\n' },
          ],
        },
      ],
    };
    expect(hastText(node)).toBe('const x = 1;\n');
  });

  // An UNhighlighted fence (no language, `ignoreMissing`) is a single leaf —
  // newlines and indentation must survive verbatim, or the paste is wrong.
  it('preserves newlines and indentation of a plain fence', () => {
    const node = {
      type: 'element',
      tagName: 'pre',
      children: [{ type: 'element', tagName: 'code', children: [{ type: 'text', value: 'a\n  b\n\nc\n' }] }],
    };
    expect(hastText(node)).toBe('a\n  b\n\nc\n');
  });

  // The button is only rendered when this returns something, so a missing or
  // malformed node must be empty, never a crash and never a partial copy.
  it('is empty for a missing, primitive or childless node', () => {
    expect(hastText(undefined)).toBe('');
    expect(hastText(null)).toBe('');
    expect(hastText('pre')).toBe('');
    expect(hastText({ type: 'element', tagName: 'pre' })).toBe('');
    expect(hastText({ type: 'text' })).toBe('');
  });
});
