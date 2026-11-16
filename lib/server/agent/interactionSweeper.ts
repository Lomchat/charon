import 'server-only';
import { sweepExpiredInteractions } from './sessionOps';
import { timeSection } from '@/lib/server/perf/loopLag';

// The hub-side backstop for gate deadlines (C07, §14.98). The in-process
// expiry timers (`SessionStream._scheduleInteractionExpiry`) die with the hub
// and are not re-armed for gates persisted before a restart, and the GET/SSE
// sweeps only run when a browser asks — so an expired card could stay "needs
// you" on every open tab. Every 30 s this expires due gates and PUBLISHES each
// `expired` (sessionOps § sweepExpiredInteractions). Async questions have no
// deadline and are never swept.

export const INTERACTION_SWEEP_MS = 30_000;

type SweeperState = { timer: ReturnType<typeof setInterval> | null };

// ONE timer per process (§14.106 / I3): with module copies (tests' `vi.resetModules()`, dev rebuilds), a module-level
// `let` would arm one sweeper per copy.
const g = globalThis as typeof globalThis & { __charonSweeper?: SweeperState };

function state(): SweeperState {
  return g.__charonSweeper ??= { timer: null };
}

/** Arm the periodic sweep (idempotent across module copies; `unref`: never
 *  keeps the process alive). Started from autoConnect's boot. */
export function startInteractionSweeper(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => {
    try {
      timeSection('sweep', () => sweepExpiredInteractions());
    } catch (e) {
      console.warn('[sweep] interaction sweep failed:', (e as Error)?.message ?? e);
    }
  }, INTERACTION_SWEEP_MS);
  s.timer.unref?.();
}

/** Disarm (tests, shutdown). */
export function stopInteractionSweeper(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}
