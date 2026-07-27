import 'server-only';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { sshExec } from '@/lib/server/claude/sshExec';

// TTL beyond which we re-check the `claude login` state of a VPS.
// 24h: short enough to detect a server-side logout within the day,
// long enough not to spam SSH on every agent reconnection.
export const CLAUDE_LOGIN_CHECK_TTL_SECONDS = 24 * 60 * 60;

export type ClaudeLoginCheckResult =
  | { ok: true; loggedIn: boolean; checkedAt: number; account?: ClaudeAccount | null }
  | { ok: false; error: string; loggedIn: boolean; checkedAt: number | null };

/**
 * The account behind a logged-in CLI, as reported by `claude auth status
 * --json`. Not persisted (no migration) — surfaced live by the login modal
 * so the user can confirm WHICH account just got wired to this VPS.
 */
export type ClaudeAccount = {
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
};

export type ClaudeAuthStatus = {
  ok: boolean;
  loggedIn: boolean;
  account: ClaudeAccount | null;
  error?: string;
};

// `claude auth status --json` is the AUTHORITATIVE verdict (present since at
// least CLI 2.1.205 — the oldest in the fleet) and returns far more than a
// boolean:
//   {"loggedIn":true,"authMethod":"claude.ai","email":"…","orgName":"…",
//    "subscriptionType":"max"}
// The legacy probe (`claude config get oauth.refresh_token`) stays as an
// inline fallback for a CLI too old to know `claude auth`, so a single SSH
// round trip degrades gracefully instead of reporting a false logout.
const AUTH_STATUS_CMD =
  'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"; ' +
  'out=$(claude auth status --json 2>/dev/null); ' +
  'if [ -n "$out" ]; then printf "%s" "$out"; ' +
  'elif claude config get oauth.refresh_token >/dev/null 2>&1; then echo \'{"loggedIn":true,"authMethod":"legacy-probe"}\'; ' +
  'else echo \'{"loggedIn":false,"authMethod":"none"}\'; fi';

/**
 * One SSH round trip → parsed auth status. Does NOT touch the DB (callers
 * decide: the periodic check persists, the login flow only needs a verdict).
 */
export async function readClaudeAuthStatus(v: Vps, timeoutMs = 8_000): Promise<ClaudeAuthStatus> {
  const r = await sshExec(v, AUTH_STATUS_CMD, { timeoutMs });
  if (!r.stdout.trim()) {
    return { ok: false, loggedIn: false, account: null, error: r.stderr.slice(-200) || `exit ${r.code}` };
  }
  try {
    // Be liberal: a stray MOTD/warning line can precede the JSON object.
    const raw = r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1);
    const j = JSON.parse(raw) as Record<string, unknown>;
    const loggedIn = j.loggedIn === true;
    return {
      ok: true,
      loggedIn,
      account: loggedIn
        ? {
            authMethod: typeof j.authMethod === 'string' ? j.authMethod : undefined,
            email: typeof j.email === 'string' ? j.email : undefined,
            orgName: typeof j.orgName === 'string' ? j.orgName : undefined,
            subscriptionType: typeof j.subscriptionType === 'string' ? j.subscriptionType : undefined,
          }
        : null,
    };
  } catch {
    return { ok: false, loggedIn: false, account: null, error: 'unparseable auth status output' };
  }
}

/**
 * Checks via SSH whether the `claude` CLI is signed in on this VPS and
 * persists the result in `vps.claude_logged_in` / `_checked_at`.
 *
 * PATH extended to find the `claude` CLI even if it was installed by
 * `install.sh` in `~/.local/bin` or `~/.claude/bin` (cf. bootstrap.ts §
 * check_login). Short timeout (8s): if the VPS is slow, we keep the
 * previous value rather than block.
 *
 * Best-effort: if the SSH fails, we don't touch the DB and return
 * `ok:false` with the existing DB values.
 */
export async function refreshClaudeLoginStatus(v: Vps): Promise<ClaudeLoginCheckResult> {
  const st = await readClaudeAuthStatus(v);
  // If SSH crashes we don't touch the value — we don't know. The UI will
  // keep the previous value (potentially stale, that's OK).
  if (!st.ok) {
    return {
      ok: false,
      error: st.error ?? 'auth status failed',
      loggedIn: v.claudeLoggedIn === 1,
      checkedAt: v.claudeLoggedInCheckedAt,
    };
  }
  const loggedIn = st.loggedIn;
  const checkedAt = Math.floor(Date.now() / 1000);
  try {
    db.update(vpsTable).set({
      claudeLoggedIn: loggedIn ? 1 : 0,
      claudeLoggedInCheckedAt: checkedAt,
    }).where(eq(vpsTable.id, v.id)).run();
  } catch {}
  return { ok: true, loggedIn, checkedAt, account: st.account };
}

// Backoff schedule for retrying a failed SSH check. At Charon boot the host
// often has 20+ simultaneous SSH connect attempts (one per VPS via
// AgentClient.start), which can blow past `sshd MaxStartups` / conntrack
// limits and cause our `claude auth status` SSH (which spawns a fresh TCP) to
// timeout even on VPSes where the agent eventually connects fine. Spreading
// retries over a couple of minutes lets that initial rush settle.
const RETRY_DELAYS_MS = [10_000, 30_000, 120_000];

/**
 * "Lazy" variant: only run the SSH check if we've never checked
 * (`claude_logged_in IS NULL`) or if the last check is older than
 * `CLAUDE_LOGIN_CHECK_TTL_SECONDS`. Used by `autoConnect` when the agent
 * has just connected — avoids re-checking on every SSH reconnect (which
 * can happen every few minutes on an unstable network).
 *
 * If the first SSH attempt fails (typical at boot: see RETRY_DELAYS_MS),
 * retries with backoff. Bails early if another caller (login modal close,
 * concurrent autoConnect for the same VPS) wrote a value while we waited.
 *
 * Returns `'fresh'` if we skipped (recent value), otherwise the result
 * of `refreshClaudeLoginStatus` (last attempt, success or failure).
 */
export async function refreshClaudeLoginStatusIfStale(
  v: Vps,
  ttlSeconds: number = CLAUDE_LOGIN_CHECK_TTL_SECONDS,
): Promise<ClaudeLoginCheckResult | 'fresh'> {
  const now = Math.floor(Date.now() / 1000);
  if (v.claudeLoggedInCheckedAt && now - v.claudeLoggedInCheckedAt < ttlSeconds) {
    return 'fresh';
  }
  let last = await refreshClaudeLoginStatus(v);
  if (last.ok) return last;
  for (const delay of RETRY_DELAYS_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    // Someone else may have checked while we were waiting — re-query and
    // bail out if so (don't waste an SSH on a fresh value).
    const [fresh] = db.select().from(vpsTable).where(eq(vpsTable.id, v.id)).all();
    if (!fresh) return last;
    if (fresh.claudeLoggedInCheckedAt) {
      return {
        ok: true,
        loggedIn: fresh.claudeLoggedIn === 1,
        checkedAt: fresh.claudeLoggedInCheckedAt,
      };
    }
    last = await refreshClaudeLoginStatus(fresh);
    if (last.ok) return last;
  }
  return last;
}
