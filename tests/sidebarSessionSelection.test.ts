import { describe, expect, it } from 'vitest';
import { reconcileSidebarSessionSelection } from '@/app/sidebarSessionSelection';

describe('reconcileSidebarSessionSelection', () => {
  it('seeds an empty selection from the active session', () => {
    expect([...reconcileSidebarSessionSelection(new Set(), 'session-a', 'session-a')])
      .toEqual(['session-a']);
  });

  it('keeps the same Set when the open session is already the only selected row', () => {
    const current = new Set(['session-a']);
    expect(reconcileSidebarSessionSelection(current, 'session-a', 'session-a')).toBe(current);
  });

  it('collapses onto the session opened from outside the sidebar', () => {
    // Header nav / notification / tab bar: the row just left must not keep
    // its highlight, or two cards read as selected at once.
    expect([...reconcileSidebarSessionSelection(new Set(['session-a']), 'session-b', 'session-b')])
      .toEqual(['session-b']);
    expect([...reconcileSidebarSessionSelection(
      new Set(['session-a', 'session-b']), 'session-c', 'session-c',
    )]).toEqual(['session-c']);
  });

  it('empties the selection when a shell, install or file owns the open tab', () => {
    // The shell row draws its own highlight; the session left behind keeping
    // one is the two-selected-cards bug, from the other direction.
    expect([...reconcileSidebarSessionSelection(new Set(['session-a']), null, 'shell-1')])
      .toEqual([]);
    expect([...reconcileSidebarSessionSelection(
      new Set(['session-a', 'session-b']), null, 'src/index.ts',
    )]).toEqual([]);
  });

  it('keeps the same Set when a non-session tab opens over an empty selection', () => {
    const current = new Set<string>();
    expect(reconcileSidebarSessionSelection(current, null, 'shell-1')).toBe(current);
  });

  it('leaves the selection alone when NO tab is open at all', () => {
    const current = new Set(['session-a', 'session-b']);
    expect(reconcileSidebarSessionSelection(current, null, null)).toBe(current);
  });
});
