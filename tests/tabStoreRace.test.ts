import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabDTO } from '@/lib/types/api';

// The tab store's optimistic focus against answers that predate it
// (app/tabStore.ts § mutate). Every preview open is a layout change, so the
// click's own `tabs_changed` refetches the layout: a second click while that
// GET (or the first POST) is in flight used to land an OLDER layout over the
// new provisional row — focus fell to a neighbour, then came back.

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const api = {
  listTabs: vi.fn(), openTab: vi.fn(), updateTab: vi.fn(),
  closeTab: vi.fn(), reorderTabs: vi.fn(), closeTabsWhere: vi.fn(),
};
vi.mock('@/lib/api', () => ({ api }));

const tab = (id: string, path: string, kind: TabDTO['kind'] = 'session', pinned = true): TabDTO => ({
  id, vpsId: 'v', path, kind, ref: id, pinned, active: false, position: 0, vpsPos: 0, groupPos: 0,
});
const A = tab('a', '/one');
const C = tab('c', '/two');
const B = tab('b', '/two', 'session', false);
const E = tab('e', '/three', 'session', false);

let store: typeof import('@/app/tabStore');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.resetModules();
  delete (globalThis as { __charonTabState?: unknown }).__charonTabState;
  delete (globalThis as { __charonTabMru?: unknown }).__charonTabMru;
  for (const fn of Object.values(api)) fn.mockReset();
  store = await import('@/app/tabStore');
  api.listTabs.mockResolvedValueOnce({ tabs: [A, C], sync: null });
  await store.refreshTabs();
  await store.activateTab('a');
});
afterEach(() => { vi.resetModules(); });

const active = () => store.activeTab()?.ref ?? null;

describe('tab store: optimistic focus vs older layouts', () => {
  it('a refetch read before the click does not move focus off the provisional tab', async () => {
    const list = deferred<{ tabs: TabDTO[]; sync: null }>();
    const open = deferred<{ tab: TabDTO; tabs: TabDTO[] }>();
    api.listTabs.mockReturnValueOnce(list.promise);
    api.openTab.mockReturnValueOnce(open.promise);

    void store.refreshTabs();          // the previous click's tabs_changed
    const opening = store.openTab({ vpsId: 'v', path: '/two', kind: 'session', ref: 'b' });
    expect(active()).toBe('b');

    list.resolve({ tabs: [A, C], sync: null });   // predates the open
    await flush();
    expect(active()).toBe('b');        // was 'c', the group neighbour

    open.resolve({ tab: B, tabs: [A, C, B] });
    await opening;
    expect(store.activeTab()?.id).toBe('b');
  });

  it("an earlier open's answer does not pull focus back from a later one", async () => {
    const first = deferred<{ tab: TabDTO; tabs: TabDTO[] }>();
    const second = deferred<{ tab: TabDTO; tabs: TabDTO[] }>();
    api.openTab.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const one = store.openTab({ vpsId: 'v', path: '/two', kind: 'session', ref: 'b' });
    const two = store.openTab({ vpsId: 'v', path: '/three', kind: 'session', ref: 'e' });
    expect(active()).toBe('e');

    first.resolve({ tab: B, tabs: [A, C, B] });
    await one;
    expect(active()).toBe('e');        // was 'b'

    second.resolve({ tab: E, tabs: [A, C, B, E] });
    await two;
    expect(store.activeTab()?.id).toBe('e');
  });

  it("an open's answer does not steal a local refocus made meanwhile", async () => {
    const open = deferred<{ tab: TabDTO; tabs: TabDTO[] }>();
    api.openTab.mockReturnValueOnce(open.promise);

    const opening = store.openTab({ vpsId: 'v', path: '/two', kind: 'session', ref: 'b' });
    await store.activateTab('a');
    open.resolve({ tab: B, tabs: [A, C, B] });
    await opening;
    expect(active()).toBe('a');
  });

  it('a failed mutation still resyncs the layout', async () => {
    api.openTab.mockRejectedValueOnce(new Error('boom'));
    api.listTabs.mockResolvedValueOnce({ tabs: [A, C], sync: null });
    await store.openTab({ vpsId: 'v', path: '/two', kind: 'session', ref: 'b' });
    await flush();
    expect(api.listTabs).toHaveBeenCalledTimes(2);
    expect(store.activeTab()?.path).toBe('/two');   // fell back within the group
  });
});
