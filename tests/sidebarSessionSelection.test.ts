import { describe, expect, it } from 'vitest';
import { reconcileSidebarSessionSelection } from '@/app/sidebarSessionSelection';

describe('reconcileSidebarSessionSelection', () => {
  it('seeds an empty selection from the active session', () => {
    expect([...reconcileSidebarSessionSelection(new Set(), 'session-a')])
      .toEqual(['session-a']);
  });

  it('keeps the same Set when the open session is already the only selected row', () => {
    const current = new Set(['session-a']);
    expect(reconcileSidebarSessionSelection(current, 'session-a')).toBe(current);
  });

  it('collapses onto the session opened from outside the sidebar', () => {
    // Header nav / notification / tab bar: the row just left must not keep
    // its highlight, or two cards read as selected at once.
    expect([...reconcileSidebarSessionSelection(new Set(['session-a']), 'session-b')])
      .toEqual(['session-b']);
    expect([...reconcileSidebarSessionSelection(new Set(['session-a', 'session-b']), 'session-c')])
      .toEqual(['session-c']);
  });

  it('leaves the selection alone when no session is open', () => {
    const current = new Set(['session-a', 'session-b']);
    expect(reconcileSidebarSessionSelection(current, null)).toBe(current);
  });
});
