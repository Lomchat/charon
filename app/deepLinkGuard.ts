/**
 * Separates URL values written by Charon from genuine deep-link navigation.
 *
 * Next's patched history API updates `useSearchParams()` after replaceState.
 * That update is asynchronous relative to the workspace-tab store, so both
 * the old and new query values can be observed while an internal selection is
 * settling. Re-consuming either value as an external deep link can reopen the
 * tab we just left and create a permanent A/B focus loop.
 */
export class DeepLinkGuard {
  private handled: string | null = null;
  private internalValues = new Set<string | null>();
  private internalTarget: string | null = null;
  private hasInternalTarget = false;
  private externalTarget: string | null = null;

  /** Call immediately before replaceState writes this query parameter. */
  markInternal(target: string | null): void {
    // Preserve every value in a chain A -> B -> C. useSearchParams may still
    // publish B after C has already become the real internal target.
    this.internalValues.add(this.handled);
    this.internalValues.add(target);
    this.internalTarget = target;
    this.hasInternalTarget = true;
    this.externalTarget = null;
  }

  /** True only when `value` represents a new external navigation intent. */
  consume(value: string | null): boolean {
    if (this.hasInternalTarget && this.internalValues.has(value)) {
      if (value === this.internalTarget) {
        this.handled = value;
        this.internalValues.clear();
        this.hasInternalTarget = false;
      }
      return false;
    }

    // A value outside the pending internal chain is a real navigation (for
    // example router.push from a notification) and supersedes that chain.
    this.internalValues.clear();
    this.hasInternalTarget = false;

    if (value === null) {
      this.handled = null;
      this.externalTarget = null;
      return false;
    }
    if (this.handled === value) return false;
    this.handled = value;
    this.externalTarget = value;
    return true;
  }

  /** External target that has been consumed but has not become active yet. */
  isAwaiting(value: string | null): boolean {
    return value !== null && this.externalTarget === value;
  }

  /** Mark an external target as reflected by the active workspace tab. */
  settle(value: string | null): void {
    if (this.externalTarget === value) this.externalTarget = null;
  }

  /** Do not overwrite a deep link while its tab mutation is still settling. */
  shouldDeferUrlSync(value: string | null): boolean {
    return value !== null && this.externalTarget === value;
  }
}
