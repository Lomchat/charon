import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { db, providerAccounts } from '@/lib/db';
import { encrypt, decrypt } from '@/lib/server/crypto';
import { getEnvAesKey } from '@/lib/server/masterKey';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import type { ProviderAccount } from '@/lib/providerAccounts';

/**
 * Hub-owned provider accounts (CLAUDE.md §14.115) — the vault.
 *
 * A row's `credentials` is AES-GCM JSON under the master key. What it holds per
 * provider (never sent to a browser; agents get only `agentCredentials`):
 *   claude: the full OAuth login (refresh token included) + profile facts
 *   codex:  ChatGPT tokens (id/access/refresh) + account id
 *   cursor: the minted API key
 */
export type ClaudeSecret = {
  accessToken: string; refreshToken: string; expiresAt: number; refreshTokenExpiresAt?: number | null;
  scopes: string[]; subscriptionType?: string | null; rateLimitTier?: string | null;
  oauthAccount?: Record<string, unknown> | null;
};
export type CodexSecret = { idToken: string; accessToken: string; refreshToken: string; accountId: string; planType?: string | null };
export type CursorSecret = { apiKey: string; expiresAt?: number | null };
export type AccountSecret = ClaudeSecret | CodexSecret | CursorSecret;

export type AccountRow = typeof providerAccounts.$inferSelect;

function vaultKey(): Buffer {
  const key = getEnvAesKey();
  if (!key) throw new Error('Configure MASTER_PASSWORD and MASTER_SALT before adding accounts.');
  return key;
}

export function sealSecret(secret: AccountSecret): string {
  return encrypt(JSON.stringify(secret), vaultKey());
}

export function openSecret<T extends AccountSecret = AccountSecret>(row: Pick<AccountRow, 'credentials'>): T {
  try { return JSON.parse(decrypt(row.credentials, vaultKey())) as T; }
  catch { throw new Error('Account credentials cannot be decrypted (master key changed?). Sign in again.'); }
}

/** The SAME identity hash the agent derives for a login (account_profiles.py
 *  `_identity`): JSON of the list, compact, sha256 hex. Claude: native account
 *  + organization uuids; Codex: ChatGPT account id + casefolded email. Cursor
 *  has no agent-side key; its email stands in. */
export function accountKeyFor(provider: SessionProvider, parts: { accountUuid?: string | null; organizationUuid?: string | null;
  accountId?: string | null; email?: string | null }): string | null {
  let identity: unknown[] | null = null;
  if (provider === 'claude' && parts.accountUuid && parts.organizationUuid) identity = ['claude', parts.accountUuid, parts.organizationUuid];
  else if (provider === 'codex' && parts.accountId && parts.email) identity = ['codex', parts.accountId, parts.email.toLowerCase()];
  else if (provider === 'cursor' && parts.email) identity = ['cursor', parts.email.toLowerCase()];
  return identity ? createHash('sha256').update(JSON.stringify(identity)).digest('hex') : null;
}

export function newAccountId(): string {
  return randomBytes(8).toString('hex');
}

export function listAccountRows(): AccountRow[] {
  return db.select().from(providerAccounts).orderBy(asc(providerAccounts.provider), asc(providerAccounts.position), asc(providerAccounts.createdAt)).all();
}

export function getAccountRow(id: string): AccountRow | undefined {
  return db.select().from(providerAccounts).where(eq(providerAccounts.id, id)).get();
}

export function isGlobalAccountId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-f0-9]{16}$/.test(id) && !!getAccountRow(id);
}

/** The account a session gets when none was chosen: the provider's first
 *  usable one (by position). */
export function defaultAccountFor(provider: SessionProvider): string | null {
  return listAccountRows().find((r) => r.provider === provider && r.status !== 'expired')?.id ?? null;
}

/** Browser-safe view. `number` = the account's rank within its provider (the
 *  logo badge), stable until the user reorders. */
export function publicAccounts(rows: AccountRow[] = listAccountRows()): ProviderAccount[] {
  const rank = new Map<string, number>();
  return rows.map((r) => {
    const n = (rank.get(r.provider) ?? 0) + 1;
    rank.set(r.provider, n);
    return {
      id: r.id, provider: r.provider as SessionProvider, number: n, name: r.name,
      email: r.email, displayName: r.displayName, organization: r.organization, plan: r.plan,
      accountKey: r.accountKey, status: r.status as ProviderAccount['status'], lastError: r.lastError,
      accessExpiresAt: r.accessExpiresAt, loginExpiresAt: r.loginExpiresAt, lastRefreshAt: r.lastRefreshAt,
      createdAt: r.createdAt,
    };
  });
}

/** What an agent receives for one account: the SHORT-LIVED part only. */
export function agentCredentials(row: AccountRow): Record<string, unknown> | null {
  if (row.status === 'expired') return null;
  const secret = openSecret(row);
  if (row.provider === 'claude') {
    const s = secret as ClaudeSecret;
    return { accessToken: s.accessToken, expiresAt: s.expiresAt, scopes: s.scopes,
      subscriptionType: s.subscriptionType ?? null, rateLimitTier: s.rateLimitTier ?? null,
      refreshTokenExpiresAt: s.refreshTokenExpiresAt ?? null, oauthAccount: s.oauthAccount ?? null };
  }
  if (row.provider === 'codex') {
    const s = secret as CodexSecret;
    return { accessToken: s.accessToken, accountId: s.accountId, planType: s.planType ?? null };
  }
  const s = secret as CursorSecret;
  return { apiKey: s.apiKey, expiresAt: s.expiresAt ?? null };
}

/** One account in the `accounts_set` RPC shape. */
export function agentAccount(row: AccountRow): Record<string, unknown> {
  return {
    id: row.id, provider: row.provider, name: row.name || undefined, email: row.email ?? undefined,
    display_name: row.displayName ?? undefined, organization: row.organization ?? undefined,
    plan: row.plan ?? undefined, account_key: row.accountKey ?? undefined,
    credentials: agentCredentials(row),
  };
}
