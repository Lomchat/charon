import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hydrateTabs, useTabs } from '@/app/tabStore';
import type { TabDTO } from '@/lib/types/api';

const tab = (id: string, active = true): TabDTO => ({
  id, active, vpsId: 'vps', path: '/project', kind: 'session', ref: id,
  pinned: true, position: 0, vpsPos: 0, groupPos: 0,
});

function Workspace({ tabs }: { tabs: TabDTO[] }) {
  hydrateTabs(tabs);
  const snapshot = useTabs(tabs);
  return createElement('main', null, snapshot.tabs.find((t) => t.active)?.ref ?? 'empty');
}

describe('workspace server snapshots', () => {
  it('renders each request from its own tabs, including after an empty first request', () => {
    expect(renderToString(createElement(Workspace, { tabs: [] }))).toContain('empty');
    expect(renderToString(createElement(Workspace, { tabs: [tab('first')] }))).toContain('first');
    expect(renderToString(createElement(Workspace, { tabs: [tab('second')] }))).toContain('second');
  });

  it('preserves an explicitly empty focus instead of activating the first shared tab', () => {
    expect(renderToString(createElement(Workspace, { tabs: [tab('inactive', false)] }))).toBe('<main>empty</main>');
  });
});
