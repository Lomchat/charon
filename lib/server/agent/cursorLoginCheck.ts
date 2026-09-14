import 'server-only';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { getAgentClientForVpsId } from './AgentClientPool';
import { emitGlobalVpsStatus } from './sessionOps';
import { providerLoginPatch } from '@/lib/sessionCapabilities';

// Is a VPS still signed in to Cursor? (§14.103/§14.104)
//
// The verdict is the SDK's own `Cursor.auth.status()`, which also checks the
// stored key is unexpired and minted for this backend — the file merely
// existing proves nothing. Mirrors claudeLoginCheck; the key difference is
// that a Cursor key EXPIRES (90 days by default), so this sweep is what turns
// "it worked last month" into a visible Sign-in prompt instead of a session
// that fails on its next turn.

const TTL_SECONDS = 24 * 60 * 60;

export type CursorLoginCheck = {
  ok: boolean;
  loggedIn?: boolean;
  /** The account behind the key, when the probe reported one. Surfaced by the
   *  manual check route so the user can confirm WHICH account is wired here. */
  email?: string | null;
  checkedAt?: number;
  error?: string;
  /** The agent predates the probe (-32601). A rollout lag, not a logout — the
   *  caller offers "update the agent" instead of "sign in". */
  tooOld?: boolean;
};

/** THE probe + persist + broadcast. One function, called by both the 24h sweep
 *  and the manual check route, so the no-clobber rule below cannot drift
 *  between two copies. */
export async function refreshCursorLoginStatus(v: Vps): Promise<CursorLoginCheck> {
  try {
    const client = getAgentClientForVpsId(v.id);
    const r = await client.call<{ ok?: boolean; logged_in?: boolean; email?: string; error?: string }>(
      'cursor_auth_status', {},
    );
    if (!r?.ok) return { ok: false, error: r?.error ?? 'probe failed' };
    const loggedIn = !!r.logged_in;
    const checkedAt = Math.floor(Date.now() / 1000);
    try {
      db.update(vpsTable).set(providerLoginPatch('cursor', loggedIn ? 1 : 0, checkedAt))
        .where(eq(vpsTable.id, v.id)).run();
    } catch {}
    if (v.agentStatus === 'ok') {
      emitGlobalVpsStatus(v.id, 'ok', { cursorLoggedIn: loggedIn ? 1 : 0 });
    }
    return { ok: true, loggedIn, email: r.email ?? null, checkedAt };
  } catch (e: any) {
    // A probe that could not run leaves the flag ALONE: "unknown" is not
    // "signed out", and writing 0 here would hide a working backend (§14.53).
    return { ok: false, error: String(e?.message ?? e), tooOld: e?.code === -32601 };
  }
}

export async function refreshCursorLoginStatusIfStale(
  v: Vps,
  ttlSeconds: number = TTL_SECONDS,
): Promise<CursorLoginCheck | 'fresh' | 'skipped'> {
  // Only ask a box that actually runs Cursor — probing one without the SDK
  // spends an SSH round trip to learn something the availability flag says.
  if (v.cursorAvailable !== 1) return 'skipped';
  const now = Math.floor(Date.now() / 1000);
  if (v.cursorLoggedInCheckedAt && now - v.cursorLoggedInCheckedAt < ttlSeconds) return 'fresh';
  return refreshCursorLoginStatus(v);
}
