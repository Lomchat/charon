import 'server-only';
import crypto from 'node:crypto';

// Env-derived AES-256 key: scrypt(MASTER_PASSWORD, MASTER_SALT). Single
// cached derivation shared by auth.ts (per-session key fallback) and
// settings.ts (at-rest encryption of secret settings, P0.7). Lives in its
// own tiny module because auth.ts already imports settings.ts (migration
// marker) — settings.ts importing auth.ts back would create a cycle.
//
// Returns null when the env is incomplete (never throws): callers degrade
// gracefully (settings fall back to plaintext-at-rest with a warning
// rather than bricking the hub).
let _cached: Buffer | null = null;

export function getEnvAesKey(): Buffer | null {
  if (_cached) return _cached;
  const pw = process.env.MASTER_PASSWORD;
  const salt = process.env.MASTER_SALT;
  if (!pw || !salt) return null;
  // STRICT salt validation (Codex 13.6): Buffer.from('zz…','hex') silently
  // drops non-hex characters — a typo'd salt would derive a key from an
  // EMPTY/truncated salt without any error. Refuse instead (callers treat
  // null as "no key" and fail loudly per their policy).
  if (!/^[0-9a-fA-F]{16,}$/.test(salt)) return null;
  try {
    _cached = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
    return _cached;
  } catch {
    return null;
  }
}
