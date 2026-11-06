import { describe, expect, it } from 'vitest';
import { DeepLinkGuard } from '@/app/deepLinkGuard';

// §14.78: a `?session=`/`?shell=` link whose row never comes stays "awaited",
// and an awaited link keeps the URL and re-applied itself on every tab change:
// each tap on a session was overwritten by the dead link.
describe('DeepLinkGuard.giveUpIfMissing', () => {
  const arrive = (value: string) => {
    const guard = new DeepLinkGuard();
    expect(guard.consume(value)).toBe(true);
    return guard;
  };

  it('gives up at once when the list proves the target gone, and frees the URL', () => {
    const guard = arrive('dead');
    expect(guard.shouldDeferUrlSync('dead')).toBe(true);
    expect(guard.giveUpIfMissing('dead', null, true)).toBe(true);
    expect(guard.isAwaiting('dead')).toBe(false);
    expect(guard.shouldDeferUrlSync('dead')).toBe(false);
  });

  it('keeps waiting for a late row while the focus stays put', () => {
    const guard = arrive('late');
    expect(guard.giveUpIfMissing('late', 'tab-a', false)).toBe(false);
    expect(guard.giveUpIfMissing('late', 'tab-a', false)).toBe(false);
    expect(guard.isAwaiting('late')).toBe(true);
  });

  it('gives up as soon as the user moves to another tab', () => {
    const guard = arrive('dead');
    expect(guard.giveUpIfMissing('dead', 'tab-a', false)).toBe(false);
    expect(guard.giveUpIfMissing('dead', 'tab-b', false)).toBe(true);
    expect(guard.isAwaiting('dead')).toBe(false);
  });

  it('counts "no tab" as a focus: opening the first tab supersedes the link', () => {
    const guard = arrive('dead');
    expect(guard.giveUpIfMissing('dead', null, false)).toBe(false);
    expect(guard.giveUpIfMissing('dead', 'tab-a', false)).toBe(true);
  });

  it('does not carry the focus of an earlier link over to a new one', () => {
    const guard = arrive('first');
    guard.giveUpIfMissing('first', 'tab-a', false);
    expect(guard.consume('second')).toBe(true);
    expect(guard.giveUpIfMissing('second', 'tab-b', false)).toBe(false);
    expect(guard.isAwaiting('second')).toBe(true);
  });

  it('ignores a target it is not waiting for', () => {
    const guard = arrive('a');
    expect(guard.giveUpIfMissing('b', null, true)).toBe(false);
    expect(guard.isAwaiting('a')).toBe(true);
  });
});
