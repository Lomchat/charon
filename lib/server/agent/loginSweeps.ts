import 'server-only';
import type { Vps } from '@/lib/db/schema';
import { SESSION_PROVIDERS, type SessionProvider } from '@/lib/sessionCapabilities';
import { refreshClaudeLoginStatusIfStale } from './claudeLoginCheck';
import { refreshCursorLoginStatusIfStale } from './cursorLoginCheck';

/**
 * The stale-login sweep, ENROLLED per provider (§14.102).
 *
 * A credential that expires while nobody is looking turns into a session that
 * fails mid-turn instead of a Sign-in button, so each backend that can go stale
 * needs a periodic re-probe. The call sites used to name the sweeps one by one
 * inside `armAgentClientHooks`, which is a list — and a list is exactly what a
 * fourth backend gets silently left out of.
 *
 * `null` is a REAL answer, not an omission: Codex's device-code credential is
 * refreshed by the CLI itself and has no cheap probe worth an SSH round trip on
 * every reconnect. Typing the record over `SessionProvider` means a newcomer
 * has to state which of the two it is.
 */
const PROVIDER_LOGIN_SWEEPS: Record<
  SessionProvider,
  ((v: Vps) => Promise<unknown>) | null
> = {
  // 24h TTL, `claude auth status --json` over ssh (§14.64).
  claude: (v) => refreshClaudeLoginStatusIfStale(v),
  codex: null,
  // The minted key EXPIRES (90 days), so this sweep is what turns "it worked
  // last month" into a button rather than a failing turn (§14.104).
  cursor: (v) => refreshCursorLoginStatusIfStale(v),
};

/** Run every declared sweep for one VPS. Never throws, never awaits: these are
 *  background probes armed on an agent reconnect, and one slow box must not
 *  hold the reconcile that follows. */
export function sweepProviderLogins(v: Vps): void {
  for (const p of SESSION_PROVIDERS) {
    const sweep = PROVIDER_LOGIN_SWEEPS[p];
    if (!sweep) continue;
    try { void sweep(v)?.catch?.(() => {}); } catch {}
  }
}
