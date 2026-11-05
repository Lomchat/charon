import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '@/lib/types/api';
import { sameLoginProfiles, usageAccountLabel, type AccountProfile } from '@/lib/accountProfiles';
import type { AccountUsage } from '@/lib/server/hub/types';
import {
  accountGroupKey, accountGroupRepresentative, accountGroupUsage, buildAccountGroups,
} from '@/lib/accountGroups';
import { navAttentionClass, rowOf } from '@/app/HeaderSessionNav';

const s = (id: string, extra: Partial<SessionListItem> & Record<string, unknown> = {}): SessionListItem => ({
  id, vpsId: 'a', name: id, cwd: '/p', kind: 'claude', status: 'active', createdAt: 1, ...extra,
} as unknown as SessionListItem);

const prof = (extra: Partial<AccountProfile>): AccountProfile => ({
  id: 'default', vpsId: 'a', provider: 'claude', number: 1, name: '', loggedIn: true,
  accountKey: null, email: null, ...extra,
});

const ALL_ON = { claude: true, codex: true, cursor: true };
const names: Record<string, string> = { a: 'alpha', b: 'beta' };
const vpsName = (id: string) => names[id] ?? id;
const build = (sessions: SessionListItem[], profiles: AccountProfile[], enabled = ALL_ON) =>
  buildAccountGroups({ sessions, profiles, enabled, vpsName });

describe('buildAccountGroups — one group per login across VPSes', () => {
  it('the same accountKey on two VPSes (different profile ids) is ONE group with both sessions', () => {
    const profiles = [
      prof({ vpsId: 'a', accountKey: 'K', email: 'me@x.io' }),
      prof({ vpsId: 'b', id: 'p2', number: 2, accountKey: 'K', email: 'me@x.io' }),
    ];
    const groups = build([
      s('s1', { vpsId: 'a' }),
      s('s2', { vpsId: 'b', accountProfile: 'p2', accountProfileNumber: 2 }),
    ], profiles);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('acct:claude:K');
    expect(groups[0].members.map((m) => m.usageKey)).toEqual(['a:claude:default', 'b:claude:p2']);
    expect(groups[0].sessions.map((x) => x.id).sort()).toEqual(['s1', 's2']);
    expect(groups[0].vpsNames).toEqual(['alpha', 'beta']);
    expect(groups[0].title).toContain('me@x.io');
    expect(groups[0].title).toContain('alpha, beta');
  });

  it('the key includes the provider', () => {
    const groups = build([s('c'), s('x', { kind: 'codex' })],
      [prof({ accountKey: 'K' }), prof({ provider: 'codex', accountKey: 'K' })]);
    expect(groups.map((g) => g.key)).toEqual(['acct:claude:K', 'acct:codex:K']);
  });

  it('no identity ⇒ one group per (vps, provider, profile); Cursor never merges across VPSes', () => {
    const groups = build([
      s('c1', { kind: 'cursor', vpsId: 'a' }),
      s('c2', { kind: 'cursor', vpsId: 'b' }),
    ], [prof({ provider: 'cursor', vpsId: 'a' }), prof({ provider: 'cursor', vpsId: 'b' })]);
    expect(groups.map((g) => g.key)).toEqual(['local:a:cursor:default', 'local:b:cursor:default']);
    // Two unnamed logins would read alike: the machine tells them apart.
    expect(groups.map((g) => g.label)).toEqual(['Cursor · alpha', 'Cursor · beta']);
  });

  it('a session whose profile is unknown falls back to its own (vps, provider, profile) group', () => {
    const groups = build([s('x', { kind: 'codex', vpsId: 'b', accountProfile: 'p7', accountProfileNumber: 3 })], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(accountGroupKey('codex', 'b', 'p7', null));
    expect(groups[0].label).toBe('Codex 3');
  });

  it('custom-endpoint sessions join their login for the list/attention, never for usage weight', () => {
    const ep = { endpoint: { active: { id: 'ep' } } } as unknown as Partial<SessionListItem>;
    const groups = build([s('e', ep), s('n')], [prof({ accountKey: 'K' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((x) => x.id).sort()).toEqual(['e', 'n']);
    expect(groups[0].members[0].sessionCount).toBe(1);
    // Its login has no button otherwise: the session still lights exactly one.
    const alone = build([s('e', ep)], [prof({ loggedIn: false })]);
    expect(alone).toHaveLength(1);
    expect(alone[0].sessions.map((x) => x.id)).toEqual(['e']);
    expect(alone[0].members[0].sessionCount).toBe(0);
    // On no account at all (hub accounts, §14.115): no account button.
    expect(build([s('e', { ...ep, accountProfile: 'default' })], [prof({ id: 'aaaaaaaaaaaaaaaa', accountKey: 'K' })])).toEqual([]);
  });

  it('two logins with the same name on the same machine still read apart', () => {
    const groups = build([s('x'), s('y', { accountProfile: 'p2', accountProfileNumber: 2 })], [
      prof({ accountKey: 'X', name: 'work' }),
      prof({ id: 'p2', number: 2, accountKey: 'Y', name: 'work' }),
    ]);
    const labels = groups.map((g) => g.label);
    expect(new Set(labels).size).toBe(2);
    expect(labels).toContain('Claude 2 · work · alpha');
  });

  it('visibility: ONLY a login with at least one live, non-archived session', () => {
    const off = { ...ALL_ON, codex: false };
    expect(build([s('x', { kind: 'codex' })], [prof({ provider: 'codex', accountKey: 'C' })], off)
      .map((g) => g.key)).toEqual(['acct:codex:C']);
    expect(build([], [prof({ loggedIn: false }), prof({ vpsId: 'b', loggedIn: null })])).toEqual([]);
    // Signed in, nothing connected ⇒ no button.
    expect(build([], [prof({ accountKey: 'K' })])).toEqual([]);
    for (const status of ['sleeping', 'error', 'killed']) {
      expect(build([s('z', { status })], [prof({ accountKey: 'K' })])).toEqual([]);
    }
    // Every other status is connected, the durable failed-turn state included (§14.68).
    for (const status of ['failed', 'starting', 'active', 'thinking', 'background']) {
      expect(build([s('z', { status })], [prof({ accountKey: 'K' })]).map((g) => g.key)).toEqual(['acct:claude:K']);
    }
    expect(build([s('z', { status: 'active', archived: 1 })], [prof({ accountKey: 'K' })])).toEqual([]);
    // liveStatus wins over the stored status, both ways.
    expect(build([s('z', { status: 'sleeping', liveStatus: 'thinking' })], [prof({ accountKey: 'K' })])
      .map((g) => g.key)).toEqual(['acct:claude:K']);
    expect(build([s('z', { status: 'active', liveStatus: 'sleeping' })], [prof({ accountKey: 'K' })])).toEqual([]);
    // One live session shows the button; the dropdown still lists the finished ones.
    const [g] = build([s('live', { status: 'thinking' }), s('done', { status: 'sleeping', vpsId: 'b' })],
      [prof({ accountKey: 'K' }), prof({ vpsId: 'b', accountKey: 'K' })]);
    expect(g.sessions.map((x) => x.id).sort()).toEqual(['done', 'live']);
    // A live custom-endpoint session counts too (it lights this button).
    const ep = { endpoint: { active: { id: 'ep' } } } as unknown as Partial<SessionListItem>;
    expect(build([s('e', ep)], [prof({ accountKey: 'K' })]).map((x) => x.key)).toEqual(['acct:claude:K']);
    // A hidden login never forces a disambiguating suffix on a visible one.
    expect(build([s('a1', { vpsId: 'a' })], [prof({ vpsId: 'a', provider: 'cursor' }), prof({ vpsId: 'b', provider: 'cursor' })])
      .map((x) => x.label)).toEqual(['Claude']);
  });

  it('label: official name > login email > profile name > provider + number; stable provider-then-label order', () => {
    const groups = build([
      s('c', { kind: 'codex' }), s('k1'), s('k2', { vpsId: 'b', accountProfile: 'p2', accountProfileNumber: 2 }),
      s('k0', { vpsId: 'b' }), s('k3', { vpsId: 'b', accountProfile: 'p3', accountProfileNumber: 3 }),
    ], [
      prof({ provider: 'codex', accountKey: 'C', email: 'z@x.io' }),
      // A user-given profile name never beats the provider's identity.
      prof({ accountKey: 'K1', name: 'work', email: 'w@x.io' }),
      prof({ vpsId: 'b', id: 'p2', number: 2, accountKey: 'K2' }),
      prof({ vpsId: 'b', accountKey: 'K0', email: 'a@x.io', displayName: 'Ada' }),
      // Not probed yet: the profile name is all there is.
      prof({ vpsId: 'b', id: 'p3', number: 3, name: 'spare', loggedIn: null }),
    ]);
    expect(groups.map((g) => [g.provider, g.label])).toEqual([
      ['claude', 'Ada'], ['claude', 'Claude 2'], ['claude', 'spare'], ['claude', 'w@x.io'], ['codex', 'z@x.io'],
    ]);
    const ada = groups.find((g) => g.label === 'Ada')!;
    expect(ada.official).toBe('Ada');
    expect(ada.accountLabel).toBe('Claude · Ada · a@x.io');
    expect(ada.title).toBe('Claude · Ada · a@x.io — on beta');
    const work = groups.find((g) => g.label === 'w@x.io')!;
    expect(work.accountLabel).toBe('Claude · w@x.io');
    expect(work.title).not.toContain('work');
    expect(groups.find((g) => g.label === 'spare')!.accountLabel).toBe('Claude 3 · spare');
  });

  it('a renamed second profile still reads as the official account; same official names fall back to the email', () => {
    const groups = build([
      s('x', { vpsId: 'a' }), s('y', { vpsId: 'b', accountProfile: 'p2', accountProfileNumber: 2 }),
      s('z', { vpsId: 'a', accountProfile: 'p9', accountProfileNumber: 2 }),
    ], [
      prof({ vpsId: 'a', accountKey: 'D', email: 'c2@c2m2.ai', displayName: 'Chalom' }),
      prof({ vpsId: 'b', id: 'p2', number: 2, name: 'chalomcohen', accountKey: 'S', email: 'me@gmail.com', displayName: 'Chalom' }),
      prof({ vpsId: 'a', id: 'p9', number: 2, name: '2', accountKey: 'S', email: 'me@gmail.com', displayName: 'Chalom' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual(['c2@c2m2.ai', 'me@gmail.com']);
    expect(groups.map((g) => g.accountLabel)).toEqual(['Claude · Chalom · c2@c2m2.ai', 'Claude · Chalom · me@gmail.com']);
    expect(groups[1].title).toBe('Claude · Chalom · me@gmail.com — on alpha, beta');
    // Alone, the second login is just its official name.
    expect(build([s('y', { vpsId: 'b', accountProfile: 'p2', accountProfileNumber: 2 })], [
      prof({ vpsId: 'b', id: 'p2', number: 2, name: 'chalomcohen', accountKey: 'S', email: 'me@gmail.com', displayName: 'Chalom' }),
    ]).map((g) => g.label)).toEqual(['Chalom']);
    // The session's usage gauges name the SAME official identity, never 'chalomcohen'.
    const second = prof({ vpsId: 'b', id: 'p2', number: 2, name: 'chalomcohen', accountKey: 'S', email: 'me@gmail.com', displayName: 'Chalom' });
    expect(usageAccountLabel('Claude', second)).toBe(groups[1].accountLabel);
  });

  it('tooltip carries the public plan and organization when probed; the label stays the name', () => {
    const [g] = build([s('y', { vpsId: 'b', accountProfile: 'p2', accountProfileNumber: 2 })], [
      prof({ vpsId: 'b', id: 'p2', number: 2, name: 'mine', accountKey: 'S', email: 'me@gmail.com',
        displayName: 'Chalom', subscriptionType: 'max', organization: 'Org' }),
    ]);
    expect(g.label).toBe('Chalom');
    expect(g.plan).toBe('Max');
    expect(g.organization).toBe('Org');
    expect(g.title).toBe('Claude · Chalom · me@gmail.com · Max · Org — on beta');
    expect(g.accountLabel).toBe('Claude · Chalom · me@gmail.com');
  });

  it('a session whose own profile lacks the identity still names the login like its button', () => {
    const profiles = [
      prof({ vpsId: 'a', accountKey: 'S', email: 'me@gmail.com', displayName: 'Chalom' }),
      // Same login on another VPS, its probe not filled in yet: user-given name only.
      prof({ vpsId: 'b', id: 'p2', number: 2, name: 'work', accountKey: 'S' }),
    ];
    const [g] = build([s('x', { vpsId: 'a' }), s('y', { vpsId: 'b', accountProfile: 'p2', accountProfileNumber: 2 })], profiles);
    expect(g.accountLabel).toBe('Claude · Chalom · me@gmail.com');
    expect(usageAccountLabel('Claude', profiles[1], 2, sameLoginProfiles(profiles, profiles[1]))).toBe(g.accountLabel);
    // Alone it would be the profile name; an unverified key never borrows another's identity.
    expect(usageAccountLabel('Claude', profiles[1], 2)).toBe('Claude 2 · work');
    expect(sameLoginProfiles(profiles, { ...profiles[1], accountKey: null })).toHaveLength(1);
  });

  it('Cursor: the login email when the hub knows it, else the provider fallback', () => {
    const [known] = build([s('c', { kind: 'cursor' })], [prof({ provider: 'cursor', email: 'cur@x.io' })]);
    expect(known.label).toBe('cur@x.io');
    expect(known.title).toContain('cur@x.io');
    const [unknown] = build([s('c', { kind: 'cursor' })], [prof({ provider: 'cursor' })]);
    expect(unknown.label).toBe('Cursor');
  });
});

describe('accountGroupUsage / representative', () => {
  const u = (extra: Partial<AccountUsage>): AccountUsage => ({ ok: true, fetchedAt: 1, ...extra } as AccountUsage);
  const [group] = build([s('s2', { vpsId: 'b', accountProfile: 'p2' })], [
    prof({ vpsId: 'a', accountKey: 'K' }),
    prof({ vpsId: 'b', id: 'p2', number: 2, accountKey: 'K' }),
  ]);

  const by = (map: Record<string, AccountUsage>) => (m: { usageKey: string }) => map[m.usageKey];

  it('newest good reading across members; another login\'s reading never shows', () => {
    expect(accountGroupUsage(group, by({}))).toBeNull();
    const older = u({ fetchedAt: 10, accountKey: 'K' });
    const newer = u({ fetchedAt: 20, accountKey: 'K' });
    expect(accountGroupUsage(group, by({ 'a:claude:default': older, 'b:claude:p2': newer }))).toBe(newer);
    const foreign = u({ fetchedAt: 99, accountKey: 'OTHER' });
    expect(accountGroupUsage(group, by({ 'a:claude:default': foreign, 'b:claude:p2': older }))).toBe(older);
    const failed = u({ ok: false, fetchedAt: 50, accountKey: 'K' });
    expect(accountGroupUsage(group, by({ 'a:claude:default': failed, 'b:claude:p2': older }))).toBe(older);
  });

  it('the lookup is asked with the group\'s provider for every member', () => {
    const asked: string[] = [];
    accountGroupUsage(group, (m, provider) => { asked.push(`${m.vpsId}:${provider}:${m.profileId}`); return null; });
    expect(asked.sort()).toEqual(['a:claude:default', 'b:claude:p2']);
  });

  it('the representative is a member with sessions', () => {
    expect(accountGroupRepresentative(group).usageKey).toBe('b:claude:p2');
  });

  it('the representative prefers a signed-in member on a reachable VPS', () => {
    expect(accountGroupRepresentative(group, (v) => v !== 'b').usageKey).toBe('a:claude:default');
    expect(accountGroupRepresentative(group, () => false).usageKey).toBe('a:claude:default');
  });
});

describe('per-account attention = the global nav predicate over its sessions', () => {
  it('a blocked session on another VPS of the same login lights its account orange, like the global nav', () => {
    const sessions = [
      s('done', { vpsId: 'a', unreadStop: 1 }),
      s('blocked', { vpsId: 'b', accountProfile: 'p2', status: 'thinking', pendingBlocking: 1, pendingAsync: 0 }),
      s('other', { kind: 'codex', vpsId: 'a', unreadStop: 1 }),
    ];
    const groups = build(sessions, [
      prof({ vpsId: 'a', accountKey: 'K' }),
      prof({ vpsId: 'b', id: 'p2', number: 2, accountKey: 'K' }),
      prof({ provider: 'codex', accountKey: 'C' }),
    ]);
    const cls = (xs: SessionListItem[], viewed: string | null = null) => navAttentionClass(xs.map((x) => rowOf(x, viewed)));
    expect(groups.map((g) => [g.key, cls(g.sessions)])).toEqual([
      ['acct:claude:K', 'has-waiting'], ['acct:codex:C', 'has-unread'],
    ]);
    expect(cls(sessions)).toBe('has-waiting');
    // Viewing the only unread session here clears it, as on the global nav.
    expect(cls(groups[1].sessions, 'other')).toBe('');
  });
});
