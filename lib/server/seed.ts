import 'server-only';
import { autoResumeIfNeeded } from './claude/autoResume';
import { startTelegramBot } from './claude/telegram';

let initialized = false;
export function seedInitialData() {
  if (initialized) return;
  initialized = true;
  // Reprise des sessions Claude actives au boot (idempotent côté worker pool).
  autoResumeIfNeeded();
  // Poll Telegram (no-op si non configuré, idempotent).
  startTelegramBot();
}
