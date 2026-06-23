import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';

// crypto.ts starts with `import 'server-only'`, a marker module that only
// exists inside the Next.js bundler (not in node_modules). Stub it so the
// module can be imported under the plain Node/vitest environment.
vi.mock('server-only', () => ({}));

import {
  encrypt,
  decrypt,
  tryDecrypt,
  keyPreview,
  tryKeyPreview,
  KEY_CHECK_PLAINTEXT,
} from './crypto';

// Mirror of how auth.ts derives the AES key from MASTER_PASSWORD/MASTER_SALT
// (crypto.scryptSync(pw, salt, 32)). crypto.ts itself takes a Buffer key, so
// we derive one here to exercise the real round-trip end to end.
function deriveKey(password: string, salt: string): Buffer {
  return crypto.scryptSync(password, salt, 32);
}

const PASSWORD = 'correct horse battery staple';
const SALT = 'charon-test-salt-7f3a';
const SECRET = 'sk-ant-super-secret-api-key-9000';

describe('crypto: scrypt key derivation (auth.ts primitive)', () => {
  it('is deterministic for the same (password, salt)', () => {
    const a = deriveKey(PASSWORD, SALT);
    const b = deriveKey(PASSWORD, SALT);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it('differs for a different salt (same password)', () => {
    const a = deriveKey(PASSWORD, SALT);
    const b = deriveKey(PASSWORD, SALT + '-other');
    expect(a.equals(b)).toBe(false);
  });

  it('differs for a different password (same salt)', () => {
    const a = deriveKey(PASSWORD, SALT);
    const b = deriveKey(PASSWORD + '!', SALT);
    expect(a.equals(b)).toBe(false);
  });
});

describe('crypto: encrypt / decrypt round-trip', () => {
  const key = deriveKey(PASSWORD, SALT);

  it('returns the original plaintext', () => {
    const blob = encrypt(SECRET, key);
    expect(decrypt(blob, key)).toBe(SECRET);
  });

  it('round-trips an empty string', () => {
    const blob = encrypt('', key);
    expect(decrypt(blob, key)).toBe('');
  });

  it('round-trips unicode / multibyte content', () => {
    const text = 'héllo — 日本語 — 🔐 αβγ';
    const blob = encrypt(text, key);
    expect(decrypt(blob, key)).toBe(text);
  });

  it('produces a JSON blob with base64 iv/ct/tag and a 12-byte iv', () => {
    const blob = encrypt(SECRET, key);
    const parsed = JSON.parse(blob) as { iv: string; ct: string; tag: string };
    expect(typeof parsed.iv).toBe('string');
    expect(typeof parsed.ct).toBe('string');
    expect(typeof parsed.tag).toBe('string');
    // GCM nonce is 12 bytes, auth tag is 16 bytes.
    expect(Buffer.from(parsed.iv, 'base64').length).toBe(12);
    expect(Buffer.from(parsed.tag, 'base64').length).toBe(16);
  });
});

describe('crypto: random IV', () => {
  const key = deriveKey(PASSWORD, SALT);

  it('two encryptions of the same plaintext differ but both decrypt', () => {
    const blobA = encrypt(SECRET, key);
    const blobB = encrypt(SECRET, key);

    // Random 12-byte IV => different blobs (incl. different ciphertext bytes).
    expect(blobA).not.toBe(blobB);
    const a = JSON.parse(blobA);
    const b = JSON.parse(blobB);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);

    // Yet both recover the original plaintext.
    expect(decrypt(blobA, key)).toBe(SECRET);
    expect(decrypt(blobB, key)).toBe(SECRET);
  });
});

describe('crypto: GCM tamper detection', () => {
  const key = deriveKey(PASSWORD, SALT);

  function flipFirstByteB64(b64: string): string {
    const buf = Buffer.from(b64, 'base64');
    buf[0] ^= 0xff;
    return buf.toString('base64');
  }

  it('decrypt throws when the ciphertext is modified', () => {
    const parsed = JSON.parse(encrypt(SECRET, key));
    parsed.ct = flipFirstByteB64(parsed.ct);
    expect(() => decrypt(JSON.stringify(parsed), key)).toThrow();
  });

  it('decrypt throws when the auth tag is modified', () => {
    const parsed = JSON.parse(encrypt(SECRET, key));
    parsed.tag = flipFirstByteB64(parsed.tag);
    expect(() => decrypt(JSON.stringify(parsed), key)).toThrow();
  });

  it('decrypt throws when the IV is modified', () => {
    const parsed = JSON.parse(encrypt(SECRET, key));
    parsed.iv = flipFirstByteB64(parsed.iv);
    expect(() => decrypt(JSON.stringify(parsed), key)).toThrow();
  });

  it('decrypt throws under the wrong key', () => {
    const blob = encrypt(SECRET, key);
    const wrongKey = deriveKey(PASSWORD, SALT + '-wrong');
    expect(() => decrypt(blob, wrongKey)).toThrow();
  });
});

describe('crypto: tryDecrypt', () => {
  const key = deriveKey(PASSWORD, SALT);

  it('returns the plaintext on success', () => {
    const blob = encrypt(SECRET, key);
    expect(tryDecrypt(blob, key)).toBe(SECRET);
  });

  it('returns null instead of throwing on a tampered blob', () => {
    const parsed = JSON.parse(encrypt(SECRET, key));
    const buf = Buffer.from(parsed.tag, 'base64');
    buf[0] ^= 0xff;
    parsed.tag = buf.toString('base64');
    expect(tryDecrypt(JSON.stringify(parsed), key)).toBeNull();
  });

  it('returns null on malformed (non-JSON) input', () => {
    expect(tryDecrypt('not-json', key)).toBeNull();
  });

  it('returns null under the wrong key', () => {
    const blob = encrypt(SECRET, key);
    const wrongKey = deriveKey(PASSWORD + 'x', SALT);
    expect(tryDecrypt(blob, wrongKey)).toBeNull();
  });
});

describe('crypto: keyPreview', () => {
  it('returns the value unchanged when length <= 12', () => {
    expect(keyPreview('')).toBe('');
    expect(keyPreview('short')).toBe('short');
    expect(keyPreview('exactly12chr')).toBe('exactly12chr'); // 12 chars
  });

  it('masks the middle for values longer than 12 chars', () => {
    const v = 'sk-ant-abcdefghijklmnop-XYZ123';
    const preview = keyPreview(v);
    expect(preview).toBe('sk-ant…XYZ123');
    expect(preview).toContain('…');
    expect(preview.startsWith(v.slice(0, 6))).toBe(true);
    expect(preview.endsWith(v.slice(-6))).toBe(true);
  });
});

describe('crypto: tryKeyPreview', () => {
  const key = deriveKey(PASSWORD, SALT);

  it('returns a masked preview of the decrypted secret', () => {
    const blob = encrypt(SECRET, key);
    expect(tryKeyPreview(blob, key)).toBe(keyPreview(SECRET));
  });

  it('returns null when blob is null', () => {
    expect(tryKeyPreview(null, key)).toBeNull();
  });

  it('returns null when key is null', () => {
    const blob = encrypt(SECRET, key);
    expect(tryKeyPreview(blob, null)).toBeNull();
  });

  it('returns null when decryption fails (wrong key)', () => {
    const blob = encrypt(SECRET, key);
    const wrongKey = deriveKey('nope', SALT);
    expect(tryKeyPreview(blob, wrongKey)).toBeNull();
  });
});

describe('crypto: KEY_CHECK_PLAINTEXT canary', () => {
  it('is the historical constant and round-trips like any secret', () => {
    expect(KEY_CHECK_PLAINTEXT).toBe('hub-key-v1');
    const key = deriveKey(PASSWORD, SALT);
    const blob = encrypt(KEY_CHECK_PLAINTEXT, key);
    expect(decrypt(blob, key)).toBe('hub-key-v1');
    // A wrong key must fail the canary check (this is exactly how boot
    // verifies the derived master key is correct).
    const wrongKey = deriveKey(PASSWORD, 'different-salt');
    expect(tryDecrypt(blob, wrongKey)).toBeNull();
  });
});
