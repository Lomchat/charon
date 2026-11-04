import 'server-only';
import { eq } from 'drizzle-orm';
import { db, sessions } from '@/lib/db';
import { getEnvAesKey } from '@/lib/server/masterKey';
import { isAuthRequired } from '@/lib/server/authGate.js';
import { AUTH_DISABLED_SESSION_ID } from '@/lib/server/session';
import { deriveLivePreviewKey } from './livePreviewToken';

// The two hub-specific halves of the live-view gate (§14.110): which key
// signs, and whether the login that minted a token still exists.

const g = globalThis as unknown as { __charonLivePreviewKey?: Buffer };

/** One key per process (§14.106), derived from the env secrets. */
export function livePreviewKey(): Buffer {
  return (g.__charonLivePreviewKey ??= deriveLivePreviewKey(
    getEnvAesKey() ?? process.env.SESSION_SECRET ?? null,
  ));
}

/**
 * The fifth auth gate (§12) — it must agree with the other four. Auth off:
 * the signature is the whole check. Auth on: the minting login must still be
 * live, so logging out (or its expiry) kills every preview it opened, and a
 * token minted while auth was off is worthless once it is back on.
 */
export function livePreviewSessionValid(sid: string): boolean {
  if (!isAuthRequired()) return true;
  if (!sid || sid === AUTH_DISABLED_SESSION_ID) return false;
  const [row] = db.select({ expiresAt: sessions.expiresAt })
    .from(sessions).where(eq(sessions.id, sid)).all();
  return !!row && row.expiresAt >= Math.floor(Date.now() / 1000);
}
