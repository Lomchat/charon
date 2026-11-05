import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTabFocus, projectTabFocus, serializeTabFocus } from '@/app/tabFocusCookie';
import type { TabDTO } from '@/lib/types/api';

// The SSR paints THIS browser's tab (app/tabFocusCookie.ts): the page projects
// the cookie the tab store mirrors, exactly as `restoreLocalTabFocus` will.

const tab = (id: string, active = false): TabDTO => ({
  id, vpsId: 'v', path: '/p', kind: 'session', ref: id, pinned: true, active,
  position: 0, vpsPos: 0, groupPos: 0,
});
const activeOf = (tabs: TabDTO[]) => tabs.filter((t) => t.active).map((t) => t.id);

describe('tab focus cookie', () => {
  it('round-trips an id, and an explicitly empty focus', () => {
    expect(parseTabFocus(serializeTabFocus('02af2ed1844943e8'))).toBe('02af2ed1844943e8');
    expect(parseTabFocus(serializeTabFocus('pending:session:a b'))).toBe('pending:session:a b');
    expect(parseTabFocus(serializeTabFocus(null))).toBeNull();
  });

  it('no cookie (or a garbled one) keeps the layout\'s own choice', () => {
    const tabs = [tab('a', true), tab('b')];
    expect(parseTabFocus(undefined)).toBeUndefined();
    expect(parseTabFocus('%E0%A4%A')).toBeUndefined();
    expect(projectTabFocus(tabs, undefined)).toBe(tabs);
  });

  it('focuses the remembered tab over the shared legacy active bit', () => {
    expect(activeOf(projectTabFocus([tab('a', true), tab('b')], 'b'))).toEqual(['b']);
  });

  it('a remembered tab that is gone, or an emptied workspace, means no tab', () => {
    expect(activeOf(projectTabFocus([tab('a', true), tab('b')], 'zz'))).toEqual([]);
    expect(activeOf(projectTabFocus([tab('a', true), tab('b')], null))).toEqual([]);
  });
});

describe('tab store mirrors its focus into the cookie', () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    for (const k of ['window', 'document', 'localStorage', '__charonTabState', '__charonTabMru',
      '__charonTabSubs', '__charonTabUnloadArmed']) delete g[k];
    vi.resetModules();
  });

  it('writes what the next SSR projects, and restore then changes nothing', async () => {
    const store = new Map<string, string>();
    let cookie = '';
    g.window = { addEventListener: () => {} };
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    g.document = {
      get cookie() { return cookie; },
      set cookie(v: string) { cookie = v.split(';')[0]; },
    };
    vi.resetModules();
    vi.doMock('@/lib/api', () => ({ api: { listTabs: async () => ({ tabs: [tab('a', true), tab('b')], sync: null }) } }));
    const tabStore = await import('@/app/tabStore');
    await tabStore.refreshTabs();
    await tabStore.activateTab('b');
    const [name, value] = cookie.split('=');
    expect(name).toBe('charon_tab');

    // Next page load: the server's legacy active is still `a`.
    const ssr = projectTabFocus([tab('a', true), tab('b')], parseTabFocus(value));
    expect(activeOf(ssr)).toEqual(['b']);
    vi.resetModules();
    delete g.__charonTabState;
    const next = await import('@/app/tabStore');
    next.hydrateTabs(ssr);
    next.restoreLocalTabFocus();
    expect(next.activeTab()?.id).toBe('b');
    vi.doUnmock('@/lib/api');
  });
});
