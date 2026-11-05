import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '@/lib/types/api';
import type { AccountProfile } from '@/lib/accountProfiles';
import type { AccountUsage } from '@/lib/server/hub/types';
import { PROVIDERS } from '@/lib/sessionCapabilities';
import { buildAccountGroups } from '@/lib/accountGroups';
import AccountNav, { AccountNavItem } from '@/app/AccountNav';
import { UsageRings } from '@/app/UsageMeter';

// Classic JSX transform: components read the global React.
(globalThis as { React?: typeof React }).React = React;

const s = (id: string, extra: Partial<SessionListItem> & Record<string, unknown> = {}): SessionListItem => ({
  id, vpsId: 'a', name: id, cwd: '/p', kind: 'claude', status: 'active', createdAt: 1, ...extra,
} as unknown as SessionListItem);
const prof = (extra: Partial<AccountProfile>): AccountProfile => ({
  id: 'default', vpsId: 'a', provider: 'claude', number: 1, name: '', loggedIn: true,
  accountKey: null, email: null, ...extra,
});
const vpsName = (id: string) => ({ a: 'alpha', b: 'beta' } as Record<string, string>)[id] ?? id;
const groupsOf = (sessions: SessionListItem[], profiles: AccountProfile[]) =>
  buildAccountGroups({ sessions, profiles, enabled: { claude: true, codex: true, cursor: true }, vpsName });
const render = (group: ReturnType<typeof groupsOf>[number], usage: AccountUsage | null = null) =>
  renderToStaticMarkup(createElement(AccountNavItem, {
    group, usage, onRefreshUsage: () => {}, vpsName, selectedId: null, onOpen: () => {},
  }));

describe('AccountNavItem', () => {
  it('names the account (logo + label, full identity in the tooltip) and carries its unread class', () => {
    const [g] = groupsOf([s('done', { unreadStop: 1 })], [
      prof({ accountKey: 'K', email: 'me@x.io' }), prof({ vpsId: 'b', accountKey: 'K', email: 'me@x.io' }),
    ]);
    const html = render(g);
    expect(html).toMatch(/class="acct-nav-item has-unread"/);
    expect(html).toContain(`src="${PROVIDERS.claude.logo}"`);
    expect(html).toContain('<span class="acct-nav-label">me@x.io</span>');
    expect(html).toContain('alpha, beta');
    expect(html).toContain('usage-rings acct-nav-usage');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it('a blocked session on another VPS of the same login ⇒ waiting', () => {
    const [g] = groupsOf([
      s('done', { unreadStop: 1 }),
      s('blk', { vpsId: 'b', status: 'thinking', pendingBlocking: 1, pendingAsync: 0 }),
    ], [prof({ accountKey: 'K' }), prof({ vpsId: 'b', accountKey: 'K' })]);
    expect(render(g)).toMatch(/class="acct-nav-item has-waiting"/);
  });

  it('a provider without a usage API keeps its dashboard link, with the account inside it', () => {
    const [g] = groupsOf([s('c', { kind: 'cursor' })], []);
    const html = render(g);
    expect(html).toContain('usage-rings acct-nav-usage usage-rings-link');
    expect(html).toContain(`href="${PROVIDERS.cursor.usageDashboardUrl}"`);
    expect(html).toMatch(/<a [^>]*><span class="agent-logo agent-logo-cursor[\s\S]*acct-nav-label[\s\S]*usage ↗<\/a>/);
  });

  it('renders rings with readings', () => {
    const [g] = groupsOf([s('x')], [prof({ accountKey: 'K', name: 'work' })]);
    const html = render(g, { ok: true, fetchedAt: 1, fiveHour: { utilization: 40, resetsAt: null } } as AccountUsage);
    expect(html).toContain('<span class="acct-nav-label">work</span>');
    expect(html).toContain('5h 40%');
  });
});

describe('AccountNav', () => {
  it('renders nothing without accounts', () => {
    expect(renderToStaticMarkup(createElement(AccountNav, {
      groups: [], onRefreshUsage: () => {}, vpsName, selectedId: null, onOpen: () => {},
    }))).toBe('');
  });
});

describe('UsageRings lead/className', () => {
  it('without them, the session-header markup is unchanged; with them, the lead is first in the button', () => {
    const plain = renderToStaticMarkup(createElement(UsageRings, { usage: null, kind: 'claude', accountLabel: 'Claude' }));
    expect(plain.startsWith('<div class="usage-rings"><button type="button" class="usage-rings-button"')).toBe(true);
    const led = renderToStaticMarkup(createElement(UsageRings, {
      usage: null, kind: 'claude', accountLabel: 'Claude', className: 'x', lead: createElement('i', null, 'L'),
    }));
    expect(led).toMatch(/^<div class="usage-rings x"><button [^>]*><i>L<\/i><svg/);
  });
});
