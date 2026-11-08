import { describe, expect, it } from 'vitest';
import { nestSubSessions, renderedSessionIds } from '@/app/sidebarSubSessions';
import { mergeSidebarPathOrder } from '@/app/sidebarPathGroups';

const s = (id: string, cwd: string, createdAt: number, parentSessionId: string | null = null) =>
  ({ id, cwd, createdAt, parentSessionId });
const none = new Set<string>();

describe('sidebar sub-sessions', () => {
  const items = [s('p', '/a', 1), s('x', '/b', 2), s('c2', '/z', 6, 'p'), s('c1', '/b', 5, 'p'), s('g', '/a', 9, 'c1')];

  it('nests children under their parent, whatever their cwd, by createdAt', () => {
    expect(renderedSessionIds(items, none, () => false)).toEqual(['p', 'c1', 'g', 'c2', 'x']);
  });

  it('a folded parent hides its subtree but counts it', () => {
    const [a] = nestSubSessions(items, new Set(['p']));
    expect(a!.rows.map((r) => r.item.id)).toEqual(['p']);
    expect(a!.rows[0]!.descendants).toHaveLength(3);
    expect(a!.total).toBe(4);
  });

  it('an absent parent or a cycle yields roots, never lost rows', () => {
    const odd = [s('o', '/a', 1, 'gone'), s('a', '/a', 2, 'b'), s('b', '/a', 3, 'a')];
    expect(renderedSessionIds(odd, none, () => false).sort()).toEqual(['a', 'b', 'o']);
  });

  it('reordering roots keeps the FULL order: children hold their slots', () => {
    const roots = ['p', 'q'];
    const all = [s('p', '/a', 1), s('c', '/b', 2, 'p'), s('q', '/a', 3)];
    expect(mergeSidebarPathOrder(all, '/a', ['q', 'p'], roots)).toEqual(['q', 'c', 'p']);
  });
});
