import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccountUsage } from '@/lib/server/hub/types';
import { UsageRings } from '@/app/UsageMeter';

// Classic JSX transform: components read the global React.
(globalThis as { React?: typeof React }).React = React;

// The gauges follow the reading: a window a complete reading leaves out has
// no gauge (Codex has no 5-hour window today), and comes back with the first
// reading that carries it. Partial or missing readings hide nothing.
const week = { utilization: 33, resetsAt: '2099-01-01T00:00:00.000Z' };
const five = { utilization: 12, resetsAt: '2099-01-01T00:00:00.000Z' };
const labels = (usage: AccountUsage | null): string[] =>
  [...renderToStaticMarkup(createElement(UsageRings, { usage, kind: 'codex', accountLabel: 'Codex' }))
    .matchAll(/<text class="ur-label"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

describe('usage gauges follow the windows a reading carries', () => {
  it('a complete reading without a 5-hour window shows the week only', () => {
    expect(labels({ ok: true, provider: 'codex', fetchedAt: 1, fiveHour: null, sevenDay: week } as AccountUsage))
      .toEqual(['7d']);
  });
  it('the 5-hour gauge comes back with the reading that carries it', () => {
    expect(labels({ ok: true, provider: 'codex', fetchedAt: 1, fiveHour: five, sevenDay: week } as AccountUsage))
      .toEqual(['5h', '7d']);
  });
  it('a windows-only snapshot (live events before any poll) hides nothing', () => {
    expect(labels({ ok: true, fetchedAt: 0, fiveHour: null, sevenDay: week } as AccountUsage))
      .toEqual(['5h', '7d']);
  });
  it('no reading keeps both placeholders', () => {
    expect(labels(null)).toEqual(['5h', '7d']);
  });
});
