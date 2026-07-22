import 'server-only';
import { migrationV2IfNeeded } from './migrationV2';
import { migrateSessionIdsToHashed } from './auth';
import { autoConnectAgentsIfNeeded } from './agent/autoConnect';
import { startTelegramBot } from './claude/telegram';
import { armSdkAutoUpdate } from './claude/sdkWatch';
import { reconcileShellsOnBoot } from './shell/shellSession';

let initialized = false;
export function seedInitialData() {
  if (initialized) return;
  initialized = true;
  // Each step is INDEPENDENTLY guarded. Since §14.45 this is the GUARANTEED
  // agent-arming path (instrumentation.ts + the SSE route both call it), so a
  // throw in one step — e.g. a SQLITE_BUSY in migrationV2 during a restart
  // storm (WAL contention with the agent writes / the just-started Telegram
  // poll) — must NOT abort autoConnectAgentsIfNeeded() and strand the process
  // agentless for good (the exact "frozen until F5" this guarantees against);
  // `initialized` is already latched, so there'd be no in-process retry.
  // One-shot data migration: pre-v2 'active' sessions → 'sleeping' (no-op on
  // fresh / already-migrated DBs).
  try { migrationV2IfNeeded(); } catch (e) { console.error('[seed] migrationV2 failed', e); }
  // One-shot: rehash legacy plaintext session ids (marker-gated, idempotent —
  // existing cookies stay valid, lookups hash the cookie value).
  try { migrateSessionIdsToHashed(); } catch (e) { console.error('[seed] session-id hashing failed', e); }
  // For each VPS: connect the AgentClient (background, non-blocking) + arm the
  // onStatus('connected')→reconcile self-healing hook. THE load-bearing step.
  try { autoConnectAgentsIfNeeded(); } catch (e) { console.error('[seed] autoConnect failed', e); }
  // Prune persistent-shell rows whose remote shell is gone (best-effort,
  // per-VPS, non-blocking).
  try { reconcileShellsOnBoot().catch(() => {}); } catch (e) { console.error('[seed] shell reconcile failed', e); }
  // Poll Telegram (no-op if not configured, idempotent).
  try { startTelegramBot(); } catch (e) { console.error('[seed] telegram failed', e); }
  // SDK freshness tick: PyPI latest + idle auto-update + notifications
  // (globalThis-guarded singleton, idempotent).
  try { armSdkAutoUpdate(); } catch (e) { console.error('[seed] sdk watch failed', e); }
}
