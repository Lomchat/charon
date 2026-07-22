import 'server-only';
import { migrationV2IfNeeded } from './migrationV2';
import { migrateSessionIdsToHashed } from './auth';
import { autoConnectAgentsIfNeeded } from './agent/autoConnect';
import { startTelegramBot } from './claude/telegram';
import { armSdkAutoUpdate } from './claude/sdkWatch';
import { reconcileShellsOnBoot } from './shell/shellSession';

// ── Boot seed, retryable per sub-system (P1.6) ──────────────────────────────
// Since §14.45 this is the GUARANTEED agent-arming path (instrumentation.ts
// + the SSE/focus routes all call it). The old version latched a single
// `initialized` flag BEFORE running anything: a transient failure (e.g.
// SQLITE_BUSY in migrationV2 during a restart storm) was logged once and
// NEVER retried for the life of the process.
//
// Now each step keeps its own ok/pending state:
//   - a failed step is retried with exponential backoff (5s → 5min cap),
//     driven by a timer AND opportunistically by the next hot-path call;
//   - the hot path stays O(1) once everything is ok (single boolean check);
//   - every underlying step is idempotent (marker-gated migrations,
//     globalThis-guarded singletons), so re-running a succeeded step is
//     harmless anyway — the per-step state just avoids pointless work.
//
// The async step (shell reconcile) is marked ok optimistically to prevent a
// concurrent double-fire, and flipped back for retry if its promise rejects.

type Step = {
  name: string;
  run: () => void | Promise<unknown>;
};

const STEPS: Step[] = [
  // One-shot data migration: pre-v2 'active' sessions → 'sleeping' (no-op on
  // fresh / already-migrated DBs).
  { name: 'migrationV2', run: () => migrationV2IfNeeded() },
  // One-shot: rehash legacy plaintext session ids (marker-gated — existing
  // cookies stay valid, lookups hash the cookie value).
  { name: 'sessionIdHash', run: () => migrateSessionIdsToHashed() },
  // For each VPS: connect the AgentClient (background, non-blocking) + arm
  // the onStatus('connected')→reconcile self-healing hook. THE load-bearing
  // step (§14.45).
  { name: 'autoConnect', run: () => autoConnectAgentsIfNeeded() },
  // Prune persistent-shell rows whose remote shell is gone (best-effort,
  // per-VPS, non-blocking).
  { name: 'shellReconcile', run: () => reconcileShellsOnBoot() },
  // Poll Telegram (no-op if not configured, idempotent).
  { name: 'telegram', run: () => startTelegramBot() },
  // SDK freshness tick: PyPI latest + idle auto-update + notifications
  // (globalThis-guarded singleton, idempotent).
  { name: 'sdkWatch', run: () => armSdkAutoUpdate() },
];

const stepOk = new Set<string>();
let allOk = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = 5_000;
const RETRY_DELAY_MAX_MS = 5 * 60_000;

function scheduleRetry() {
  if (retryTimer || allOk) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_DELAY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    seedInitialData();
  }, delay);
  // Don't keep the process alive just for a seed retry.
  (retryTimer as any).unref?.();
}

export function seedInitialData() {
  if (allOk) return;
  for (const step of STEPS) {
    if (stepOk.has(step.name)) continue;
    try {
      const r = step.run();
      stepOk.add(step.name);
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        (r as Promise<unknown>).catch((e) => {
          console.error(`[seed] ${step.name} failed (async), will retry`, e);
          stepOk.delete(step.name);
          allOk = false;
          scheduleRetry();
        });
      }
    } catch (e) {
      console.error(`[seed] ${step.name} failed, will retry`, e);
    }
  }
  allOk = STEPS.every((s) => stepOk.has(s.name));
  if (allOk) {
    retryDelayMs = 5_000; // reset for a potential future async flip-back
  } else {
    scheduleRetry();
  }
}
