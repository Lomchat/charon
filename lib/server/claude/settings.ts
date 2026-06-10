import 'server-only';
import { eq } from 'drizzle-orm';
import { db, claudeSettings } from '@/lib/db';

// `vapid.subject`: sender identity on the push servers side (web-push).
// We read `VAPID_SUBJECT` from env if present; otherwise generic fallback
// (the user can override from the SettingsModal in the UI). Avoids having
// a personal email hardcoded in plaintext in the repo.
const DEFAULTS = {
  'ssh.private_key_path': '/root/.ssh/id_rsa',
  'session.max_active': '10',
  'retention.killed_days': '30',
  'notif.global_enabled': 'true',
  // When a persistent shell goes active→idle after a "consequential" output
  // burst (see agent shell.py idle heuristic), Charon sends a push/telegram
  // "shell finished" notification. Gated by this flag AND notif.global_enabled.
  'shell.notify_idle': 'true',
  'vapid.subject': process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  'telegram.enabled': 'false',
  'telegram.bot_token': '',
  'telegram.chat_id': '',
  // Global defaults for Claude model / fallback / effort. Empty string =
  // not set → the agent passes nothing → SDK default applies.
  // New sessions inherit these unless overridden in NewSessionDialog.
  // Free-form strings (model IDs like 'claude-opus-4-7-...' /
  // 'claude-opus-4-8-...'). For effort, valid values are 'low', 'medium',
  // 'high', 'xhigh', 'max' (mirrors claude_agent_sdk.EffortLevel).
  'claude.default_model': '',
  'claude.default_fallback_model': '',
  'claude.default_effort': '',
  // Optional hub-side Anthropic API key (x-api-key). ONLY used to auto-sync
  // the model list from GET /v1/models — NOT for inference (sessions run via
  // the per-VPS Claude Code OAuth, untouched). Empty = no auto-sync; the
  // picker falls back to the curated seed in knownModels.ts + the custom-id
  // escape hatch. See lib/server/claude/modelSync.ts.
  'claude.api_key': '',
  // Internal cache written by modelSync (not user-editable via settings POST):
  // JSON array of the live model list, + the unix-ms timestamp of the last
  // successful sync (drives the 24h TTL).
  'claude.models_cache': '',
  'claude.models_cache_at': '',
} as const;
export type SettingKey = keyof typeof DEFAULTS | 'vapid.public' | 'vapid.private';

const g = globalThis as unknown as { _claudeSettingsCache?: Map<string, string> };
if (!g._claudeSettingsCache) g._claudeSettingsCache = new Map();
const cache: Map<string, string> = g._claudeSettingsCache;

export function getSetting(key: SettingKey): string | null {
  if (cache.has(key)) return cache.get(key)!;
  const [row] = db.select().from(claudeSettings).where(eq(claudeSettings.key, key)).all();
  if (row) {
    cache.set(key, row.value);
    return row.value;
  }
  const def = (DEFAULTS as any)[key] ?? null;
  if (def != null) cache.set(key, def);
  return def;
}

export function setSetting(key: SettingKey, value: string): void {
  const existing = db.select().from(claudeSettings).where(eq(claudeSettings.key, key)).all();
  if (existing.length > 0) {
    db.update(claudeSettings)
      .set({ value, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(claudeSettings.key, key)).run();
  } else {
    db.insert(claudeSettings).values({ key, value }).run();
  }
  cache.set(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = db.select().from(claudeSettings).all();
  const out: Record<string, string> = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function getSettingNumber(key: SettingKey, fallback = 0): number {
  const v = getSetting(key);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getSettingBool(key: SettingKey): boolean {
  return getSetting(key) === 'true';
}
