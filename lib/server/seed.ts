import 'server-only';
import { migrationV2IfNeeded } from './migrationV2';
import { autoConnectAgentsIfNeeded } from './agent/autoConnect';
import { startTelegramBot } from './claude/telegram';

let initialized = false;
export function seedInitialData() {
  if (initialized) return;
  initialized = true;
  // One-shot data migration : legacy sessions left in 'active' state from the
  // pre-v2 architecture (one SSH-spawned bridge process per session, before
  // the charon-agent daemon) → 'sleeping'. The user re-sees them in the
  // sidebar with a resume button → recreated on the agent on demand. No-op
  // on fresh databases.
  migrationV2IfNeeded();
  // For each VPS: connect the AgentClient (background, non-blocking).
  // Then attempt a resume for sessions still 'active' (= active on the agent).
  autoConnectAgentsIfNeeded();
  // Poll Telegram (no-op if not configured, idempotent).
  startTelegramBot();
}
