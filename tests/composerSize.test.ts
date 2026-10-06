import { describe, expect, it } from 'vitest';
import {
  COMPOSER_DETENT_PX, COMPOSER_KEY_STEP_PX, DEFAULT_COMPOSER_SIZE, clickComposer,
  parseComposerSize, snapComposer, stepComposer, type ComposerMetrics,
} from '@/app/composerSize';

// A desktop Claude bar: 25px strip when hidden, 153px at the default.
const m: ComposerMetrics = { baseFooter: 153, baseText: 128, hiddenFooter: 25, maxText: 540 };
const HIDDEN = { hidden: true, height: null };

describe('dragging the composer grip', () => {
  it('holds at the default size inside the detent', () => {
    expect(snapComposer(m.baseFooter, m)).toEqual(DEFAULT_COMPOSER_SIZE);
    expect(snapComposer(m.baseFooter + COMPOSER_DETENT_PX - 1, m)).toEqual(DEFAULT_COMPOSER_SIZE);
  });

  it('follows the pointer once out of the detent, growing the textarea only', () => {
    expect(snapComposer(m.baseFooter + 100, m)).toEqual({ hidden: false, height: m.baseText + 100 });
  });

  it('never grows past the viewport cap', () => {
    expect(snapComposer(5000, m)).toEqual({ hidden: false, height: m.maxText });
  });

  it('has nothing between hidden and default: holds, then hides past half-way', () => {
    const half = (m.baseFooter + m.hiddenFooter) / 2;
    expect(snapComposer(half, m)).toEqual(DEFAULT_COMPOSER_SIZE);
    expect(snapComposer(half - 1, m)).toEqual(HIDDEN);
    expect(snapComposer(0, m)).toEqual(HIDDEN);
  });
});

describe('a click on the grip', () => {
  it('opens a hidden bar at the default size', () => {
    expect(clickComposer(HIDDEN)).toEqual(DEFAULT_COMPOSER_SIZE);
  });

  it('brings a taller bar back to the default size', () => {
    expect(clickComposer({ hidden: false, height: 333 })).toEqual(DEFAULT_COMPOSER_SIZE);
  });

  it('hides a bar at the default size', () => {
    expect(clickComposer(DEFAULT_COMPOSER_SIZE)).toEqual(HIDDEN);
  });
});

describe('arrow keys on the grip', () => {
  it('grows from the default, and un-hides to the default', () => {
    expect(stepComposer(DEFAULT_COMPOSER_SIZE, 1, m))
      .toEqual({ hidden: false, height: m.baseText + COMPOSER_KEY_STEP_PX });
    expect(stepComposer(HIDDEN, 1, m)).toEqual(DEFAULT_COMPOSER_SIZE);
  });

  it('shrinks back into the detent, then hides, then stays hidden', () => {
    const one = { hidden: false, height: m.baseText + COMPOSER_KEY_STEP_PX };
    expect(stepComposer(one, -1, m)).toEqual(DEFAULT_COMPOSER_SIZE);
    expect(stepComposer(DEFAULT_COMPOSER_SIZE, -1, m)).toEqual(HIDDEN);
    expect(stepComposer(HIDDEN, -1, m)).toEqual(HIDDEN);
  });

  it('a height saved on a smaller layout grows from THIS default', () => {
    expect(stepComposer({ hidden: false, height: 90 }, 1, m))
      .toEqual({ hidden: false, height: m.baseText + COMPOSER_KEY_STEP_PX });
  });
});

describe('the stored value', () => {
  it('round-trips and rejects junk', () => {
    expect(parseComposerSize('{"hidden":false,"height":240}')).toEqual({ hidden: false, height: 240 });
    expect(parseComposerSize('{"hidden":true,"height":null}')).toEqual(HIDDEN);
    expect(parseComposerSize(null)).toEqual(DEFAULT_COMPOSER_SIZE);
    expect(parseComposerSize('nope')).toEqual(DEFAULT_COMPOSER_SIZE);
    expect(parseComposerSize('{"height":-4,"hidden":"yes"}')).toEqual(DEFAULT_COMPOSER_SIZE);
  });
});
