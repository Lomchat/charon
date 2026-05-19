import 'server-only';
import { eq } from 'drizzle-orm';
import { db, claudeSettings } from '@/lib/db';

// `vapid.subject` : identité de l'expéditeur côté serveurs push (web-push).
// On lit `VAPID_SUBJECT` côté env si présent ; sinon fallback générique
// (l'utilisateur peut overrider depuis le SettingsModal de l'UI). Évite
// d'avoir un email personnel hardcodé en clair dans le repo.
const DEFAULTS = {
  'ssh.private_key_path': '/root/.ssh/id_rsa',
  'session.max_active': '10',
  'retention.killed_days': '30',
  'notif.global_enabled': 'true',
  'vapid.subject': process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  'telegram.enabled': 'false',
  'telegram.bot_token': '',
  'telegram.chat_id': '',
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
