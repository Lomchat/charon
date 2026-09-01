import { describe, expect, it } from 'vitest';
import { mergeSidebarPathOrder, sidebarPathKey, sidebarPathOrderedIds } from '@/app/sidebarPathGroups';

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
});
