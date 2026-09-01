import { describe, expect, it } from 'vitest';
import { DeepLinkGuard } from '../app/deepLinkGuard';

describe('DeepLinkGuard', () => {
  it('does not turn an internal A to B URL sync back into navigation', () => {
    const guard = new DeepLinkGuard();
    expect(guard.consume('session-a')).toBe(true);

    guard.markInternal('session-b');
    // React can still render the old useSearchParams snapshot first.
    expect(guard.consume('session-a')).toBe(false);
    // Then Next publishes the value written through replaceState.
    expect(guard.consume('session-b')).toBe(false);

    // A later, genuine link back to A remains navigable.
    expect(guard.consume('session-a')).toBe(true);
  });

  it('suppresses every intermediate value in a rapid internal chain', () => {
    const guard = new DeepLinkGuard();
    expect(guard.consume('session-a')).toBe(true);

    guard.markInternal('session-b');
    guard.markInternal('session-c');
    expect(guard.consume('session-a')).toBe(false);
    expect(guard.consume('session-b')).toBe(false);
    expect(guard.consume('session-c')).toBe(false);
  });

  it('lets an external navigation supersede a pending internal sync', () => {
    const guard = new DeepLinkGuard();
    expect(guard.consume('session-a')).toBe(true);
    guard.markInternal('session-b');

    expect(guard.consume('session-from-notification')).toBe(true);
    expect(guard.shouldDeferUrlSync('session-from-notification')).toBe(true);
    expect(guard.consume('session-from-notification')).toBe(false);
    guard.settle('session-from-notification');
    expect(guard.shouldDeferUrlSync('session-from-notification')).toBe(false);
  });

  it('handles clearing and reopening the same deep link', () => {
    const guard = new DeepLinkGuard();
    expect(guard.consume('session-a')).toBe(true);
    guard.markInternal(null);
    expect(guard.consume('session-a')).toBe(false);
    expect(guard.consume(null)).toBe(false);
    expect(guard.consume('session-a')).toBe(true);
  });
});
