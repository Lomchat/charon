import 'server-only';
import { migrationV2IfNeeded } from './migrationV2';
import { autoConnectAgentsIfNeeded } from './agent/autoConnect';
import { startTelegramBot } from './claude/telegram';

let initialized = false;
export function seedInitialData() {
  if (initialized) return;
  initialized = true;
  // Migration data one-shot : sessions 'active' héritées de l'ancienne archi
  // (SessionWorker / bridge.py spawn par session) → 'sleeping'. Le user les
  // reverra dans la sidebar avec un bouton resume → recrée côté agent.
  migrationV2IfNeeded();
  // Pour chaque VPS : connecte l'AgentClient (background, non bloquant).
  // Puis tente un resume pour les sessions encore 'active' (= active sur agent).
  autoConnectAgentsIfNeeded();
  // Poll Telegram (no-op si non configuré, idempotent).
  startTelegramBot();
}
