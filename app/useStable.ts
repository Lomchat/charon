'use client';
import { useCallback, useRef } from 'react';

// Identity helpers for props that cross a memo boundary (§14.38). A parent
// that passes an inline arrow or a freshly mapped array re-renders every
// memoized child below it — the whole chat, the tool panel, every sidebar
// card. These keep ONE identity for as long as the meaning is the same.

/** A stable function that always calls the LATEST `fn` (read at call time:
 *  event handlers only, never during render). */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/** `useStableCallback` for an OPTIONAL prop: undefined stays undefined (a
 *  child may render differently without it), defined keeps one identity. */
export function useStableOptionalCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined {
  const ref = useRef(fn);
  ref.current = fn;
  const stable = useCallback((...args: A) => ref.current!(...args), []);
  return fn ? stable : undefined;
}

/** The latest `value` in a ref-like box, for handlers and effects that
 *  subscribe once (read at call time, never during render). Kept out of the
 *  components on purpose: the React Compiler compiles a component that only
 *  READS `.current` in callbacks, never one that writes it while rendering. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** `keys` in the order each first appeared (a key keeps its place while it
 *  stays): mount order for panes React must never move (a re-inserted iframe
 *  reloads). Same order ⇒ the previous array. */
export function useMountOrder(keys: readonly string[]): readonly string[] {
  const seqRef = useRef(new Map<string, number>());
  const prevRef = useRef<readonly string[]>([]);
  const seq = seqRef.current;
  for (const k of [...seq.keys()]) if (!keys.includes(k)) seq.delete(k);
  let next = Math.max(0, ...seq.values()) + 1;
  for (const k of keys) if (!seq.has(k)) seq.set(k, next++);
  const sorted = [...keys].sort((a, b) => seq.get(a)! - seq.get(b)!);
  const prev = prevRef.current;
  if (sorted.length === prev.length && sorted.every((k, i) => k === prev[i])) return prev;
  prevRef.current = sorted;
  return sorted;
}

/** The last `n` distinct non-null values `id` took (the current one
 *  included), in MOUNT order (useMountOrder): the set a keep-alive layer
 *  renders, never reshuffled by recency. */
export function useKeptAlive(id: string | null, n: number): readonly string[] {
  const lruRef = useRef<string[]>([]);
  if (id && lruRef.current[0] !== id) lruRef.current = [id, ...lruRef.current.filter((x) => x !== id)].slice(0, n);
  return useMountOrder(lruRef.current);
}

/** The previous value while `equal(previous, next)`: a rebuilt-but-identical
 *  array or object keeps its identity. */
export function useStableValue<T>(value: T, equal: (a: T, b: T) => boolean): T {
  const ref = useRef(value);
  if (ref.current !== value && !equal(ref.current, value)) ref.current = value;
  return ref.current;
}

/** Same length, same fields, element by element (one level deep). */
export function shallowEqualRows<T extends object>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Record<string, unknown>;
    const y = b[i] as Record<string, unknown>;
    if (x === y) continue;
    const kx = Object.keys(x);
    if (kx.length !== Object.keys(y).length) return false;
    for (const k of kx) if (x[k] !== y[k]) return false;
  }
  return true;
}
