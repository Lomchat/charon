import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import HeaderContextGauge from '../app/HeaderContextGauge';

describe('HeaderContextGauge', () => {
  it('renders percentage, token figures, progress and compact together', () => {
    const html = renderToStaticMarkup(createElement(HeaderContextGauge, {
      context: { ok: true, percentage: 83.54, total_tokens: 215_338, max_tokens: 258_000 },
      onCompact: () => {},
      compacting: false,
      compactDisabled: false,
    }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="84"');
    expect(html).toContain('84%');
    expect(html).toContain('215k / 258k');
    expect(html).toContain('>compact</button>');
  });

  it('stays absent when the provider has no complete context measurement', () => {
    const html = renderToStaticMarkup(createElement(HeaderContextGauge, {
      context: { ok: true },
      onCompact: () => {},
      compacting: false,
      compactDisabled: false,
    }));
    expect(html).toBe('');
  });

  it('keeps the compact action visible but disabled while a turn is running', () => {
    const html = renderToStaticMarkup(createElement(HeaderContextGauge, {
      context: { ok: true, percentage: 50, total_tokens: 100_000, max_tokens: 200_000 },
      onCompact: () => {},
      compacting: false,
      compactDisabled: true,
    }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('The session must be running and idle to compact');
  });
});
