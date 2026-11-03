import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The explorer's folder tabs (app/explorerRoots.ts): which other folders of a
 * VPS a workspace has open beside its own, and which one the tree shows.
 * Pinned here: the per-workspace scope, the workspace folder being the
 * implicit first tab, where the focus goes on close, the labels that tell
 * same-named folders apart, and a corrupt store never breaking the panel.
 */

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

let M: typeof import('@/app/explorerRoots');

async function fresh(seed?: Record<string, string>) {
  const store = installStorage(seed);
  vi.resetModules();
  M = await import('@/app/explorerRoots');
  M.__resetExplorerRoots();
  return store;
}

describe('explorerRoots', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('opens a folder as a tab of ITS workspace and shows it', async () => {
    await fresh();
    M.openExplorerRoot('v1', '/srv/app', '/etc/nginx/');
    expect(M.readExplorerRoots('v1', '/srv/app')).toEqual({ folders: ['/etc/nginx'], active: '/etc/nginx' });
    // Another session folder, or the same folder on another VPS, keeps its own list.
    expect(M.readExplorerRoots('v1', '/var/www/dev')).toEqual({ folders: [], active: null });
    expect(M.readExplorerRoots('v2', '/srv/app')).toEqual({ folders: [], active: null });
    // Same workspace, spelled with a trailing slash.
    expect(M.readExplorerRoots('v1', '/srv/app/').folders).toEqual(['/etc/nginx']);
  });

  it('never duplicates a tab, and the workspace folder is the first tab already', async () => {
    await fresh();
    M.openExplorerRoot('v1', '/srv/app', '/etc/nginx');
    M.openExplorerRoot('v1', '/srv/app', '/var/log');
    M.openExplorerRoot('v1', '/srv/app', '/etc/nginx');
    expect(M.readExplorerRoots('v1', '/srv/app')).toEqual({ folders: ['/etc/nginx', '/var/log'], active: '/etc/nginx' });
    M.openExplorerRoot('v1', '/srv/app', '/srv/app/');
    expect(M.readExplorerRoots('v1', '/srv/app')).toEqual({ folders: ['/etc/nginx', '/var/log'], active: null });
  });

  it('refuses what is not an absolute path', async () => {
    await fresh();
    M.openExplorerRoot('v1', '/srv/app', 'etc/nginx');
    M.openExplorerRoot('v1', '/srv/app', '');
    expect(M.readExplorerRoots('v1', '/srv/app').folders).toEqual([]);
  });

  it('closing the tab shown hands over to its left neighbour', async () => {
    await fresh();
    for (const p of ['/a', '/b', '/c']) M.openExplorerRoot('v1', '/srv/app', p);
    M.selectExplorerRoot('v1', '/srv/app', '/b');
    M.closeExplorerRoot('v1', '/srv/app', '/b');
    expect(M.readExplorerRoots('v1', '/srv/app')).toEqual({ folders: ['/a', '/c'], active: '/a' });
    M.closeExplorerRoot('v1', '/srv/app', '/a');
    expect(M.readExplorerRoots('v1', '/srv/app')).toEqual({ folders: ['/c'], active: null });
    // Closing one that is not shown leaves the focus alone.
    M.selectExplorerRoot('v1', '/srv/app', '/c');
    M.openExplorerRoot('v1', '/srv/app', '/d');
    M.selectExplorerRoot('v1', '/srv/app', '/c');
    M.closeExplorerRoot('v1', '/srv/app', '/d');
    expect(M.readExplorerRoots('v1', '/srv/app')).toEqual({ folders: ['/c'], active: '/c' });
  });

  it('selects only tabs that exist', async () => {
    await fresh();
    M.openExplorerRoot('v1', '/srv/app', '/etc');
    M.selectExplorerRoot('v1', '/srv/app', '/nowhere');
    expect(M.readExplorerRoots('v1', '/srv/app').active).toBe('/etc');
    M.selectExplorerRoot('v1', '/srv/app', null);
    expect(M.readExplorerRoots('v1', '/srv/app').active).toBeNull();
  });

  it('persists, and reads the store back', async () => {
    const store = await fresh();
    M.openExplorerRoot('v1', '/srv/app', '/etc/nginx');
    vi.runAllTimers();
    const saved = store.get(M.EXPLORER_ROOTS_KEY)!;
    expect(JSON.parse(saved)).toEqual({ ['v1\u0000/srv/app']: { folders: ['/etc/nginx'], active: '/etc/nginx' } });
    await fresh({ [M.EXPLORER_ROOTS_KEY]: saved });
    expect(M.readExplorerRoots('v1', '/srv/app')).toEqual({ folders: ['/etc/nginx'], active: '/etc/nginx' });
  });

  it('a corrupt store opens on the workspace folder alone', async () => {
    await fresh({ 'hub.tree.roots.v1': '{not json' });
    expect(M.readExplorerRoots('v1', '/srv/app')).toEqual({ folders: [], active: null });
    await fresh({
      'hub.tree.roots.v1': JSON.stringify({
        'v1\u0000/srv/app': { folders: ['/ok', 'relative', 42, '/ok/'], active: '/gone' },
        'v1\u0000/x': 'nonsense',
      }),
    });
    expect(M.readExplorerRoots('v1', '/srv/app')).toEqual({ folders: ['/ok'], active: null });
    expect(M.readExplorerRoots('v1', '/x')).toEqual({ folders: [], active: null });
  });

  it('a file opened from another root hands that folder\'s panel the tabs it came from', async () => {
    await fresh();
    M.openExplorerRoot('v1', '/srv/app', '/etc');
    M.openExplorerRoot('v1', '/srv/app', '/var/log');
    M.selectExplorerRoot('v1', '/srv/app', '/etc');
    M.carryExplorerRoots('v1', '/srv/app', '/etc');
    // /etc's own panel: /etc is its home, the project and the other tab follow.
    expect(M.readExplorerRoots('v1', '/etc')).toEqual({ folders: ['/srv/app', '/var/log'], active: null });
    // The source keeps showing what it showed.
    expect(M.readExplorerRoots('v1', '/srv/app')).toEqual({ folders: ['/etc', '/var/log'], active: '/etc' });
    // Again: nothing duplicated, the target's own choice untouched.
    M.selectExplorerRoot('v1', '/etc', '/var/log');
    M.carryExplorerRoots('v1', '/srv/app', '/etc');
    expect(M.readExplorerRoots('v1', '/etc')).toEqual({ folders: ['/srv/app', '/var/log'], active: '/var/log' });
  });

  it('labels a tab by its name, with as much of its path as tells it apart', async () => {
    await fresh();
    const labels = M.explorerRootLabels(['/srv/app', '/etc/nginx', '/etc/nginx/conf.d', '/opt/site/conf.d', '/', '/var/www/app']);
    expect(labels.get('/etc/nginx')).toBe('nginx');
    expect(labels.get('/etc/nginx/conf.d')).toBe('nginx/conf.d');
    expect(labels.get('/opt/site/conf.d')).toBe('site/conf.d');
    expect(labels.get('/')).toBe('/');
    // Same name as the workspace's own folder: both get their parent.
    expect(labels.get('/srv/app')).toBe('srv/app');
    expect(labels.get('/var/www/app')).toBe('www/app');
  });
});

describe('the "open a folder" choices', () => {
  it('lists the known paths, then the folders already in use on that VPS', async () => {
    const { folderChoices } = await import('@/app/OpenFolderModal');
    const vps = { id: 'v1', defaultPath: '/srv' } as never;
    const paths = [
      { vpsId: 'v1', path: '/srv/app', label: 'app' },
      { vpsId: 'v2', path: '/elsewhere', label: '' },
    ] as never;
    expect(folderChoices(vps, paths, ['/srv/app/', '/var/www/dev', '/var/www/dev', '/etc/nginx', 'relative']))
      .toEqual([
        { label: 'default', path: '/srv' },
        { label: 'app', path: '/srv/app' },
        { label: 'nginx', path: '/etc/nginx' },
        { label: 'dev', path: '/var/www/dev' },
      ]);
  });
});
