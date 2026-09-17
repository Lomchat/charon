import { describe, expect, it } from 'vitest';
import { groupShown, mergeVisibleOrder, visibleTabs } from '@/app/pausedTabs';

const tab = (id: string, state: string, live = true) => ({ id, state, live });

describe('"show paused" in the workspace strip', () => {
  const tabs = [
    tab('t1', 'thinking'),
    tab('t2', 'sleeping'),
    tab('t3', 'active'),
    tab('file', 'sleeping', false),
  ];

  it('changes nothing while the switch is on', () => {
    expect(visibleTabs(tabs, true, null).map((t) => t.id))
      .toEqual(['t1', 't2', 't3', 'file']);
  });

  it('drops sleeping sessions but never an open file', () => {
    // A file tab is 'sleeping' because nothing about it runs; a switch about
    // paused SESSIONS must not close the file you are editing.
    expect(visibleTabs(tabs, false, null).map((t) => t.id)).toEqual(['t1', 't3', 'file']);
  });

  it('keeps the tab you are looking at, asleep or not', () => {
    expect(visibleTabs(tabs, false, 't2').map((t) => t.id)).toEqual(['t1', 't2', 't3', 'file']);
  });
});

describe('which machines and folders keep a row', () => {
  it('keeps a group holding anything awake', () => {
    expect(groupShown([tab('a', 'sleeping'), tab('b', 'thinking')], false, null)).toBe(true);
  });

  it('drops a group whose only tabs are FILES', () => {
    // A machine whose sessions are all asleep is asleep, whatever is open on
    // it: an open file keeps its place inside a folder, never on its own.
    expect(groupShown([tab('f', 'sleeping', false), tab('s', 'sleeping')], false, null))
      .toBe(false);
  });

  it('keeps the group holding the tab you are looking at', () => {
    expect(groupShown([tab('f', 'sleeping', false)], false, 'f')).toBe(true);
  });

  it('keeps every group while the switch is on', () => {
    expect(groupShown([tab('f', 'sleeping', false)], true, null)).toBe(true);
  });
});

describe('committing a drag made on a filtered list', () => {
  it('slots the visible order back into the hidden one', () => {
    // b and d are hidden; dragging c before a must not move them.
    expect(mergeVisibleOrder(['a', 'b', 'c', 'd', 'e'], ['c', 'a', 'e']))
      .toEqual(['c', 'b', 'a', 'd', 'e']);
  });

  it('is the identity when nothing is hidden', () => {
    expect(mergeVisibleOrder(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual(['c', 'b', 'a']);
  });

  it('commits the drag verbatim when the two lists disagree', () => {
    // Different snapshots (a tab closed underneath): interleaving there would
    // invent an order neither side asked for.
    expect(mergeVisibleOrder(['a', 'b'], ['a', 'z'])).toEqual(['a', 'z']);
  });
});
