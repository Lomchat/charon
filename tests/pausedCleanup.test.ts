import { describe, expect, it } from 'vitest';
import type { Vps, VpsFolder } from '@/lib/db/schema';
import type { SessionListItem } from '@/lib/types/api';
import {
  buildPausedTree, formatAgo, formatStamp, groupCheckState, isPausedSession,
  toggleGroup, toggleRow,
} from '@/app/pausedCleanup';

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const DAY = 86_400_000;

const folder = (id: string, name: string, position: number) =>
  ({ id, name, position, collapsed: 0, createdAt: 0 }) as VpsFolder;
const vps = (id: string, folderId: string, position: number) =>
  ({ id, name: id.toUpperCase(), folderId, position, sshUser: 'root', ip: '10.0.0.1', sshPort: 22 }) as unknown as Vps;
let n = 0;
const session = (over: Partial<SessionListItem>) => ({
  id: `s${++n}`, vpsId: 'a', cwd: '/srv/app', status: 'sleeping', liveStatus: 'sleeping',
  name: null, firstUserMessage: null, handle: null, kind: 'claude',
  position: 0, createdAt: Math.floor((NOW - 100 * DAY) / 1000), lastActivityMs: null,
  ...over,
}) as unknown as SessionListItem;

const folders = [folder('default', 'No folder', 9), folder('f2', 'Prod', 1), folder('f1', 'Lab', 0)];
const machines = [vps('a', 'f1', 1), vps('b', 'f1', 0), vps('c', 'default', 0), vps('d', 'f2', 0)];

describe('which sessions the cleanup offers', () => {
  it('trusts the live status over the database column', () => {
    expect(isPausedSession({ status: 'sleeping', liveStatus: 'active' })).toBe(false);
    expect(isPausedSession({ status: 'active', liveStatus: 'sleeping' })).toBe(true);
  });

  it('lists only paused sessions', () => {
    const tree = buildPausedTree([
      session({ id: 'p' }), session({ id: 'r', liveStatus: 'thinking' }), session({ id: 'e', liveStatus: 'error' }),
    ], machines, folders);
    expect(tree.ids).toEqual(['p']);
  });
});

describe('the tree follows the sidebar', () => {
  const sessions = [
    session({ id: 'c1', vpsId: 'c' }),
    session({ id: 'a1', vpsId: 'a' }),
    session({ id: 'd1', vpsId: 'd' }),
    session({ id: 'b1', vpsId: 'b' }),
    session({ id: 'z1', vpsId: 'gone' }),
  ];
  const tree = buildPausedTree(sessions, machines, folders);

  it('orders folders by position, the default one last, unknown machines after', () => {
    expect(tree.folders.map((f) => f.key)).toEqual(['f1', 'f2', 'default', '__orphans__']);
  });

  it('orders machines by position inside a folder', () => {
    expect(tree.folders[0].vps.map((v) => v.vpsId)).toEqual(['b', 'a']);
    expect(tree.ids).toEqual(['b1', 'a1', 'd1', 'c1', 'z1']);
  });

  it('carries every id under each group', () => {
    expect(tree.folders[0].ids).toEqual(['b1', 'a1']);
    expect(tree.folders[0].vps[1].paths[0].ids).toEqual(['a1']);
  });
});

describe('inside a machine', () => {
  it('keeps the sidebar path order, newest message first within a path, silent last', () => {
    const tree = buildPausedTree([
      session({ id: 'x-old', cwd: '/x', position: 0, lastActivityMs: NOW - 9 * DAY }),
      session({ id: 'y', cwd: '/y/', position: 1, lastActivityMs: NOW - DAY }),
      session({ id: 'x-silent', cwd: '/x', position: 2, lastActivityMs: null }),
      session({ id: 'x-new', cwd: '/x', position: 3, lastActivityMs: NOW - 2 * DAY }),
    ], machines, folders);
    const paths = tree.folders[0].vps[0].paths;
    expect(paths.map((p) => p.path)).toEqual(['/x', '/y']);
    expect(paths[0].ids).toEqual(['x-new', 'x-old', 'x-silent']);
  });

  it('orders paths as the sidebar does, running sessions included', () => {
    const tree = buildPausedTree([
      session({ id: 'run', cwd: '/y', position: 0, liveStatus: 'active' }),
      session({ id: 'x', cwd: '/x', position: 1 }),
      session({ id: 'y', cwd: '/y', position: 2 }),
      session({ id: 'z', cwd: '/z', position: 3, liveStatus: 'thinking' }),
    ], machines, folders);
    expect(tree.folders[0].vps[0].paths.map((p) => p.path)).toEqual(['/y', '/x']);
    expect(tree.ids).toEqual(['y', 'x']);
  });
});

describe('filters', () => {
  const sessions = [
    session({ id: 'n', name: 'Refactor billing', lastActivityMs: NOW - 2 * DAY }),
    session({ id: 'm', firstUserMessage: 'fix the login page', cwd: '/srv/web', lastActivityMs: NOW - 40 * DAY }),
    session({ id: 'h', handle: 'api-worker', vpsId: 'd', lastActivityMs: NOW - 10 * DAY }),
    session({ id: 'q', lastActivityMs: null, createdAt: Math.floor((NOW - 50 * DAY) / 1000) }),
  ];

  it('ANDs substring terms over name, message, path, machine and handle', () => {
    const q = (query: string) => buildPausedTree(sessions, machines, folders, { query, now: NOW }).ids;
    expect(q('billing')).toEqual(['n']);
    expect(q('LOGIN web')).toEqual(['m']);
    expect(q('login billing')).toEqual([]);
    expect(q('@api')).toEqual(['h']);
    expect(q('D')).toContain('h');
  });

  it('keeps only sessions idle for long enough, a silent one aging from its launch', () => {
    const ids = buildPausedTree(sessions, machines, folders, { minIdleMs: 30 * DAY, now: NOW }).ids;
    expect(ids.sort()).toEqual(['m', 'q']);
  });
});

describe('selection', () => {
  it('reports none / some / all', () => {
    expect(groupCheckState(['a', 'b'], new Set())).toBe('none');
    expect(groupCheckState(['a', 'b'], new Set(['a']))).toBe('some');
    expect(groupCheckState(['a', 'b'], new Set(['a', 'b', 'x']))).toBe('all');
  });

  it('a partial group checkbox selects the rest; a full one clears only the group', () => {
    expect([...toggleGroup(['a', 'b'], new Set(['a', 'x']))].sort()).toEqual(['a', 'b', 'x']);
    expect([...toggleGroup(['a', 'b'], new Set(['a', 'b', 'x']))]).toEqual(['x']);
  });

  it('shift-click gives the whole range the state of the clicked row', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    expect([...toggleRow(order, new Set(['b']), 'd', 'b', true)].sort()).toEqual(['b', 'c', 'd']);
    expect([...toggleRow(order, new Set(['a', 'b', 'c', 'd']), 'b', 'd', true)].sort()).toEqual(['a']);
    // Without an anchor, or without shift, it is a plain toggle.
    expect([...toggleRow(order, new Set(), 'c', null, true)]).toEqual(['c']);
    expect([...toggleRow(order, new Set(), 'c', 'a', false)]).toEqual(['c']);
  });
});

describe('dates', () => {
  it('says how long ago on a cleanup scale', () => {
    expect(formatAgo(NOW - 20_000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(formatAgo(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(formatAgo(NOW - 12 * DAY, NOW)).toBe('12 d ago');
    expect(formatAgo(NOW - 95 * DAY, NOW)).toBe('3 mo ago');
    expect(formatAgo(NOW - 800 * DAY, NOW)).toBe('2 y ago');
  });

  it('prints weekday, day, month and time — the year only when it differs', () => {
    const local = new Date(2026, 8, 22, 9, 5).getTime();
    expect(formatStamp(local, local)).toBe('Tue 22 Sep · 09:05');
    expect(formatStamp(new Date(2025, 0, 3, 18, 40).getTime(), local)).toBe('Fri 3 Jan 2025 · 18:40');
  });
});
