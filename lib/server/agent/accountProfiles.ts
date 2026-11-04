import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { db, accountProfiles, agentSessions, vps } from '@/lib/db';
import { DEFAULT_ACCOUNT_PROFILE, type AccountProfile } from '@/lib/accountProfiles';
import { providerBackendState, providerLoginPatch, type SessionProvider } from '@/lib/sessionCapabilities';
import { getAgentClientForVpsId } from './AgentClientPool';
import { sshExec, shQuote } from '@/lib/server/hub/sshExec';
import { AGENT_DIR_NAME } from './agentPaths.js';
import { getSetting, setSetting } from '@/lib/server/hub/settings';
import { emitGlobalAccountProfiles, emitGlobalVpsRuntimeFromDb } from './sessionOps';
import { cursorIdentities, identityChecked, profileStatuses, statusKey } from './accountProfileState';
export { profileStatuses, statusKey } from './accountProfileState';

export type ProfileStatus = {
  ok: boolean; provider: 'claude' | 'codex'; account_profile: string;
  logged_in?: boolean; account_key?: string | null; generation?: string;
  config_dir?: string; email?: string; display_name?: string; organization?: string;
  subscription_type?: string; auth_method?: string; error?: string;
};

const runtime = globalThis as unknown as {
  _accountProfileWatches?: Map<string, ReturnType<typeof setInterval>>;
  _accountProfileChecks?: Map<string, Promise<void>>;
};
const watches = runtime._accountProfileWatches ??= new Map();
const checks = runtime._accountProfileChecks ??= new Map();

/** The last probed identity of each DEFAULT profile (`statusKey` → key),
 *  persisted like an extra profile's row: an unprobed VPS (offline, cold
 *  start) still names its login, so one login stays one header button. A
 *  display hint only — the live probe (`profileStatuses`) always wins. */
function persistedDefaultKeys(): Record<string, string> {
  try {
    const parsed = JSON.parse(getSetting('accounts.default_keys') || '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

function persistDefaultKey(vpsId: string, provider: SessionProvider, key: string | null): void {
  const all = persistedDefaultKeys();
  const k = statusKey(vpsId, provider);
  if ((all[k] ?? null) === key) return;
  if (key) all[k] = key; else delete all[k];
  try { setSetting('accounts.default_keys', JSON.stringify(all)); } catch { /* best-effort hint */ }
}

/** The PUBLIC identity of a verified login (never credentials, §14.58). */
function publicIdentity(st: ProfileStatus | undefined): Pick<AccountProfile, 'email' | 'displayName' | 'subscriptionType' | 'organization'> {
  const on = st?.logged_in === true;
  return { email: on ? st.email ?? null : null, displayName: on ? st.display_name ?? null : null,
    subscriptionType: on ? st.subscription_type ?? null : null, organization: on ? st.organization ?? null : null };
}

/** Record what `cursor_auth_status` said about a VPS's Cursor login; the
 *  header re-labels when the email changes. */
export function acceptCursorIdentity(vpsId: string, loggedIn: boolean, email: unknown): void {
  const next = loggedIn && typeof email === 'string' && email.trim() ? email.trim() : null;
  const old = cursorIdentities.get(vpsId);
  cursorIdentities.set(vpsId, next);
  if ((old ?? null) !== next) emitGlobalAccountProfiles(vpsId);
}

export function listAccountProfiles(vpsId?: string): AccountProfile[] {
  const persisted = persistedDefaultKeys();
  const rows = db.select().from(vps).where(vpsId ? eq(vps.id, vpsId) : undefined).all();
  const result: AccountProfile[] = [];
  for (const row of rows) {
    for (const provider of ['claude', 'codex', 'cursor'] as const) {
      const st = profileStatuses.get(statusKey(row.id, provider));
      const login = providerBackendState(row, provider).loggedIn;
      const loggedIn = st?.logged_in ?? (login == null ? null : login === 1);
      result.push({ id: DEFAULT_ACCOUNT_PROFILE, vpsId: row.id, provider, number: 1, name: '',
        loggedIn, accountKey: st ? st.account_key ?? null : persisted[statusKey(row.id, provider)] ?? null,
        ...publicIdentity(st),
        ...(provider === 'cursor' && loggedIn ? { email: cursorIdentities.get(row.id) ?? null } : {}) });
    }
  }
  const extra = db.select().from(accountProfiles).where(and(
    eq(accountProfiles.removed, 0), vpsId ? eq(accountProfiles.vpsId, vpsId) : undefined,
  )).all();
  for (const row of extra) {
    const st = profileStatuses.get(statusKey(row.vpsId, row.provider as SessionProvider, row.id));
    result.push({
      id: row.id, vpsId: row.vpsId, provider: row.provider as SessionProvider,
      number: row.number, name: row.name, loggedIn: row.loggedIn == null ? null : row.loggedIn === 1,
      accountKey: row.accountKey, ...publicIdentity(st),
    });
  }
  return result.sort((a, b) => a.number - b.number);
}

export function requireAccountProfile(vpsId: string, provider: SessionProvider, value: unknown = DEFAULT_ACCOUNT_PROFILE): AccountProfile {
  const id = value ?? DEFAULT_ACCOUNT_PROFILE;
  if (typeof id !== 'string') throw new Error('Invalid account profile');
  if (id === DEFAULT_ACCOUNT_PROFILE) return { id, vpsId, provider, number: 1, name: '', loggedIn: null };
  const row = db.select().from(accountProfiles).where(and(eq(accountProfiles.id, id),
    eq(accountProfiles.vpsId, vpsId), eq(accountProfiles.provider, provider), eq(accountProfiles.removed, 0))).get();
  if (!row) throw new Error('Account profile does not belong to this VPS and provider');
  return { id, vpsId, provider, number: row.number, name: row.name,
    loggedIn: row.loggedIn == null ? null : row.loggedIn === 1, accountKey: row.accountKey };
}

export async function readProfileStatus(vpsId: string, provider: SessionProvider, id = DEFAULT_ACCOUNT_PROFILE, force = false): Promise<ProfileStatus> {
  requireAccountProfile(vpsId, provider, id);
  if (provider === 'cursor') throw new Error('Additional accounts are unavailable for this provider');
  const client = getAgentClientForVpsId(vpsId);
  const response = await client.call<{ ok: boolean; profiles: ProfileStatus[] }>('account_profiles', {
    profiles: [{ provider, id }], force,
  });
  const status = response.profiles?.[0];
  if (!status || status.provider !== provider || status.account_profile !== id) throw new Error('Account check returned the wrong profile');
  await acceptProfileStatus(vpsId, status);
  if (!status.ok || typeof status.logged_in !== 'boolean') throw new Error(status.error ?? 'Account information unavailable');
  return status;
}

/** Transcript browsing must work even when the SDK cannot sign in or boot. */
export async function accountProfileDirectory(vpsId: string, provider: SessionProvider, id: string): Promise<string> {
  const profile = requireAccountProfile(vpsId, provider, id);
  if (profile.number === 1 || provider === 'cursor') throw new Error('An isolated profile is required');
  const cached = profileStatuses.get(statusKey(vpsId, provider, id))?.config_dir;
  if (cached) return cached;
  const client = getAgentClientForVpsId(vpsId);
  if (client.status === 'connected') {
    try {
      const response = await client.call<{ profiles: ProfileStatus[] }>('account_profiles', { profiles: [{ provider, id }] });
      const result = response.profiles?.[0];
      if (result?.provider === provider && result.account_profile === id && result.config_dir) return result.config_dir;
    } catch { /* Read the managed instance directory over SSH below. */ }
  }
  const row = db.select().from(vps).where(eq(vps.id, vpsId)).get();
  if (!row) throw new Error('VPS not found');
  const script = 'import sys; from pathlib import Path; p=Path.home()/sys.argv[1]/"accounts"/sys.argv[2]/sys.argv[3]; assert p.is_dir(), "Account profile directory unavailable"; print(p)';
  const command = `PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3); "$PY" -c ${shQuote(script)} ${shQuote(AGENT_DIR_NAME)} ${shQuote(provider)} ${shQuote(id)}`;
  const result = await sshExec(row, command, { timeoutMs: 12_000 });
  if (!result.ok || !result.stdout.trim().startsWith('/')) throw new Error('Account profile directory unavailable');
  return result.stdout.trim();
}

async function acceptProfileStatus(vpsId: string, st: ProfileStatus): Promise<void> {
  const key = statusKey(vpsId, st.provider, st.account_profile);
  const old = profileStatuses.get(key);
  if (!st.ok || typeof st.logged_in !== 'boolean') {
    if (old && st.generation && old.generation !== st.generation) {
      profileStatuses.set(key, { ...old, ...st, logged_in: old.logged_in, account_key: null });
      const usage = await import('./usagePoll');
      usage.invalidateAccountProfileUsage(vpsId, st.provider, st.account_profile, null);
      emitGlobalAccountProfiles(vpsId);
    }
    return;
  }
  profileStatuses.set(key, st);
  const changed = !old || old.account_key !== st.account_key || old.logged_in !== st.logged_in;
  if (!changed) {
    // Same login, new public identity (an agent update, a renamed account): only the labels move.
    if (old.email !== st.email || old.display_name !== st.display_name
      || old.organization !== st.organization || old.subscription_type !== st.subscription_type) emitGlobalAccountProfiles(vpsId);
    return;
  }
  let priorKey: string | null = null;
  if (st.account_profile !== DEFAULT_ACCOUNT_PROFILE) {
    priorKey = db.select({ accountKey: accountProfiles.accountKey }).from(accountProfiles)
      .where(and(eq(accountProfiles.id, st.account_profile), eq(accountProfiles.vpsId, vpsId))).get()?.accountKey ?? null;
    db.update(accountProfiles).set({ loggedIn: st.logged_in ? 1 : 0, accountKey: st.account_key ?? null })
      .where(and(eq(accountProfiles.id, st.account_profile), eq(accountProfiles.vpsId, vpsId))).run();
  } else {
    persistDefaultKey(vpsId, st.provider, st.logged_in ? st.account_key ?? null : null);
    const patch = providerLoginPatch(st.provider, st.logged_in ? 1 : 0);
    db.update(vps).set(patch).where(eq(vps.id, vpsId)).run();
    // The STORED runtime (V6): a hard-coded 'ok' repainted an errored agent green.
    emitGlobalVpsRuntimeFromDb(vpsId);
  }
  if (st.provider === 'codex') {
    const models = await import('../hub/codexModels');
    models.invalidateCodexAccountModels(vpsId, st.account_profile);
  }
  const usage = await import('./usagePoll');
  usage.invalidateAccountProfileUsage(vpsId, st.provider, st.account_profile, st.account_key ?? null,
    old ? true : { firstSighting: true, priorKey });
  emitGlobalAccountProfiles(vpsId);
}

export async function createAccountProfile(vpsId: string, provider: SessionProvider, name: string): Promise<AccountProfile> {
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Additional accounts are unavailable for this provider');
  if (!db.select().from(vps).where(eq(vps.id, vpsId)).get()) throw new Error('VPS not found');
  const id = randomBytes(8).toString('hex');
  // Feature probe before writing; an old daemon must never silently use its default login.
  const client = getAgentClientForVpsId(vpsId);
  const probe = await client.call<{ profiles: ProfileStatus[] }>('account_profiles', { profiles: [{ provider, id }] });
  if (!probe.profiles?.[0]?.ok) throw new Error(probe.profiles?.[0]?.error ?? 'Could not prepare account profile');
  const profile = db.transaction((tx) => {
    const rows = tx.select().from(accountProfiles).where(and(eq(accountProfiles.vpsId, vpsId), eq(accountProfiles.provider, provider))).all();
    if (rows.filter((r) => !r.removed).length >= 12) throw new Error('At most 12 additional accounts per provider');
    const number = Math.max(1, ...rows.map((r) => r.number)) + 1;
    tx.insert(accountProfiles).values({ id, vpsId, provider, number, name }).run();
    return { id, vpsId, provider, number, name, loggedIn: false } as AccountProfile;
  });
  await acceptProfileStatus(vpsId, probe.profiles[0]);
  emitGlobalAccountProfiles(vpsId);
  return profile;
}

export function renameAccountProfile(vpsId: string, provider: SessionProvider, id: string, name: string): void {
  requireAccountProfile(vpsId, provider, id);
  if (id === DEFAULT_ACCOUNT_PROFILE) throw new Error('The default profile cannot be renamed or removed');
  db.update(accountProfiles).set({ name }).where(eq(accountProfiles.id, id)).run();
  emitGlobalAccountProfiles(vpsId);
}

/** Sign an EXTRA profile out on its VPS, then verify it. The default account
 *  keeps its provider's own logout route. Claude has no agent RPC for this: its
 *  CLI logs out over SSH against the profile's config dir. */
export async function signOutAccountProfile(vpsId: string, provider: SessionProvider, id: string): Promise<void> {
  const profile = requireAccountProfile(vpsId, provider, id);
  if (profile.id === DEFAULT_ACCOUNT_PROFILE) throw new Error('Use the provider logout for the default account');
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Additional accounts are unavailable for this provider');
  const row = db.select().from(vps).where(eq(vps.id, vpsId)).get();
  if (!row) throw new Error('VPS not found');
  if (provider === 'codex') {
    const response = await getAgentClientForVpsId(vpsId).call<{ ok: boolean; error?: string }>('codex_logout', { account_profile: profile.id });
    if (!response.ok) throw new Error(response.error ?? 'Logout failed');
  } else {
    const { stopLoginSession } = await import('./loginSession');
    stopLoginSession(vpsId, profile.id);
    const st = await readProfileStatus(vpsId, provider, profile.id);
    if (!st.config_dir) throw new Error('Account profile directory unavailable');
    const command = `PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"; CLAUDE_CONFIG_DIR=${shQuote(st.config_dir)} claude auth logout`;
    const response = await sshExec(row, command, { timeoutMs: 20_000 });
    if (!response.ok) throw new Error('Logout failed');
  }
  const status = await readProfileStatus(vpsId, provider, profile.id, true);
  if (status.logged_in) throw new Error('This account profile is still signed in');
}

/** Removing a profile never leaves a working login on the VPS: it is signed
 *  out first, so an unreachable VPS refuses the removal. Its history stays on
 *  disk (an unimported transcript is still the user's). */
export async function removeAccountProfile(vpsId: string, provider: SessionProvider, id: string): Promise<void> {
  requireAccountProfile(vpsId, provider, id);
  if (id === DEFAULT_ACCOUNT_PROFILE) throw new Error('The default profile cannot be renamed or removed');
  const used = db.select({ id: agentSessions.id }).from(agentSessions).where(and(
    eq(agentSessions.vpsId, vpsId), eq(agentSessions.kind, provider),
    sql`json_extract(${agentSessions.providerConfig}, '$.accountProfile') = ${id}`,
  )).get();
  if (used) throw new Error('Delete this profile’s sessions before removing it');
  let status: ProfileStatus;
  try { status = await readProfileStatus(vpsId, provider, id, true); }
  catch { throw new Error('This VPS must be reachable to sign the account out before removing it'); }
  if (status.logged_in) await signOutAccountProfile(vpsId, provider, id);
  db.update(accountProfiles).set({ removed: 1, loggedIn: 0, accountKey: null })
    .where(eq(accountProfiles.id, id)).run();
  profileStatuses.delete(statusKey(vpsId, provider, id));
  emitGlobalAccountProfiles(vpsId);
}

export function armAccountProfileWatch(vpsId: string): void {
  const tick = (): Promise<void> => {
    const existing = checks.get(vpsId);
    if (existing) return existing;
    const run = (async () => {
      const client = getAgentClientForVpsId(vpsId);
      if (client.status !== 'connected') return;
      const profiles = listAccountProfiles(vpsId).filter((p) => p.provider === 'claude' || (p.provider === 'codex' && client.hello?.codex_available));
      const usage = await import('./usagePoll');
      let response: { profiles: ProfileStatus[] } | null = null;
      try {
        response = await client.call<{ profiles: ProfileStatus[] }>('account_profiles', {
          profiles: profiles.map((p) => ({ provider: p.provider, id: p.id })),
        });
        for (const st of response.profiles ?? []) {
          await acceptProfileStatus(vpsId, st);
          if (st.account_profile !== DEFAULT_ACCOUNT_PROFILE && st.logged_in) {
            void usage.pollAccountProfileUsage(vpsId, st.provider, st.account_profile, { steady: true });
          }
        }
      } finally {
        // An answer — even a failure or an old agent's -32601 — ends the wait
        // the usage poller keeps for this VPS's identity, AFTER that identity
        // is recorded (§14.72).
        if (!identityChecked.has(vpsId)) {
          identityChecked.add(vpsId);
          void usage.pollUsageForVps(vpsId, { steady: true });
        }
      }
    })().catch(() => {}).finally(() => checks.delete(vpsId));
    checks.set(vpsId, run);
    return run;
  };
  void tick();
  if (watches.has(vpsId)) return;
  const timer = setInterval(() => void tick(), 15_000);
  timer.unref?.();
  watches.set(vpsId, timer);
}
