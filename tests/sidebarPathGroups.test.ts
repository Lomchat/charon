import { describe, expect, it } from 'vitest';
import {
  mergeSidebarPathGroupOrder, mergeSidebarPathOrder, sidebarPathKey, sidebarPathOrder,
  sidebarPathOrderedIds,
} from '@/app/sidebarPathGroups';

describe('sidebar path groups', () => {
  const sessions = [
    { id: 'a1', cwd: '/srv/a' },
    { id: 'b1', cwd: '/srv/b' },
    { id: 'a2', cwd: '/srv/a/' },
    { id: 'b2', cwd: '/srv/b' },
  ];

  it('normalizes paths without conflating different folders', () => {
    expect(sidebarPathKey('/srv/a/')).toBe('/srv/a');
    expect(sidebarPathKey(null)).toBe('~');
  });

  it('reorders only inside one path while returning the full VPS order', () => {
    expect(mergeSidebarPathOrder(sessions, '/srv/a', ['a2', 'a1']))
      .toEqual(['a2', 'b1', 'a1', 'b2']);
  });

  it('reports the grouped visual order used by Shift selection', () => {
    expect(sidebarPathOrderedIds(sessions)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('rejects ids from another path or an incomplete subgroup', () => {
    expect(mergeSidebarPathOrder(sessions, '/srv/a', ['a2', 'b1'])).toBeNull();
    expect(mergeSidebarPathOrder(sessions, '/srv/a', ['a2'])).toBeNull();
  });

  it('lists the headings in the order the sidebar draws them', () => {
    expect(sidebarPathOrder(sessions)).toEqual(['/srv/a', '/srv/b']);
  });

  it('moves a whole path by moving every session it holds', () => {
    expect(mergeSidebarPathGroupOrder(sessions, ['/srv/b', '/srv/a']))
      .toEqual(['b1', 'b2', 'a1', 'a2']);
  });

  it('keeps a heading the drag never saw in its own slot', () => {
    const withHome = [...sessions, { id: 'h1', cwd: null }, { id: 'c1', cwd: '/srv/c' }];
    // Only the two `/srv` groups are dragged; `~` and `/srv/c` stay put.
    expect(mergeSidebarPathGroupOrder(withHome, ['/srv/b', '/srv/a']))
      .toEqual(['b1', 'b2', 'a1', 'a2', 'h1', 'c1']);
  });

  it('rejects a heading list that would drop or duplicate a group', () => {
    expect(mergeSidebarPathGroupOrder(sessions, ['/srv/a', '/srv/a'])).toBeNull();
    expect(mergeSidebarPathGroupOrder(sessions, ['/srv/a', '/srv/zzz'])).toBeNull();
  });
});
