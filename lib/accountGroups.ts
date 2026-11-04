// Per-ACCOUNT header buttons (app/AccountNav.tsx, CLAUDE.md §11): which logins
// this hub uses, across every VPS. Pure and browser-safe — no React, no clock.
//
// One group = provider + login identity (`AccountProfile.accountKey`, the
// agent's hash of the native account ids: VPS- and profile-independent, the
// same key the usage poller shares gauges on, §14.58/§14.72). The same login
// on three VPSes is ONE group. A profile with no verified identity (Cursor
// never has one; a default profile until its VPS was probed) is its own
// group, keyed (vps, provider, profile): an unverified identity is never
// shared (§14.72).
//
// Sessions on a custom endpoint join their login's group for the dropdown and
// the attention pulse only (every session that can light the global nav lights
// exactly one account button), never for usage: they bill the endpoint, not
// the login (§4 customEndpoints), so they neither make a member nor count
// towards `sessionCount`.
//
// Visibility: a group gets a button ONLY while at least one of its
// non-archived sessions is LIVE (`isLiveRow`, lib/sessionAttention.ts). A
// signed-in profile with nothing connected shows nothing; once visible, the
// dropdown lists every session of the login (finished ones included).
import type { SessionListItem } from '@/lib/types/api';
import type { AccountUsage } from '@/lib/server/hub/types';
import { SESSION_PROVIDERS, asSessionProvider, type SessionProvider } from './sessionCapabilities';
import { providerName, providerText } from './providerText';
import {
  accountIdentity, accountProfileId, accountProfileNumber, profileUsageKey, sessionAccountProfile, usageAccountLabel,
  type AccountProfile,
} from './accountProfiles';
import { accountUsageReadAt } from '@/app/accountUsageState';
import { isLiveRow } from './sessionAttention';

export type AccountMember = {
  vpsId: string;
  profileId: string;
  /** Null when the session names a profile the store does not (yet) list. */
  profile: AccountProfile | null;
  /** `profileUsageKey(vps, provider, profile)` — the usage store's key. */
  usageKey: string;
  /** Number of this member's LOGIN-billed sessions (custom-endpoint ones excluded). */
  sessionCount: number;
};

export type AccountGroup = {
  /** `acct:<provider>:<accountKey>` or `local:<vps>:<provider>:<profile>`. */
  key: string;
  provider: SessionProvider;
  accountKey: string | null;
  /** Sorted by VPS id, then profile number. Never empty. */
  members: AccountMember[];
  sessions: SessionListItem[];
  /** Short visible label (the logo carries the provider): the official
   *  display name, else the login email, else the profile label (unprobed). */
  label: string;
  /** Full identity: official name + email + plan + org + VPSes (tooltip/aria). */
  title: string;
  /** What the usage popover shows: `usageAccountLabel` over the group's
   *  profiles — byte-identical to the session gauges of the same login. */
  accountLabel: string;
  email: string | null;
  /** The provider's own display name for the login (Claude `displayName`). */
  official: string | null;
  /** Public plan (`max`, `pro` → "Max", "Pro") and organization, when probed. */
  plan: string | null;
  organization: string | null;
  signedIn: boolean;
  vpsNames: string[];
};

export function accountGroupKey(
  provider: SessionProvider, vpsId: string, profileId: string, profile: AccountProfile | null | undefined,
): string {
  const key = profile?.accountKey;
  return key ? `acct:${provider}:${key}` : `local:${vpsId}:${provider}:${profileId}`;
}

type Draft = {
  key: string;
  provider: SessionProvider;
  accountKey: string | null;
  members: Map<string, AccountMember>;
  sessions: SessionListItem[];
  /** Fallback profile number when no profile row is known (session-only). */
  number: number;
};

export function buildAccountGroups(input: {
  sessions: readonly SessionListItem[];
  profiles: readonly AccountProfile[];
  enabled: Readonly<Record<SessionProvider, boolean>>;
  vpsName: (vpsId: string) => string;
}): AccountGroup[] {
  const { sessions, profiles, enabled, vpsName } = input;
  const drafts = new Map<string, Draft>();
  const member = (provider: SessionProvider, vpsId: string, profileId: string, profile: AccountProfile | null, number: number) => {
    const key = accountGroupKey(provider, vpsId, profileId, profile);
    let d = drafts.get(key);
    if (!d) {
      d = { key, provider, accountKey: profile?.accountKey || null, members: new Map(), sessions: [], number };
      drafts.set(key, d);
    }
    const usageKey = profileUsageKey(vpsId, provider, profileId);
    let m = d.members.get(usageKey);
    if (!m) {
      m = { vpsId, profileId, profile, usageKey, sessionCount: 0 };
      d.members.set(usageKey, m);
    } else if (!m.profile && profile) {
      m.profile = profile;
    }
    return { d, m };
  };

  const viaEndpoint: Array<[string, SessionListItem]> = [];
  for (const s of sessions) {
    const provider = asSessionProvider(s.kind);
    const profile = sessionAccountProfile(profiles, s) ?? null;
    if (s.endpoint?.active) {
      viaEndpoint.push([accountGroupKey(provider, s.vpsId, accountProfileId(s), profile), s]);
      continue;
    }
    const { d, m } = member(provider, s.vpsId, accountProfileId(s), profile, accountProfileNumber(s));
    d.sessions.push(s);
    m.sessionCount += 1;
  }
  for (const p of profiles) {
    if (p.loggedIn !== true || !enabled[p.provider]) continue;
    member(p.provider, p.vpsId, p.id, p, p.number);
  }
  for (const [key, s] of viaEndpoint) {
    const d = drafts.get(key);
    if (d) { d.sessions.push(s); continue; }
    // Its login has no button of its own (signed out, backend off): the
    // session still needs one, so it makes a member without usage weight.
    const provider = asSessionProvider(s.kind);
    member(provider, s.vpsId, accountProfileId(s), sessionAccountProfile(profiles, s) ?? null, accountProfileNumber(s))
      .d.sessions.push(s);
  }

  const connected = (x: SessionListItem) => !(x as { archived?: unknown }).archived && isLiveRow(x);
  const groups = [...drafts.values()].filter((d) => d.sessions.some(connected)).map((d): AccountGroup => {
    const members = [...d.members.values()].sort((a, b) =>
      a.vpsId.localeCompare(b.vpsId) || (a.profile?.number ?? 0) - (b.profile?.number ?? 0)
      || a.profileId.localeCompare(b.profileId));
    const known = members.map((m) => m.profile).filter((p): p is AccountProfile => !!p)
      .sort((a, b) => a.number - b.number);
    const named = known.find((p) => p.name.trim());
    const { official, email, name: identity } = accountIdentity(known);
    const plan = known.map((p) => p.subscriptionType?.trim()).find((n): n is string => !!n) ?? null;
    const organization = known.map((p) => p.organization?.trim()).find((n): n is string => !!n) ?? null;
    const best = named ?? known[0] ?? null;
    const number = best?.number ?? d.number;
    const name = providerName(d.provider);
    // THE official-name rule (`accountIdentity`, shared with the session usage
    // gauges); the user-given profile name only until a probe verified one.
    const label = identity || named?.name.trim() || `${name}${number > 1 ? ` ${number}` : ''}`;
    // The SAME full string the session gauges show for this login.
    const accountLabel = usageAccountLabel(name, best, number, known);
    const vpsNames = [...new Set(members.map((m) => vpsName(m.vpsId)))];
    return {
      key: d.key,
      provider: d.provider,
      accountKey: d.accountKey,
      members,
      sessions: d.sessions,
      label,
      title: '',
      accountLabel,
      email,
      official,
      plan: plan ? planLabel(plan) : null,
      organization,
      signedIn: known.some((p) => p.loggedIn === true),
      vpsNames,
    };
  });

  // Two different logins that would read alike (two accounts both called
  // "Chalom") fall back to their official email; still alike ⇒ their machine,
  // then the numbered profile label (usageAccountLabel), then a key suffix.
  const clash = (g: AccountGroup) => groups.some((o) => o !== g && o.provider === g.provider && o.label === g.label);
  for (const g of groups.filter(clash)) if (g.email) g.label = g.email;
  for (const g of groups.filter(clash)) g.label = `${g.label} · ${g.vpsNames.join(', ')}`;
  for (const g of groups.filter(clash)) g.label = `${g.accountLabel} · ${g.vpsNames.join(', ')}`;
  for (const g of groups.filter(clash)) {
    g.label = `${g.label} · ${g.email && !g.label.includes(g.email) ? g.email : (g.accountKey ?? g.key).slice(-6)}`;
  }
  for (const g of groups) {
    const parts = [g.accountLabel];
    if (g.email && !g.accountLabel.includes(g.email)) parts.push(g.email);
    for (const extra of [g.plan, g.organization]) if (extra && !parts.includes(extra)) parts.push(extra);
    const full = parts.join(' · ');
    g.title = providerText.accountButton(g.provider, full, g.vpsNames);
  }

  // Stable order: buttons never move under the pointer on activity.
  const rank = (p: SessionProvider) => SESSION_PROVIDERS.indexOf(p);
  return groups.sort((a, b) =>
    rank(a.provider) - rank(b.provider) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/** A provider plan id as the account menu shows it (`claude_max` → "Claude Max"). */
function planLabel(plan: string): string {
  return plan.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The group's gauges: the newest reading over its members. A reading stamped
 *  with ANOTHER login never shows (§14.58); a good reading outranks a failure. */
export function accountGroupUsage(
  group: AccountGroup, usageByKey: Readonly<Record<string, AccountUsage | undefined>>,
): AccountUsage | null {
  let best: AccountUsage | null = null;
  for (const m of group.members) {
    const u = usageByKey[m.usageKey];
    if (!u) continue;
    const expected = group.accountKey ?? m.profile?.accountKey ?? null;
    if (expected && u.accountKey && u.accountKey !== expected) continue;
    if (!best
      || (u.ok && !best.ok)
      || (u.ok === best.ok && accountUsageReadAt(u) > accountUsageReadAt(best))) best = u;
  }
  return best;
}

/** The member a forced refresh polls: one that can ANSWER first — signed in
 *  on a reachable VPS (with sessions preferred) — then any signed-in one, then
 *  one with sessions, then the first. `reachable` defaults to "yes". */
export function accountGroupRepresentative(
  group: AccountGroup, reachable: (vpsId: string) => boolean = () => true,
): AccountMember {
  const live = group.members.filter((m) => m.profile?.loggedIn === true && reachable(m.vpsId));
  return live.find((m) => m.sessionCount > 0) ?? live[0]
    ?? group.members.find((m) => m.profile?.loggedIn === true)
    ?? group.members.find((m) => m.sessionCount > 0)
    ?? group.members[0];
}
