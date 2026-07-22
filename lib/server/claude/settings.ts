import 'server-only';
import { eq } from 'drizzle-orm';
import { db, claudeSettings } from '@/lib/db';
import { encrypt, tryDecrypt } from '@/lib/server/crypto';
import { getEnvAesKey } from '@/lib/server/masterKey';

// ── At-rest encryption of secret settings (P0.7) ────────────────────────────
// Secret values are stored as `enc:v1:<aes-256-gcm blob>` (key = scrypt of
// MASTER_PASSWORD+MASTER_SALT, cf. masterKey.ts). Encryption/decryption is
// TRANSPARENT here: every consumer keeps reading plaintext via getSetting.
// The versioned prefix makes migration idempotent (a plaintext row is
// re-encrypted at boot by encryptSecretsAtRest; an encrypted one is left
// alone) and leaves room for a future v2. If the env key is missing we
// degrade to plaintext-at-rest with a warning — a misconfigured env must
// never brick the hub. CHANGING MASTER_PASSWORD/MASTER_SALT without
// re-encrypting loses these values (README § About MASTER_PASSWORD): the
// decrypt fails closed → getSetting returns '' and the UI shows the secret
// as unconfigured (re-enter it to recover).
const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  'telegram.bot_token',
  'claude.api_key',
  'vapid.private',
]);
const ENC_PREFIX = 'enc:v1:';
let warnedNoKey = false;

function encryptForRest(value: string): string {
  if (!value) return value;
  const key = getEnvAesKey();
  if (!key) {
    // Fail-CLOSED in production (Codex 13.6): "encrypted at rest" is only a
    // guarantee if a missing/invalid key refuses the write — the settings
    // POST surfaces the error to the operator instead of silently storing
    // plaintext. Dev stays fail-open (plaintext + loud warning) so a bare
    // checkout keeps working.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('cannot store secret: MASTER_PASSWORD/MASTER_SALT missing or MASTER_SALT is not valid hex');
    }
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.error('[settings] MASTER_PASSWORD/MASTER_SALT missing — secret settings stored in PLAINTEXT (dev only)');
    }
    return value;
  }
  return ENC_PREFIX + encrypt(value, key);
}

function decryptFromRest(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const key = getEnvAesKey();
  const pt = key ? tryDecrypt(stored.slice(ENC_PREFIX.length), key) : null;
  if (pt == null) {
    console.error('[settings] failed to decrypt a secret setting (MASTER_PASSWORD/MASTER_SALT changed?) — treating as unset');
    return '';
  }
  return pt;
}

// `vapid.subject`: sender identity on the push servers side (web-push).
// We read `VAPID_SUBJECT` from env if present; otherwise generic fallback
// (the user can override from the SettingsModal in the UI). Avoids having
// a personal email hardcoded in plaintext in the repo.
const DEFAULTS = {
  'ssh.private_key_path': '/root/.ssh/id_rsa',
  // NOTE: session.max_active / retention.killed_days were REMOVED (P1.7) —
  // they were exposed in the UI but had zero runtime consumers (decorative
  // settings). Re-add only WITH an implementation.
  'notif.global_enabled': 'true',
  // When a persistent shell goes active→idle after a "consequential" output
  // burst (see agent shell.py idle heuristic), Charon sends a push/telegram
  // "shell finished" notification. Gated by this flag AND notif.global_enabled.
  'shell.notify_idle': 'true',
  'vapid.subject': process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  'telegram.enabled': 'false',
  'telegram.bot_token': '',
  'telegram.chat_id': '',
  // Public base URL of this hub (e.g. https://charon.example.com), used to
  // build absolute deep-links in Telegram messages (the hub only binds to
  // HOST:PORT locally and has no idea of its public origin). Empty = no link
  // appended. Trailing slash is tolerated (stripped when building links).
  'app.public_url': '',
  // Global defaults for Claude model / fallback / effort. Empty string =
  // not set → the agent passes nothing → SDK default applies.
  // New sessions inherit these unless overridden in NewSessionDialog.
  // Free-form strings (model IDs like 'claude-opus-4-7-...' /
  // 'claude-opus-4-8-...'). For effort, valid values are 'low', 'medium',
  // 'high', 'xhigh', 'max' (mirrors claude_agent_sdk.EffortLevel).
  'claude.default_model': '',
  'claude.default_fallback_model': '',
  'claude.default_effort': '',
  // Global defaults for Codex model / effort (multi-agent support). Empty
  // string = not set → the agent passes nothing → Codex default applies. New
  // Codex-kind sessions inherit these unless overridden at create time. Codex
  // has NO fallback-model concept (parallel to claude.default_fallback_model
  // being unused for Codex). Valid effort values: 'none' | 'minimal' | 'low' |
  // 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'. cf. migration-codex.md.
  'codex.default_model': '',
  'codex.default_effort': '',
  // Fleet-wide openai-codex auto-update toggle (parallel to sdk.auto_update).
  // ON by default. User-editable (SettingsModal). cf. codexWatch (future).
  'codex.auto_update': 'true',
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
  // Auto-update the `claude-agent-sdk` python package on fleet VPSes when a
  // newer PyPI version is known AND the VPS is idle (no active session, no
  // pending interaction). ON by default — the SDK bundles the Claude Code CLI
  // that actually runs the sessions, and a stale one causes real bugs (model
  // attribution, missing features). User-editable (SettingsModal toggle).
  // cf. lib/server/claude/sdkWatch.ts / sdkSync.ts.
  'sdk.auto_update': 'true',
  // Internal, written by sdkSync only (not in the settings POST allowlist):
  // latest claude-agent-sdk version on PyPI + unix-ms of the last successful
  // check (12h TTL), + the last version we sent a "new SDK version" Telegram/
  // push notification for (dedup across ticks/restarts).
  'sdk.latest_version': '',
  'sdk.latest_version_at': '',
  'sdk.last_notified_version': '',
  // Internal, written by the codex freshness sync only (not in the settings
  // POST allowlist): latest openai-codex version on PyPI + unix-ms of the last
  // successful check. Parallel to sdk.latest_version(_at). cf. codexWatch.
  'codex.latest_version': '',
  'codex.latest_version_at': '',
  // Last openai-codex version we sent a "new codex" notification for (dedup
  // across ticks/restarts), parallel to sdk.last_notified_version.
  'codex.last_notified_version': '',
  // Last locally-built pyz sha we sent a "new agent" notification for — dedup
  // for the pyz auto-update axis (sdkWatch.ts), parallel to last_notified_version.
  'agent.last_notified_pyz_sha': '',
} as const;
export type SettingKey = keyof typeof DEFAULTS | 'vapid.public' | 'vapid.private';

const g = globalThis as unknown as { _claudeSettingsCache?: Map<string, string> };
if (!g._claudeSettingsCache) g._claudeSettingsCache = new Map();
const cache: Map<string, string> = g._claudeSettingsCache;

export function getSetting(key: SettingKey): string | null {
  // Cache holds PLAINTEXT (memory only — the at-rest protection targets the
  // DB file and its backups, not this process's heap).
  if (cache.has(key)) return cache.get(key)!;
  const [row] = db.select().from(claudeSettings).where(eq(claudeSettings.key, key)).all();
  if (row) {
    const v = SECRET_SETTING_KEYS.has(key) ? decryptFromRest(row.value) : row.value;
    cache.set(key, v);
    return v;
  }
  const def = (DEFAULTS as any)[key] ?? null;
  if (def != null) cache.set(key, def);
  return def;
}

export function setSetting(key: SettingKey, value: string): void {
  const stored = SECRET_SETTING_KEYS.has(key) ? encryptForRest(value) : value;
  const existing = db.select().from(claudeSettings).where(eq(claudeSettings.key, key)).all();
  if (existing.length > 0) {
    db.update(claudeSettings)
      .set({ value: stored, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(claudeSettings.key, key)).run();
  } else {
    db.insert(claudeSettings).values({ key, value: stored }).run();
  }
  cache.set(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = db.select().from(claudeSettings).all();
  const out: Record<string, string> = { ...DEFAULTS };
  for (const r of rows) {
    out[r.key] = SECRET_SETTING_KEYS.has(r.key) ? decryptFromRest(r.value) : r.value;
  }
  return out;
}

/** One-shot boot migration (idempotent by prefix): re-write any secret
 *  setting still stored in plaintext as `enc:v1:...`. Seed-armed. */
export function encryptSecretsAtRest(): void {
  const key = getEnvAesKey();
  if (!key) return; // degraded env — nothing we can do, warning printed on write
  for (const k of SECRET_SETTING_KEYS) {
    const [row] = db.select().from(claudeSettings).where(eq(claudeSettings.key, k)).all();
    if (!row || !row.value || row.value.startsWith(ENC_PREFIX)) continue;
    db.update(claudeSettings)
      .set({ value: ENC_PREFIX + encrypt(row.value, key), updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(claudeSettings.key, k)).run();
    cache.set(k, row.value);
    console.log(`[settings] encrypted ${k} at rest`);
  }
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
