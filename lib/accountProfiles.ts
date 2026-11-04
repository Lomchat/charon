import { asSessionProvider, type SessionProvider } from './sessionCapabilities';

export const DEFAULT_ACCOUNT_PROFILE = 'default';
export type AccountProfile = {
  id: string;
  vpsId: string;
  provider: SessionProvider;
  number: number;
  name: string;
  loggedIn: boolean | null;
  accountKey?: string | null;
  /** Login identity the agent verified (public, like the account menu's). */
  email?: string | null;
  /** The provider's own name for that login (Claude `displayName`), never the profile name. */
  displayName?: string | null;
  /** Public plan / organization of that login (the account menu's fields). */
  subscriptionType?: string | null;
  organization?: string | null;
};

export function accountProfileId(config: unknown): string {
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { return DEFAULT_ACCOUNT_PROFILE; }
  }
  if (config && typeof config === 'object' && !('accountProfile' in config) && 'providerConfig' in config) {
    return accountProfileId((config as { providerConfig: unknown }).providerConfig);
  }
  const id = (config as { accountProfile?: unknown } | null)?.accountProfile;
  return typeof id === 'string' && id ? id : DEFAULT_ACCOUNT_PROFILE;
}

export function accountProfileNumber(config: unknown): number {
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { return 1; }
  }
  if (config && typeof config === 'object' && !('accountProfileNumber' in config) && 'providerConfig' in config) {
    return accountProfileNumber((config as { providerConfig: unknown }).providerConfig);
  }
  const n = (config as { accountProfileNumber?: unknown } | null)?.accountProfileNumber;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : 1;
}

export function profileUsageKey(vpsId: string, provider: SessionProvider, profile = DEFAULT_ACCOUNT_PROFILE): string {
  return `${vpsId}:${provider}:${profile}`;
}

export function profileLabel(providerName: string, profile: AccountProfile): string {
  return `${providerName}${profile.number > 1 ? ` ${profile.number}` : ''}${profile.name ? ` · ${profile.name}` : ''}`;
}

/** The profile a session runs on: matched by (VPS, provider, profile id) —
 *  two profiles on one VPS must never resolve to each other. */
export function sessionAccountProfile(
  profiles: readonly AccountProfile[],
  session: { vpsId?: string | null; kind?: string | null; providerConfig?: unknown } | null | undefined,
): AccountProfile | undefined {
  if (!session) return undefined;
  const provider = asSessionProvider(session.kind);
  const id = accountProfileId(session);
  return profiles.find((p) => p.vpsId === session.vpsId && p.provider === provider && p.id === id);
}

/** THE official-name rule for a login, shared by the header account buttons
 *  (`accountGroups.ts`) and every usage gauge (`usageAccountLabel`) so they
 *  never diverge: the PROVIDER's display name (Claude `displayName`), else the
 *  verified login email. `name` = the short form (button text), `label` = the
 *  full form ("Chalom · c2@c2m2.ai"). Both null until a probe verified an
 *  identity — only then may a caller fall back to the user-given profile name.
 *  Several profiles (one login across VPSes): pass them best-first. */
export function accountIdentity(
  profiles: readonly (AccountProfile | null | undefined)[],
): { official: string | null; email: string | null; name: string | null; label: string | null } {
  const first = (pick: (p: AccountProfile) => string | null | undefined) =>
    profiles.map((p) => (p ? pick(p)?.trim() : '')).find((v): v is string => !!v) ?? null;
  const official = first((p) => p.displayName);
  const email = first((p) => p.email);
  const name = official || email;
  return { official, email, name, label: official && email ? `${official} · ${email}` : name };
}

/** Every profile of `profile`'s LOGIN (same provider + `accountKey`, any VPS),
 *  by number — the set a header account button aggregates its identity over.
 *  No verified key ⇒ the profile alone (an unverified identity is never shared). */
export function sameLoginProfiles(
  profiles: readonly AccountProfile[], profile: AccountProfile | null | undefined,
): AccountProfile[] {
  if (!profile) return [];
  if (!profile.accountKey) return [profile];
  return profiles.filter((p) => p.provider === profile.provider && p.accountKey === profile.accountKey)
    .sort((a, b) => a.number - b.number);
}

/** Whose usage a gauge shows — THE full label of a login, identical on the
 *  header account popover (`accountGroups.ts`) and the session gauges: the
 *  provider + the login's OFFICIAL identity (`accountIdentity` over `login`,
 *  every profile of that login: "Claude · Chalom · c2@c2m2.ai"), never the
 *  user-given profile name once that identity is known. Before a probe: the
 *  menus' `profileLabel` ("Claude 2 · work"); unknown profile ⇒ provider + number. */
export function usageAccountLabel(
  providerName: string, profile: AccountProfile | null | undefined, number = 1,
  login: readonly AccountProfile[] = profile ? [profile] : [],
): string {
  const { label } = accountIdentity(login);
  if (label) return `${providerName} · ${label}`;
  return profile ? profileLabel(providerName, profile) : `${providerName}${number > 1 ? ` ${number}` : ''}`;
}
