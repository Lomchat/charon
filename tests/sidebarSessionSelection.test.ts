import { describe, expect, it } from 'vitest';
import { reconcileSidebarSessionSelection } from '@/app/sidebarSessionSelection';

describe('reconcileSidebarSessionSelection', () => {
  it('seeds an empty selection from the active session', () => {
    expect([...reconcileSidebarSessionSelection(new Set(), 'session-a', false)])
      .toEqual(['session-a']);
  });

  it('does not overwrite an intentional bulk selection on a normal tab change', () => {
    const current = new Set(['session-a', 'session-b']);
    expect(reconcileSidebarSessionSelection(current, 'session-c', false)).toBe(current);
  });

  it('replaces the previous selection when a newly-created session opens', () => {
    const current = new Set(['old-session']);
    expect([...reconcileSidebarSessionSelection(current, 'new-session', true)])
      .toEqual(['new-session']);
  });
});
