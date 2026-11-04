import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, providerAccounts, vps as vpsTable } from '@/lib/db';
import { SESSION_PROVIDERS, providerBackendState, providerLoginPatch, type SessionProvider } from '@/lib/sessionCapabilities';
import type { AccountUsage } from '@/lib/server/hub/types';
import type { AccountLoginAttempt, ProviderAccount } from '@/lib/providerAccounts';
import type { AgentClient } from '@/lib/server/agent/AgentClient';
import { getAgentClientForVpsId, listAgentClients } from '@/lib/server/agent/AgentClientPool';
import { providerName } from '@/lib/providerText';
import { emitGlobalAccountProfiles, emitGlobalAccountUsage, emitGlobalVpsRuntimeFromDb } from '@/lib/server/agent/sessionOps';
import {
  accountKeyFor, agentAccount, getAccountRow, listAccountRows, newAccountId, openSecret, publicAccounts, sealSecret,
  type AccountRow, type ClaudeSecret, type CodexSecret, type CursorSecret,
} from './store';
import {
  ProviderHttpError, claudeAuthorize, claudeExchange, claudeProfile, claudeRefresh, claudeSecretFrom, claudeUsage, claudePlan,
  codexDevicePoll, codexDeviceStart, codexIdentity, codexRefresh, codexUsage,
  type ClaudeAuthorize, type CodexDevice,
} from './oauth';

/**
 * Hub-owned accounts, the live half (CLAUDE.md §14.115): sign-in attempts, the
 * refresh loop (the ONLY place a login rotates), pushing the short-lived part
 * to every agent, the per-ACCOUNT usage gauges and the VPS launcher columns.
 *
 * ⚠ A Claude refresh REVOKES the previous access token at once: persist, then
 * push to every connected agent in the same breath (an agent reached later
 * answers 401 until its push — it recovers in-process, no restart).
 */

// ── Process-wide state (§14.106) ─────────────────────────────────────────────

type Attempt = {
  id: string; provider: SessionProvider; accountId: string | null; createdAt: number;
  kind: 'code' | 'device' | 'link';
  url: string; userCode?: string;
  phase: 'pending' | 'verifying' | 'success' | 'error';
  error?: string; account?: ProviderAccount;
  claude?: ClaudeAuthorize; codex?: CodexDevice;
  cursor?: { vpsId: string; loginId: string };
  cancelled?: boolean;
};
type UsageState = { last: AccountUsage | null; lastPollAt: number; hardRetryAt: number; inflight: Promise<AccountUsage | null> | null };
type EngineState = {
  attempts: Map<string, Attempt>;
  refreshing: Map<string, Promise<AccountRow | undefined>>;
  usage: Map<string, UsageState>;
  timer: ReturnType<typeof setInterval> | null;
  pushFailures: Map<string, number>;
};
const g = globalThis as unknown as { _accountsEngine?: EngineState };
const state: EngineState = g._accountsEngine ??= {
  attempts: new Map(), refreshing: new Map(), usage: new Map(), timer: null, pushFailures: new Map(),
};

const ATTEMPT_TTL_MS = 20 * 60_000;
const TICK_MS = 60_000;
/** Claude access tokens live 8h: refresh with this much left. */
const CLAUDE_REFRESH_LEAD_MS = 75 * 60_000;
/** Codex access tokens live 10 days: refresh with this much left. */
const CODEX_REFRESH_LEAD_MS = 3 * 86_400_000;
const REFRESH_RETRY_MS = 5 * 60_000;
const USAGE_STEADY_MS: Record<SessionProvider, number> = { claude: 10 * 60_000, codex: 5 * 60_000, cursor: Infinity };
const USAGE_MIN_GAP_MS = 2 * 60_000;

// ── Public reads ─────────────────────────────────────────────────────────────

export function listProviderAccounts(): ProviderAccount[] {
  return publicAccounts();
}

export function providerAccountsFor(provider: SessionProvider): ProviderAccount[] {
  return publicAccounts().filter((a) => a.provider === provider);
}

function emitAccountsChanged(): void {
  try { emitGlobalAccountProfiles('global'); } catch { /* bus is best-effort */ }
}

// ── Persisting a sign-in ─────────────────────────────────────────────────────

type Identity = { email: string | null; displayName: string | null; organization: string | null; plan: string | null;
  accountKey: string | null; accessExpiresAt: number | null; loginExpiresAt: number | null; earliestRefreshAt?: number | null };

/** Insert a new account, or — same provider + identity, or the account being
 *  re-signed — replace its credentials. Returns the stored row. */
function saveLogin(provider: SessionProvider, secret: ClaudeSecret | CodexSecret | CursorSecret, id: Identity, reloginId: string | null): AccountRow {
  const rows = listAccountRows();
  const existing = (reloginId ? rows.find((r) => r.id === reloginId && r.provider === provider) : undefined)
    ?? (id.accountKey ? rows.find((r) => r.provider === provider && r.accountKey === id.accountKey) : undefined);
  const now = Date.now();
  const values = {
    email: id.email, displayName: id.displayName, organization: id.organization, plan: id.plan, accountKey: id.accountKey,
    credentials: sealSecret(secret), accessExpiresAt: id.accessExpiresAt, loginExpiresAt: id.loginExpiresAt,
    earliestRefreshAt: id.earliestRefreshAt ?? null, lastRefreshAt: now, status: 'ok', lastError: null,
  };
  if (existing) {
    // Another row may already own this identity (re-signing account A into
    // account B's login): keep ONE row per login — the re-signed one wins.
    const clash = id.accountKey ? rows.find((r) => r.id !== existing.id && r.provider === provider && r.accountKey === id.accountKey) : undefined;
    db.transaction((tx) => {
      if (clash) tx.delete(providerAccounts).where(eq(providerAccounts.id, clash.id)).run();
      tx.update(providerAccounts).set(values).where(eq(providerAccounts.id, existing.id)).run();
    });
    if (clash) void removeFromAgents(clash);
    return getAccountRow(existing.id)!;
  }
  const position = rows.filter((r) => r.provider === provider).reduce((m, r) => Math.max(m, r.position + 1), 0);
  const fresh = newAccountId();
  db.insert(providerAccounts).values({ id: fresh, provider, name: '', position, ...values }).run();
  return getAccountRow(fresh)!;
}

async function afterLogin(row: AccountRow): Promise<ProviderAccount> {
  await pushToAgents([row]);
  syncVpsLoginColumns();
  emitAccountsChanged();
  void pollAccountUsage(row.id, { force: true }).catch(() => {});
  try { (await import('./migration')).scheduleMigration(); } catch { /* migration is best-effort, retried on tick */ }
  return publicAccounts().find((a) => a.id === row.id)!;
}

// ── Sign-in attempts ─────────────────────────────────────────────────────────

function sweepAttempts(): void {
  const now = Date.now();
  for (const [id, a] of state.attempts) if (now - a.createdAt > ATTEMPT_TTL_MS) {
    a.cancelled = true;
    state.attempts.delete(id);
    if (a.cursor) void cancelCursorAgentLogin(a.cursor).catch(() => {});
  }
}

export type AttemptView = AccountLoginAttempt;

function view(a: Attempt): AttemptView {
  return { id: a.id, provider: a.provider, kind: a.kind, url: a.url, userCode: a.userCode, phase: a.phase, error: a.error,
    account: a.account, accountId: a.accountId };
}

export async function startLogin(provider: SessionProvider, accountId: string | null): Promise<AttemptView> {
  sweepAttempts();
  if (accountId) {
    const row = getAccountRow(accountId);
    if (!row || row.provider !== provider) throw new Error('Unknown account');
  }
  const base = { id: randomUUID(), provider, accountId, createdAt: Date.now(), phase: 'pending' as const };
  let attempt: Attempt;
  if (provider === 'claude') {
    const claude = claudeAuthorize();
    attempt = { ...base, kind: 'code', url: claude.url, claude };
  } else if (provider === 'codex') {
    const codex = await codexDeviceStart();
    attempt = { ...base, kind: 'device', url: codex.url, userCode: codex.userCode, codex };
    void pollCodexDevice(attempt);
  } else {
    const cursor = await startCursorAgentLogin();
    attempt = { ...base, kind: 'link', url: cursor.url, cursor: { vpsId: cursor.vpsId, loginId: cursor.loginId } };
    void pollCursorAgentLogin(attempt);
  }
  state.attempts.set(attempt.id, attempt);
  return view(attempt);
}

export function loginStatus(attemptId: string): AttemptView | null {
  const a = state.attempts.get(attemptId);
  return a ? view(a) : null;
}

export async function cancelLogin(attemptId: string): Promise<void> {
  const a = state.attempts.get(attemptId);
  if (!a) return;
  a.cancelled = true;
  state.attempts.delete(attemptId);
  if (a.cursor && a.phase === 'pending') await cancelCursorAgentLogin(a.cursor).catch(() => {});
}

export async function submitLoginCode(attemptId: string, code: string): Promise<AttemptView> {
  const a = state.attempts.get(attemptId);
  if (!a || a.provider !== 'claude' || !a.claude) throw new Error('This sign-in attempt is over — start again.');
  if (a.phase === 'verifying' || a.phase === 'success') return view(a);
  a.phase = 'verifying'; a.error = undefined;
  try {
    const now = Date.now();
    const tokens = await claudeExchange(code, a.claude);
    const profile = await claudeProfile(tokens.access_token);
    const secret = claudeSecretFrom(tokens, now, undefined, profile);
    const row = saveLogin('claude', secret, {
      email: profile.account?.email ?? tokens.account?.email_address ?? null,
      displayName: profile.account?.display_name ?? null,
      organization: profile.organization?.name ?? null,
      plan: profile.organization?.plan_display_name ?? claudePlan(profile),
      accountKey: accountKeyFor('claude', { accountUuid: profile.account?.uuid, organizationUuid: profile.organization?.uuid }),
      accessExpiresAt: secret.expiresAt, loginExpiresAt: secret.refreshTokenExpiresAt ?? null,
    }, a.accountId);
    a.account = await afterLogin(row);
    a.phase = 'success';
  } catch (e) {
    // A wrong code costs nothing: the same link keeps accepting codes.
    a.phase = 'pending';
    a.error = e instanceof Error ? e.message : 'Sign-in failed';
  }
  return view(a);
}

async function pollCodexDevice(a: Attempt): Promise<void> {
  const d = a.codex!;
  while (!a.cancelled && Date.now() < d.expiresAt) {
    await new Promise((r) => setTimeout(r, d.intervalMs));
    if (a.cancelled) return;
    try {
      const secret = await codexDevicePoll(d);
      if (!secret) continue;
      a.phase = 'verifying';
      const who = codexIdentity(secret);
      const row = saveLogin('codex', secret, {
        email: who.email, displayName: null, organization: null, plan: who.plan,
        accountKey: accountKeyFor('codex', { accountId: who.accountId, email: who.email }),
        accessExpiresAt: who.accessExp, loginExpiresAt: null,
      }, a.accountId);
      a.account = await afterLogin(row);
      a.phase = 'success';
      return;
    } catch (e) {
      a.phase = 'error'; a.error = e instanceof Error ? e.message : 'Sign-in failed';
      return;
    }
  }
  if (!a.cancelled && a.phase === 'pending') { a.phase = 'error'; a.error = 'The code expired — start again.'; }
}

// Cursor signs in through its SDK's Node helper, which only an agent with the
// runtime has: any connected VPS runs it in a throwaway HOME and hands the
// minted key back; that box keeps nothing.
function cursorCapableVps(): string | null {
  const rows = db.select().from(vpsTable).all();
  for (const v of rows) {
    const client = getAgentClientForVpsId(v.id);
    if (client.status === 'connected' && client.hello?.cursor_available && client.hello?.global_accounts) return v.id;
  }
  return null;
}

async function startCursorAgentLogin(): Promise<{ vpsId: string; loginId: string; url: string }> {
  const vpsId = cursorCapableVps();
  if (!vpsId) throw new Error(`${providerName('cursor')} sign-in needs one connected VPS with its runtime (update that VPS's agent).`);
  const r = await getAgentClientForVpsId(vpsId).call<{ ok: boolean; login_id: string; url: string }>('cursor_login_start', { isolated: true }, { timeoutMs: 60_000 });
  if (!r?.ok || !r.url) throw new Error(`${providerName('cursor')} did not return a sign-in link`);
  return { vpsId, loginId: r.login_id, url: r.url };
}

async function cancelCursorAgentLogin(c: { vpsId: string; loginId: string }): Promise<void> {
  await getAgentClientForVpsId(c.vpsId).call('cursor_login_cancel', { login_id: c.loginId });
}

async function pollCursorAgentLogin(a: Attempt): Promise<void> {
  const c = a.cursor!;
  while (!a.cancelled && Date.now() - a.createdAt < ATTEMPT_TTL_MS) {
    await new Promise((r) => setTimeout(r, 3_000));
    if (a.cancelled) return;
    try {
      const r = await getAgentClientForVpsId(c.vpsId).call<{ ok: boolean; status: string; error?: string; email?: string;
        credentials?: { apiKey: string; expiresAt?: number | null } }>('cursor_login_status', { login_id: c.loginId });
      if (r.status === 'pending') continue;
      if (r.status !== 'success' || !r.credentials?.apiKey) { a.phase = 'error'; a.error = r.error ?? 'Sign-in failed'; return; }
      a.phase = 'verifying';
      const secret: CursorSecret = { apiKey: r.credentials.apiKey, expiresAt: r.credentials.expiresAt ?? null };
      const row = saveLogin('cursor', secret, {
        email: r.email ?? null, displayName: null, organization: null, plan: null,
        accountKey: accountKeyFor('cursor', { email: r.email }), accessExpiresAt: secret.expiresAt ?? null, loginExpiresAt: secret.expiresAt ?? null,
      }, a.accountId);
      a.account = await afterLogin(row);
      a.phase = 'success';
      return;
    } catch (e) {
      // The agent link dropped mid-attempt: its helper died with it.
      a.phase = 'error'; a.error = e instanceof Error ? e.message : 'Sign-in failed';
      return;
    }
  }
}

// ── Account management ───────────────────────────────────────────────────────

export function renameAccount(id: string, name: string): void {
  db.update(providerAccounts).set({ name: name.trim().slice(0, 80) }).where(eq(providerAccounts.id, id)).run();
  const row = getAccountRow(id);
  if (row) void pushToAgents([row], { credentials: false });
  emitAccountsChanged();
}

export function reorderAccounts(provider: SessionProvider, ids: string[]): void {
  db.transaction((tx) => {
    ids.forEach((id, i) => tx.update(providerAccounts).set({ position: i })
      .where(sql`${providerAccounts.id} = ${id} AND ${providerAccounts.provider} = ${provider}`).run());
  });
  emitAccountsChanged();
}

export async function removeAccount(id: string): Promise<void> {
  const row = getAccountRow(id);
  if (!row) return;
  db.delete(providerAccounts).where(eq(providerAccounts.id, id)).run();
  state.usage.delete(id);
  await removeFromAgents(row);
  syncVpsLoginColumns();
  emitAccountsChanged();
}

// ── Pushing to agents ────────────────────────────────────────────────────────

function supportsAccounts(client: AgentClient): boolean {
  return client.status === 'connected' && !!client.hello?.global_accounts;
}

function rpcAccount(row: AccountRow, credentials: boolean): Record<string, unknown> {
  const a = agentAccount(row);
  if (!credentials) delete a.credentials;
  return a;
}

/** Push to every connected agent. Failures are retried by the next tick. */
async function pushToAgents(rows: AccountRow[], opts: { credentials?: boolean } = {}): Promise<void> {
  if (!rows.length) return;
  const accounts = rows.map((r) => rpcAccount(r, opts.credentials !== false));
  await Promise.all(listAgentClients().filter(supportsAccounts).map(async (client) => {
    try { await client.call('accounts_set', { accounts }, { timeoutMs: 30_000 }); state.pushFailures.delete(client.vps.id); }
    catch { state.pushFailures.set(client.vps.id, Date.now()); }
  }));
}

async function removeFromAgents(row: AccountRow): Promise<void> {
  await Promise.all(listAgentClients().filter(supportsAccounts).map((client) =>
    client.call('accounts_set', { accounts: [], remove: [{ provider: row.provider, id: row.id }] }, { timeoutMs: 30_000 }).catch(() => {})));
}

/** On every (re)connect, BEFORE reconcile resumes anything: the box gets the
 *  whole list (and drops what the hub no longer has). */
export async function pushAccountsToClient(client: AgentClient): Promise<void> {
  if (!client.hello?.global_accounts) return;
  const rows = listAccountRows();
  await client.call('accounts_set', { accounts: rows.map((r) => rpcAccount(r, true)), replace: true }, { timeoutMs: 30_000 });
  state.pushFailures.delete(client.vps.id);
}

/** A session on this account hit an auth error: its box may hold a token a
 *  refresh just revoked (push it again), or the token is about to lapse. */
export function repairAfterAuthError(id: string, vpsId: string): void {
  const row = getAccountRow(id);
  if (!row) return;
  const client = getAgentClientForVpsId(vpsId);
  if (supportsAccounts(client)) void client.call('accounts_set', { accounts: [rpcAccount(row, true)] }, { timeoutMs: 30_000 }).catch(() => {});
  if (row.provider !== 'cursor' && (!row.accessExpiresAt || row.accessExpiresAt - Date.now() < CLAUDE_REFRESH_LEAD_MS)) void refreshAccount(id);
}

// ── Refresh ──────────────────────────────────────────────────────────────────

function needsRefresh(row: AccountRow, now: number): boolean {
  if (row.status === 'expired') return false;
  if (row.status === 'error' && row.lastRefreshAt && now - row.lastRefreshAt < REFRESH_RETRY_MS) return false;
  if (row.provider === 'claude') return !row.accessExpiresAt || row.accessExpiresAt - now < CLAUDE_REFRESH_LEAD_MS;
  if (row.provider === 'codex') {
    if (row.earliestRefreshAt && now < row.earliestRefreshAt) return false;
    return !row.accessExpiresAt || row.accessExpiresAt - now < CODEX_REFRESH_LEAD_MS;
  }
  return false;
}

export function refreshAccount(id: string): Promise<AccountRow | undefined> {
  const running = state.refreshing.get(id);
  if (running) return running;
  const run = (async () => {
    const row = getAccountRow(id);
    if (!row || row.provider === 'cursor') return row;
    const now = Date.now();
    try {
      if (row.provider === 'claude') {
        const previous = openSecret<ClaudeSecret>(row);
        const tokens = await claudeRefresh(previous);
        const secret = claudeSecretFrom(tokens, now, previous);
        // Persist FIRST: the old refresh token is spent the moment this answered.
        db.update(providerAccounts).set({ credentials: sealSecret(secret), accessExpiresAt: secret.expiresAt,
          loginExpiresAt: secret.refreshTokenExpiresAt ?? row.loginExpiresAt, lastRefreshAt: now, status: 'ok', lastError: null })
          .where(eq(providerAccounts.id, id)).run();
      } else {
        const previous = openSecret<CodexSecret>(row);
        const { secret, earliestRefreshAt } = await codexRefresh(previous);
        const who = codexIdentity(secret);
        db.update(providerAccounts).set({ credentials: sealSecret(secret), accessExpiresAt: who.accessExp,
          earliestRefreshAt, lastRefreshAt: now, status: 'ok', lastError: null, plan: who.plan ?? row.plan })
          .where(eq(providerAccounts.id, id)).run();
      }
      const fresh = getAccountRow(id)!;
      await pushToAgents([fresh]);
      if (row.status !== 'ok') { syncVpsLoginColumns(); emitAccountsChanged(); }
      return fresh;
    } catch (e) {
      const revoked = e instanceof ProviderHttpError && e.revoked;
      db.update(providerAccounts).set({ status: revoked ? 'expired' : 'error', lastRefreshAt: now,
        lastError: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).where(eq(providerAccounts.id, id)).run();
      if (revoked) syncVpsLoginColumns();
      emitAccountsChanged();
      return getAccountRow(id);
    }
  })().finally(() => state.refreshing.delete(id));
  state.refreshing.set(id, run);
  return run;
}

async function tick(): Promise<void> {
  sweepAttempts();
  const now = Date.now();
  let changed = false;
  for (const row of listAccountRows()) {
    if (row.status !== 'expired' && row.loginExpiresAt && row.loginExpiresAt <= now) {
      db.update(providerAccounts).set({ status: 'expired', lastError: 'The sign-in reached its end of life — sign in again.' })
        .where(eq(providerAccounts.id, row.id)).run();
      changed = true;
      continue;
    }
    if (needsRefresh(row, now)) await refreshAccount(row.id).catch(() => {});
    if (row.status !== 'expired') void pollAccountUsage(row.id, { steady: true }).catch(() => {});
  }
  if (changed) { syncVpsLoginColumns(); emitAccountsChanged(); }
  // A box that missed a push (busy link) gets the whole list again.
  for (const [vpsId] of state.pushFailures) {
    const client = getAgentClientForVpsId(vpsId);
    if (supportsAccounts(client)) await pushAccountsToClient(client).catch(() => {});
  }
}

/** Idempotent; armed at boot (autoConnect). */
export function ensureAccountsEngine(): void {
  if (state.timer) return;
  state.timer = setInterval(() => { void tick().catch(() => {}); }, TICK_MS);
  state.timer.unref?.();
  setTimeout(() => { void tick().catch(() => {}); }, 5_000).unref?.();
}

// ── VPS launcher columns ─────────────────────────────────────────────────────

/** Every VPS "is signed in" to a provider exactly when a usable global account
 *  exists: the launcher/health logic reads these columns (§14.115). */
export function syncVpsLoginColumns(): void {
  const rows = listAccountRows();
  const usable = (p: SessionProvider) => rows.some((r) => r.provider === p && r.status !== 'expired') ? 1 : 0;
  const now = Math.floor(Date.now() / 1000);
  for (const v of db.select().from(vpsTable).all()) {
    const patch: Record<string, unknown> = {};
    for (const p of SESSION_PROVIDERS) {
      const want = usable(p);
      if (providerBackendState(v as never, p).loggedIn !== want) Object.assign(patch, providerLoginPatch(p, want as 0 | 1, now));
    }
    if (!Object.keys(patch).length) continue;
    db.update(vpsTable).set(patch).where(eq(vpsTable.id, v.id)).run();
    try { emitGlobalVpsRuntimeFromDb(v.id); } catch { /* best-effort */ }
  }
}

// ── Usage gauges (one reading per ACCOUNT, fanned to every VPS) ──────────────

function usageState(id: string): UsageState {
  let st = state.usage.get(id);
  if (!st) { st = { last: null, lastPollAt: 0, hardRetryAt: 0, inflight: null }; state.usage.set(id, st); }
  return st;
}

function fan(row: Pick<AccountRow, 'id' | 'provider' | 'accountKey'>, usage: AccountUsage): AccountUsage {
  const out: AccountUsage = { ...usage, provider: row.provider as SessionProvider, accountProfile: row.id, accountKey: row.accountKey };
  for (const v of db.select({ id: vpsTable.id }).from(vpsTable).all()) {
    try { emitGlobalAccountUsage(v.id, out); } catch { /* best-effort */ }
  }
  return out;
}

export function accountUsage(id: string): AccountUsage | null {
  const row = getAccountRow(id);
  const last = state.usage.get(id)?.last;
  return row && last ? { ...last, provider: row.provider as SessionProvider, accountProfile: row.id, accountKey: row.accountKey } : null;
}

export function pollAccountUsage(id: string, opts: { force?: boolean; steady?: boolean } = {}): Promise<AccountUsage | null> {
  const row = getAccountRow(id);
  if (!row || row.provider === 'cursor' || row.status === 'expired') return Promise.resolve(accountUsage(id));
  const st = usageState(id);
  if (st.inflight) return st.inflight;
  const now = Date.now();
  if (now < st.hardRetryAt || now - st.lastPollAt < USAGE_MIN_GAP_MS
      || (opts.steady && now - st.lastPollAt < USAGE_STEADY_MS[row.provider as SessionProvider])) return Promise.resolve(accountUsage(id));
  st.lastPollAt = now;
  const run = (async () => {
    const { normalizeClaudeUsage, normalizeCodexUsage } = await import('@/lib/server/agent/usagePoll');
    let next: AccountUsage;
    try {
      if (row.provider === 'claude') {
        const secret = openSecret<ClaudeSecret>(row);
        const r = await claudeUsage(secret.accessToken);
        if (r.status === 401) void refreshAccount(row.id);
        if (r.retryAfterMs != null && r.status === 429) st.hardRetryAt = Date.now() + Math.max(USAGE_MIN_GAP_MS, r.retryAfterMs);
        next = normalizeClaudeUsage(r.status === 200
          ? { ok: true, usage: r.body, subscription_type: secret.subscriptionType ?? null, org_id: r.orgId } as never
          : { ok: false, error: 'http_error', status_code: r.status } as never);
      } else {
        const secret = openSecret<CodexSecret>(row);
        const r = await codexUsage(secret);
        if (r.status === 401) void refreshAccount(row.id);
        next = normalizeCodexUsage(r.status === 200 ? whamToAgentShape(r.body) : { ok: false, error: `HTTP ${r.status}` } as never);
      }
    } catch (e) {
      next = { ok: false, fetchedAt: Date.now(), error: 'request_failed', statusCode: null };
    }
    if (!next.ok && st.last?.ok) next = { ...st.last, degraded: { reason: next.error ?? 'unknown', statusCode: next.statusCode ?? null, retryAt: st.hardRetryAt || null } };
    st.last = next;
    return fan(row, next);
  })().catch(() => null).finally(() => { st.inflight = null; });
  st.inflight = run;
  return run;
}

/** ChatGPT `wham/usage` → the agent's `get_codex_usage` envelope. */
function whamToAgentShape(body: any): any {
  const rl = body?.rate_limit ?? {};
  const win = (w: any) => w && typeof w === 'object' ? {
    used_percent: typeof w.used_percent === 'number' ? w.used_percent : null,
    resets_at: typeof w.reset_at === 'number' ? w.reset_at : null,
    window_minutes: typeof w.limit_window_seconds === 'number' ? Math.round(w.limit_window_seconds / 60) : null,
  } : null;
  let fiveHour = null; let sevenDay = null;
  for (const w of [win(rl.primary_window), win(rl.secondary_window)]) {
    if (!w) continue;
    if (w.window_minutes != null && w.window_minutes <= 360) fiveHour = w; else sevenDay = w;
  }
  return { ok: true, provider: 'codex', plan_type: body?.plan_type ?? null, five_hour: fiveHour, seven_day: sevenDay,
    windows: [fiveHour, sevenDay].filter(Boolean), fetched_at: Date.now() / 1000 };
}

/** A Claude session's live 5h/7d windows (its `rate_limit` event). */
export function ingestAccountWindows(id: string, windows: unknown, at: number): void {
  const row = getAccountRow(id);
  if (!row) return;
  void import('@/lib/server/agent/usagePoll').then(({ liveUsageWindows, layLiveWindows }) => {
    const live = liveUsageWindows(windows, at);
    if (!live) return;
    const st = usageState(id);
    const prev = st.last?.ok ? st.last : null;
    if (prev && live.at <= Math.max(prev.fetchedAt, prev.windowsAt ?? 0)) return;
    st.last = layLiveWindows(prev ?? { ok: true, fetchedAt: 0, fiveHour: null, sevenDay: null, limits: null, extraUsage: null }, live);
    fan(row, st.last);
  }).catch(() => {});
}

/** A Codex app-server's pushed rate limits for this account. */
export function ingestAccountCodexPush(id: string, detail: unknown): void {
  const row = getAccountRow(id);
  if (!row) return;
  void import('@/lib/server/agent/usagePoll').then(({ ingestCodexUsagePush }) => {
    const usage = ingestCodexUsagePush(`account:${id}`, detail, false);
    if (!usage) return;
    usageState(id).last = usage;
    fan(row, usage);
  }).catch(() => {});
}
