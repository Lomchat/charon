import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The explorer's open-folder memory (§14.77).
 *
 * The property that matters is the one that is easy to get wrong by storing
 * the wrong thing: a listing that GAINED or LOST entries must not disturb what
 * is open. That is only true because paths are stored, never indices or
 * offsets — so that is what these tests pin, alongside the scope rule (per
 * session, not per folder) and the bounds.
 */

// The module reads `window.localStorage` at first use; vitest runs in node.
function installStorage(seed?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
    },
  };
  return map;
}

const KEY = 'hub.tree.expanded.v1';
let M: typeof import('@/app/treeExpansion');

async function fresh(seed?: Record<string, string>) {
  const store = installStorage(seed);
  vi.resetModules();
  M = await import('@/app/treeExpansion');
  M.__resetTreeExpansion();
  return store;
}

describe('treeExpansion', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('scopes on the SESSION, and on the folder only when there is none', async () => {
    await fresh();
    expect(M.treeScope('sess-a', 'v1', '/srv/app')).toBe('s:sess-a');
    // Two sessions in the SAME folder are two different trees — that is the
    // whole point of the session scope.
    expect(M.treeScope('sess-b', 'v1', '/srv/app'))
      .not.toBe(M.treeScope('sess-a', 'v1', '/srv/app'));
    // Beside the file editor there is no session; the folder is the identity.
    expect(M.treeScope(null, 'v1', '/srv/app')).toBe('d:v1:/srv/app');
    expect(M.treeScope(null, 'v2', '/srv/app')).not.toBe(M.treeScope(null, 'v1', '/srv/app'));
  });

  it('remembers what was open, and always reopens the root', async () => {
    await fresh();
    M.writeExpanded('s:a', new Set(['', 'src', 'src/app']));
    expect(M.readExpanded('s:a')).toEqual(new Set(['', 'src', 'src/app']));
    // An untouched scope starts with the root alone, never empty — the root
    // listing is what the tree IS.
    expect(M.readExpanded('s:never-seen')).toEqual(new Set(['']));
  });

  it('keeps each session apart', async () => {
    await fresh();
    M.writeExpanded('s:a', new Set(['', 'front']));
    M.writeExpanded('s:b', new Set(['', 'agent', 'agent/tests']));
    expect(M.readExpanded('s:a')).toEqual(new Set(['', 'front']));
    expect(M.readExpanded('s:b')).toEqual(new Set(['', 'agent', 'agent/tests']));
  });

  it('survives a listing that gained or lost folders', async () => {
    // The reason paths are stored: the tree re-lists constantly (a turn ends,
    // a commit lands) and the set must mean the same thing afterwards.
    await fresh();
    M.writeExpanded('s:a', new Set(['', 'src', 'src/app']));
    const restored = M.readExpanded('s:a');
    // A new sibling appeared — it is simply not in the set, so it stays shut.
    expect(restored.has('src/brand-new')).toBe(false);
    // And the ones that were open still are, wherever they now sort.
    expect(restored.has('src')).toBe(true);
    expect(restored.has('src/app')).toBe(true);
  });

  it('round-trips through localStorage after the debounce', async () => {
    const store = await fresh();
    M.writeExpanded('s:a', new Set(['', 'src']));
    expect(store.get(KEY)).toBeUndefined();   // debounced, not written yet
    vi.advanceTimersByTime(500);
    expect(JSON.parse(store.get(KEY)!)).toEqual({ 's:a': ['src'] });

    // A fresh page load sees it.
    await fresh({ [KEY]: store.get(KEY)! });
    expect(M.readExpanded('s:a')).toEqual(new Set(['', 'src']));
  });

  it('drops the least-recently-touched tree, never the one in use', async () => {
    await fresh();
    for (let i = 0; i < 70; i++) M.writeExpanded(`s:${i}`, new Set([`d${i}`]));
    // The oldest are gone, the newest are all there.
    expect(M.readExpanded('s:0')).toEqual(new Set(['']));
    expect(M.readExpanded('s:69')).toEqual(new Set(['', 'd69']));
    // Touching an old scope moves it back to the front of the queue.
    M.writeExpanded('s:15', new Set(['kept']));
    for (let i = 70; i < 100; i++) M.writeExpanded(`s:${i}`, new Set([`d${i}`]));
    expect(M.readExpanded('s:15')).toEqual(new Set(['', 'kept']));
  });

  it('caps one tree, dropping the OLDEST expansions', async () => {
    await fresh();
    const many = new Set<string>(['']);
    for (let i = 0; i < 500; i++) many.add(`dir-${i}`);
    M.writeExpanded('s:a', many);
    const back = M.readExpanded('s:a');
    expect(back.size).toBe(401);            // 400 paths + the root
    expect(back.has('dir-0')).toBe(false);  // oldest dropped
    expect(back.has('dir-499')).toBe(true);
  });

  it('a corrupt or foreign store means a closed tree, never a crash', async () => {
    await fresh({ [KEY]: 'not json at all' });
    expect(M.readExpanded('s:a')).toEqual(new Set(['']));
    await fresh({ [KEY]: '[1,2,3]' });
    expect(M.readExpanded('s:a')).toEqual(new Set(['']));
    await fresh({ [KEY]: '{"s:a":{"nope":true},"s:b":["ok",7,null]}' });
    expect(M.readExpanded('s:a')).toEqual(new Set(['']));
    expect(M.readExpanded('s:b')).toEqual(new Set(['', 'ok']));
  });

  it('works with no storage at all (private mode, SSR)', async () => {
    vi.resetModules();
    delete (globalThis as unknown as { window?: unknown }).window;
    const N = await import('@/app/treeExpansion');
    N.__resetTreeExpansion();
    expect(() => N.writeExpanded('s:a', new Set(['src']))).not.toThrow();
    expect(N.readExpanded('s:a')).toEqual(new Set(['', 'src']));
  });
});
