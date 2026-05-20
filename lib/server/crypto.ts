import 'server-only';
import crypto from 'node:crypto';

// Canary plaintext used to verify that an AES key derived from MASTER_PASSWORD
// is correct (encrypted once at seed time in claudeSettings, decrypted on each
// boot). The name 'hub-key-v1' is historical — the codebase was previously
// called "hub". DO NOT rename without a migration plan: changing this constant
// breaks every existing deployment (web-push keys, encrypted settings, etc.
// would all fail to decrypt).
export const KEY_CHECK_PLAINTEXT = 'hub-key-v1';

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64')
  });
}

export function decrypt(blob: string, key: Buffer): string {
  const { iv, ct, tag } = JSON.parse(blob);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

export function tryDecrypt(blob: string, key: Buffer): string | null {
  try {
    return decrypt(blob, key);
  } catch {
    return null;
  }
}

export function keyPreview(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

export function tryKeyPreview(blob: string | null, key: Buffer | null): string | null {
  if (!blob || !key) return null;
  const v = tryDecrypt(blob, key);
  return v == null ? null : keyPreview(v);
}
