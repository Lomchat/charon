// A promise's settlement as a VALUE, for components' async handlers: the
// React Compiler cannot compile a component holding a `try … finally`, a
// `throw` inside a `try`, or a `try` without `catch` (vite.config.ts, §14.38),
// so a handler awaits `outcome(work)` and branches instead.

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string; error: unknown };

/** `fallback` given: an Error's message, else `fallback` (a thrown string or
 *  object has nothing to show). Absent: `String(e.message || e)`. */
export function outcome<T>(p: Promise<T>, fallback?: string): Promise<Outcome<T>> {
  return p.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (e: unknown): Outcome<T> => ({
      ok: false,
      error: e,
      message: fallback === undefined
        ? String((e as { message?: unknown } | null)?.message || e)
        : e instanceof Error ? e.message : fallback,
    }),
  );
}

/** Runs `work`, whatever it throws: the work's own promise never rejects. */
export function settled(work: () => Promise<unknown>): Promise<void> {
  return Promise.resolve().then(work).then(() => {}, () => {});
}
