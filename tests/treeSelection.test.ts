import { describe, expect, it } from 'vitest';
import {
  collapseTreeDeletePaths, isTreeSelectionOnly, readTreeSelection, selectTreeRow,
  treeSelectionScope, writeTreeSelection,
} from '../app/treeSelection';

const paths = ['a.ts', 'src', 'src/a.ts', 'src/b.ts', 'z.ts'];

describe('tree selection navigation guard', () => {
  it('blocks opening for Ctrl/Cmd, Shift, and their combination', () => {
    expect(isTreeSelectionOnly({ toggle: true, range: false })).toBe(true);
    expect(isTreeSelectionOnly({ toggle: false, range: true })).toBe(true);
    expect(isTreeSelectionOnly({ toggle: true, range: true })).toBe(true);
    expect(isTreeSelectionOnly({ toggle: false, range: false })).toBe(false);
  });
});

describe('selectTreeRow', () => {
  it('replaces the selection on a plain click', () => {
    const next = selectTreeRow(paths, new Set(['a.ts', 'z.ts']), 'a.ts', 'src/a.ts', {
      toggle: false,
      range: false,
    });
    expect([...next.selected]).toEqual(['src/a.ts']);
    expect(next.anchor).toBe('src/a.ts');
  });

  it('toggles independent rows with Ctrl/Cmd', () => {
    const added = selectTreeRow(paths, new Set(['a.ts']), 'a.ts', 'z.ts', {
      toggle: true,
      range: false,
    });
    expect([...added.selected]).toEqual(['a.ts', 'z.ts']);

    const removed = selectTreeRow(paths, added.selected, added.anchor, 'a.ts', {
      toggle: true,
      range: false,
    });
    expect([...removed.selected]).toEqual(['z.ts']);
  });

  it('selects the visible interval with Shift in either direction', () => {
    const forward = selectTreeRow(paths, new Set(['a.ts']), 'a.ts', 'src/b.ts', {
      toggle: false,
      range: true,
    });
    expect([...forward.selected]).toEqual(['a.ts', 'src', 'src/a.ts', 'src/b.ts']);
    expect(forward.anchor).toBe('a.ts');

    const backward = selectTreeRow(paths, new Set(['z.ts']), 'z.ts', 'src/a.ts', {
      toggle: false,
      range: true,
    });
    expect([...backward.selected]).toEqual(['src/a.ts', 'src/b.ts', 'z.ts']);
  });

  it('adds a Shift interval when Ctrl/Cmd is also held', () => {
    const next = selectTreeRow(paths, new Set(['z.ts', 'a.ts']), 'a.ts', 'src/b.ts', {
      toggle: true,
      range: true,
    });
    expect([...next.selected]).toEqual(['z.ts', 'a.ts', 'src', 'src/a.ts', 'src/b.ts']);
  });

  it('falls back to the target when the old anchor is no longer visible', () => {
    const next = selectTreeRow(paths, new Set(['old.ts']), 'old.ts', 'src/a.ts', {
      toggle: false,
      range: true,
    });
    expect([...next.selected]).toEqual(['src/a.ts']);
    expect(next.anchor).toBe('src/a.ts');
  });
});

describe('collapseTreeDeletePaths', () => {
  it('drops selected descendants when their parent is already deleted', () => {
    const rows = [
      { path: 'src/a.ts' },
      { path: 'README.md' },
      { path: 'src/nested/b.ts' },
      { path: 'src' },
    ];
    expect(collapseTreeDeletePaths(rows).map((row) => row.path)).toEqual(['README.md', 'src']);
  });
});

describe('tree selection lifetime', () => {
  it('restores selection when the same folder is remounted in the file view', () => {
    const chatScope = treeSelectionScope('vps-remount-test', '/srv/project/');
    writeTreeSelection(chatScope, new Set(['src/a.ts']), 'src/a.ts');

    // The file page has sessionId=null, but its VPS/root identity is unchanged.
    const fileScope = treeSelectionScope('vps-remount-test', '/srv/project');
    const restored = readTreeSelection(fileScope);
    expect([...restored.selected]).toEqual(['src/a.ts']);
    expect(restored.anchor).toBe('src/a.ts');

    // Callers receive a copy, never the cache's mutable Set.
    restored.selected.add('src/b.ts');
    expect([...readTreeSelection(fileScope).selected]).toEqual(['src/a.ts']);
  });
});
