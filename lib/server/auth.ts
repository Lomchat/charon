import 'server-only';
import crypto from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { db, users, sessions } from '@/lib/db';
// Plain CJS so server.js (WS-upgrade auth) shares the exact same hashing.
import { hashSessionToken } from './sessionHash.js';
import { getSetting, setSetting } from './claude/settings';

const SESSION_TTL_SECS = 24 * 60 * 60; // 24h sliding inactivity

// AES key derived from MASTER_PASSWORD + MASTER_SALT — shared, cached
// derivation in masterKey.ts (also used by settings.ts for at-rest
// encryption of secret settings).
import { getEnvAesKey } from './masterKey';
const SESSION_KEYS = new Map<string, Buffer>();

export const SESSION_COOKIE = 'charon_session';
export const SESSION_TTL_MS = SESSION_TTL_SECS * 1000;

function masterPassword(): string {
  const v = process.env.MASTER_PASSWORD;
  if (!v) throw new Error('MASTER_PASSWORD not set in .env');
  return v;
}

function masterSalt(): Buffer {
  const v = process.env.MASTER_SALT;
  if (!v) throw new Error('MASTER_SALT not set in .env');
  return Buffer.from(v, 'hex');
}

export function deriveMasterKey(): Buffer {
  return crypto.scryptSync(masterPassword(), masterSalt(), 32);
}

export function checkPassword(input: string): boolean {
  const expected = Buffer.from(masterPassword(), 'utf8');
  const actual = Buffer.from(input, 'utf8');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function newSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ── Token hashing ───────────────────────────────────────────────────────────
// The cookie holds the RAW token; the DB row id is HMAC-SHA256(SESSION_SECRET,
// token) — see sessionHash.js. Public helpers below all take the RAW cookie
// value and hash internally; only the returned session ROW carries the hashed
// id (which is what SESSION_KEYS and server.js also key on).

/** In-memory map: HASHED session id → per-login AES key. */
export function setSessionKey(rawToken: string, key: Buffer) {
  SESSION_KEYS.set(hashSessionToken(rawToken), key);
}
export function getSessionKey(hashedSessionId: string): Buffer | null {
  // Fall back to env-derived key when session map is empty
  // (e.g. after a server restart while user's cookie is still valid).
  return SESSION_KEYS.get(hashedSessionId) ?? getEnvAesKey();
}
function dropSessionKeyByHash(hashedSessionId: string) {
  SESSION_KEYS.delete(hashedSessionId);
}

let _userId: number | null = null;
export async function ensureUser(): Promise<number> {
  if (_userId !== null) return _userId;
  const [first] = db.select().from(users).limit(1).all();
  if (first) {
    _userId = first.id;
    return first.id;
  }
  const [created] = db
    .insert(users)
    .values({ passwordHash: 'env', passwordSalt: 'env', keyCheck: 'env' })
    .returning()
    .all();
  _userId = created.id;
  return created.id;
}

/** Returns the RAW token (cookie value) — the DB stores only its hash. */
export async function createSession() {
  const id = newSessionId();
  const userId = await ensureUser();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECS;
  db.insert(sessions).values({ id: hashSessionToken(id), userId, expiresAt }).run();
  return { id, expiresAt };
}

/** Look up a session by RAW cookie token. Returned row's `id` is the HASH. */
export async function getSession(rawToken: string) {
  const hashed = hashSessionToken(rawToken);
  const [s] = db.select().from(sessions).where(eq(sessions.id, hashed)).all();
  if (!s) return null;
  if (s.expiresAt < Math.floor(Date.now() / 1000)) {
    db.delete(sessions).where(eq(sessions.id, hashed)).run();
    dropSessionKeyByHash(hashed);
    return null;
  }
  return s;
}

export async function touchSession(rawToken: string) {
  const newExpiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECS;
  db.update(sessions).set({ expiresAt: newExpiry })
    .where(eq(sessions.id, hashSessionToken(rawToken))).run();
  return newExpiry;
}

export async function dropSession(rawToken: string) {
  const hashed = hashSessionToken(rawToken);
  db.delete(sessions).where(eq(sessions.id, hashed)).run();
  dropSessionKeyByHash(hashed);
}

export async function cleanupExpiredSessions() {
  const now = Math.floor(Date.now() / 1000);
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  // Prune in-memory AES keys whose session row is gone (expired without
  // ever being presented again, or deleted elsewhere) — P1.5 leftover.
  if (SESSION_KEYS.size > 0) {
    const live = new Set(db.select({ id: sessions.id }).from(sessions).all().map((r) => r.id));
    for (const id of SESSION_KEYS.keys()) {
      if (!live.has(id)) SESSION_KEYS.delete(id);
    }
  }
}

// ── One-shot migration: plaintext session ids → hashed ─────────────────────
// Pre-2026-07 rows stored the raw cookie token as `sessions.id`. Rehash them
// in place so existing browser cookies stay valid (lookup hashes the cookie,
// so hash(old raw id) matches). Idempotence is enforced by a marker in
// claude_settings — raw and hashed ids are both 64-hex, indistinguishable by
// format, so NEVER run this twice (double-hash = everyone logged out).
export function migrateSessionIdsToHashed() {
  const MARKER = 'auth.session_ids_hashed' as any; // internal marker, not a user setting
  if (getSetting(MARKER) === '1') return;
  const rows = db.select().from(sessions).all();
  db.transaction((tx) => {
    for (const r of rows) {
      tx.update(sessions).set({ id: hashSessionToken(r.id) })
        .where(eq(sessions.id, r.id)).run();
    }
  });
  setSetting(MARKER, '1');
  if (rows.length) console.log(`[auth] hashed ${rows.length} legacy session id(s)`);
}
