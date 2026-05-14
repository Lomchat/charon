import 'server-only';
import crypto from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { db, users, sessions } from '@/lib/db';

const SESSION_TTL_SECS = 24 * 60 * 60; // 24h sliding inactivity

// AES key is derived from MASTER_PASSWORD + MASTER_SALT (both in .env).
// Since the password lives in env, we can derive the key any time the server boots,
// not only at user login. Cache it to avoid running scrypt on every request.
let _cachedAesKey: Buffer | null = null;
function getEnvAesKey(): Buffer | null {
  if (_cachedAesKey) return _cachedAesKey;
  try {
    _cachedAesKey = deriveMasterKey();
    return _cachedAesKey;
  } catch {
    return null;
  }
}
const SESSION_KEYS = new Map<string, Buffer>();

export const SESSION_COOKIE = 'heimdall_session';
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

export function setSessionKey(sessionId: string, key: Buffer) {
  SESSION_KEYS.set(sessionId, key);
}
export function getSessionKey(sessionId: string): Buffer | null {
  // Fall back to env-derived key when session map is empty
  // (e.g. after a server restart while user's cookie is still valid).
  return SESSION_KEYS.get(sessionId) ?? getEnvAesKey();
}
export function dropSessionKey(sessionId: string) {
  SESSION_KEYS.delete(sessionId);
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

export async function createSession() {
  const id = newSessionId();
  const userId = await ensureUser();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECS;
  db.insert(sessions).values({ id, userId, expiresAt }).run();
  return { id, expiresAt };
}

export async function getSession(id: string) {
  const [s] = db.select().from(sessions).where(eq(sessions.id, id)).all();
  if (!s) return null;
  if (s.expiresAt < Math.floor(Date.now() / 1000)) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    dropSessionKey(id);
    return null;
  }
  return s;
}

export async function touchSession(id: string) {
  const newExpiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECS;
  db.update(sessions).set({ expiresAt: newExpiry }).where(eq(sessions.id, id)).run();
  return newExpiry;
}

export async function dropSession(id: string) {
  db.delete(sessions).where(eq(sessions.id, id)).run();
  dropSessionKey(id);
}

export async function cleanupExpiredSessions() {
  const now = Math.floor(Date.now() / 1000);
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
}
