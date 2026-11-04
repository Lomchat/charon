import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import UsageMeter, { UsagePopover, UsageRings } from '../app/UsageMeter';
import { accountIdentity, sessionAccountProfile, usageAccountLabel, type AccountProfile } from '@/lib/accountProfiles';
import { newestAccountUsage } from '@/app/accountUsageState';
import type { AccountUsage } from '@/lib/server/hub/types';

// The vitest transform is classic JSX.
(globalThis as { React?: typeof React }).React = React;

const P = (over: Partial<AccountProfile>): AccountProfile =>
  ({ id: 'default', vpsId: 'v', provider: 'claude', number: 1, name: '', loggedIn: true, ...over });

// Whose usage the popover shows: the login's OFFICIAL identity, by the SAME
// rule as the header account buttons (accountIdentity), never the user-given
// profile name once that identity is known.
describe('usage account label', () => {
  it('names the official identity (displayName > email), the profile name only before a probe', () => {
    expect(usageAccountLabel('Claude', P({ email: 'c2@c2m2.ai', displayName: 'Chalom' }))).toBe('Claude · Chalom · c2@c2m2.ai');
    expect(usageAccountLabel('Claude', P({ id: 'p2', number: 2, name: 'chalomcohen', email: 'chalomcohen01@gmail.com', displayName: 'Chalom' })))
      .toBe('Claude · Chalom · chalomcohen01@gmail.com');
    expect(usageAccountLabel('Claude', P({ id: 'p2', number: 2, name: 'work', email: 'a@x.io' }))).toBe('Claude · a@x.io');
    expect(usageAccountLabel('Claude', P({ id: 'p2', number: 2, name: 'work', displayName: ' Ada ' }))).toBe('Claude · Ada');
    expect(usageAccountLabel('Claude', P({ id: 'p2', number: 2, name: '2' }))).toBe('Claude 2 · 2');
    expect(usageAccountLabel('Codex', P({ provider: 'codex', email: 'b@x.io' }))).toBe('Codex · b@x.io');
    expect(usageAccountLabel('Claude', P({ id: 'p3', number: 3 }))).toBe('Claude 3');
    expect(usageAccountLabel('Claude', undefined, 2)).toBe('Claude 2');
  });

  it('can never diverge from the header account button', () => {
    for (const p of [P({ email: 'c2@c2m2.ai', displayName: 'Chalom' }), P({ name: 'x', email: 'e@x.io' }), P({ displayName: 'D' })]) {
      expect(usageAccountLabel('Claude', p)).toBe(`Claude · ${accountIdentity([p]).label}`);
    }
    expect(accountIdentity([P({ name: 'work' })])).toEqual({ official: null, email: null, name: null, label: null });
  });

  it('resolves a session to ITS profile by (VPS, provider, profile id)', () => {
    const profiles = [P({ email: 'one@x.io' }), P({ id: 'p2', number: 2, email: 'two@x.io' }),
      P({ id: 'p2', vpsId: 'w', number: 2, email: 'other-vps@x.io' }), P({ provider: 'codex', email: 'cx@x.io' })];
    const one = { vpsId: 'v', kind: 'claude', providerConfig: null };
    const two = { vpsId: 'v', kind: 'claude', providerConfig: JSON.stringify({ accountProfile: 'p2', accountProfileNumber: 2 }) };
    expect(sessionAccountProfile(profiles, one)?.email).toBe('one@x.io');
    expect(sessionAccountProfile(profiles, two)?.email).toBe('two@x.io');
    expect(sessionAccountProfile(profiles, { ...one, kind: 'codex' })?.email).toBe('cx@x.io');
    expect(sessionAccountProfile(profiles, null)).toBeUndefined();
  });

  const usage: AccountUsage = { ok: true, provider: 'claude', fetchedAt: Date.now(),
    fiveHour: { utilization: 25, resetsAt: null }, sevenDay: { utilization: 82, resetsAt: null } };

  it('shows the account in the open popover (ok, failed and empty)', () => {
    const ok = renderToStaticMarkup(createElement(UsagePopover, { usage, vpsName: 'box', provider: 'claude', accountLabel: 'Claude 2 · work' }));
    expect(ok).toContain('class="um-account"');
    expect(ok).toContain('aria-label="Account usage: Claude 2 · work"');
    const failed = renderToStaticMarkup(createElement(UsagePopover, {
      usage: { ok: false, provider: 'codex', fetchedAt: 1, error: 'unknown' }, provider: 'codex', accountLabel: 'Codex 2' }));
    expect(failed).toContain('>Codex 2<');
    const empty = renderToStaticMarkup(createElement(UsagePopover, { usage: null, provider: 'codex', accountLabel: 'Codex · b@x.io' }));
    expect(empty).toContain('>Codex · b@x.io<');
  });

  it('names the account on both real surfaces before they open (runtime cell, mobile rings)', () => {
    const meter = renderToStaticMarkup(createElement(UsageMeter, { usage, runtime: true, kind: 'claude', accountLabel: 'Claude 2 · work' }));
    expect(meter).toContain('Show account usage: Claude 2 · work');
    const rings = renderToStaticMarkup(createElement(UsageRings, { usage, kind: 'claude', accountLabel: 'Claude 2 · work' }));
    expect(rings).toContain('Account usage: Claude 2 · work, ');
  });
});

describe('account_changed markers in the browser merge', () => {
  const good: AccountUsage = { ok: true, fetchedAt: 1_000, accountKey: 'K', fiveHour: { utilization: 25, resetsAt: null } };
  const marker: AccountUsage = { ok: false, fetchedAt: 9_000, accountKey: 'K', error: 'account_changed' };

  it('a same-login marker never hides (or outlives) that account\'s real reading', () => {
    expect(newestAccountUsage(good, marker)).toBe(good);
    expect(newestAccountUsage(marker, good)).toBe(good);
  });

  it('a marker for a different login still replaces the old account\'s gauges', () => {
    const moved = { ...marker, accountKey: 'OTHER' };
    expect(newestAccountUsage(good, moved)).toBe(moved);
  });
});
