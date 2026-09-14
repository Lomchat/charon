import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_KINDS, ALL_BACKENDS_ENABLED, DEFAULT_BACKENDS, enabledBackendsFromSettings,
  enabledKinds, sameBackends, type EnabledBackends,
} from '../app/enabledBackends';
import {
  PROVIDERS, SESSION_PROVIDERS, providerSettingKey, type SessionProvider,
} from '@/lib/sessionCapabilities';
import { SETTINGS_WRITE_ALLOWLIST } from '@/lib/server/claude/settingsKeys';

/**
 * The hub-wide backend switches (`claude.enabled` / `codex.enabled`, §11).
 *
 * The whole feature is "a backend the user turned off has no launcher", and it
 * has two failure modes, and both are dangerous. Reading absence as OFF would
 * subtract a backend from a hub that never asked — buttons vanish, nothing on
 * screen says why. Reading it as ON would ADD one nobody enabled, which is how
 * a backend that ships opt-in (§14.103) would advertise itself anyway. So
 * absence resolves to the provider's DECLARED default, and a value present but
 * malformed still means ON — a typo must never hide a configured backend.
 */
describe('enabledBackendsFromSettings', () => {
  it('defaults to ON when the keys are missing, empty or unreadable', () => {
    expect(enabledBackendsFromSettings({})).toEqual(ALL_BACKENDS_ENABLED);
    expect(enabledBackendsFromSettings(null)).toEqual(ALL_BACKENDS_ENABLED);
    expect(enabledBackendsFromSettings(undefined)).toEqual(ALL_BACKENDS_ENABLED);
    expect(enabledBackendsFromSettings({ 'claude.enabled': '' })).toEqual(ALL_BACKENDS_ENABLED);
  });

  it('only the literal "false" turns a backend off', () => {
    // Built from the registry: turning one backend off must leave every OTHER
    // one at its declared default, whatever they are (§14.102).
    const expectOff = (off: SessionProvider[]) => Object.fromEntries(
      SESSION_PROVIDERS.map((k) => [
        k, off.includes(k) ? false : PROVIDERS[k].settings.defaultEnabled,
      ]),
    );
    expect(enabledBackendsFromSettings({ 'codex.enabled': 'false' }))
      .toEqual(expectOff(['codex']));
    expect(enabledBackendsFromSettings({ 'claude.enabled': 'false', 'codex.enabled': 'false' }))
      .toEqual(expectOff(['claude', 'codex']));
    // Not 'false' → on. A typo must never silently hide a backend.
    expect(enabledBackendsFromSettings({ 'claude.enabled': 'False' }).claude).toBe(true);
    expect(enabledBackendsFromSettings({ 'claude.enabled': '0' }).claude).toBe(true);
  });
});
describe('enabledKinds', () => {
  it('keeps the registry order', () => {
    // Built from the registry rather than a literal, so adding a provider
    // does not turn a behavioural test into a compile error (§14.102).
    const all = (on: boolean) => Object.fromEntries(
      SESSION_PROVIDERS.map((k) => [k, on]),
    ) as EnabledBackends;
    const only = (keep: SessionProvider) => Object.fromEntries(
      SESSION_PROVIDERS.map((k) => [k, k === keep]),
    ) as EnabledBackends;
    expect(enabledKinds(all(true))).toEqual([...SESSION_PROVIDERS]);
    expect(enabledKinds(all(false))).toEqual([]);
    for (const p of SESSION_PROVIDERS) expect(enabledKinds(only(p))).toEqual([p]);
  });

  it('treats a missing preference as each backend’s declared default', () => {
    expect(enabledKinds(null))
      .toEqual(SESSION_PROVIDERS.filter((p) => PROVIDERS[p].settings.defaultEnabled));
  });
});

describe('the settings route accepts every provider switch', () => {
  // A key the POST allow-list doesn't carry is dropped SILENTLY: the toggle
  // flips, saves "successfully" and comes back on at the next GET. This test
  // used to know only `claude.enabled` and `codex.enabled`, so Cursor shipped
  // with a dead switch — now it walks the registry instead.
  it('allow-lists each backend’s switch and per-provider defaults', () => {
    for (const p of SESSION_PROVIDERS) {
      expect(SETTINGS_WRITE_ALLOWLIST, `${p}: switch not writable`)
        .toContain(PROVIDERS[p].settings.enabledKey);
      for (const suffix of ['default_model', 'default_permission_mode']) {
        expect(SETTINGS_WRITE_ALLOWLIST, `${p}: ${suffix} not writable`)
          .toContain(providerSettingKey(p, suffix));
      }
    }
  });

  it('stores each switch at its declared default', () => {
    const settings = readFileSync(
      path.join(path.resolve(__dirname, '..'), 'lib/server/claude/settings.ts'), 'utf8');
    for (const p of SESSION_PROVIDERS) {
      const key = PROVIDERS[p].settings.enabledKey.replace('.', '\\.');
      const want = PROVIDERS[p].settings.defaultEnabled ? 'true' : 'false';
      // The stored default and the declared one must agree, or the UI and the
      // server disagree about whether a backend is offered.
      expect(settings, `${p}: DEFAULTS should hold '${want}'`)
        .toMatch(new RegExp(`'${key}':\\s*'${want}'`));
    }
  });
});

describe('comparing two switch sets', () => {
  it('notices a change on EVERY provider, not just the first two', () => {
    // The bug this exists for: a caller compared `prev.claude === next.claude
    // && prev.codex === next.codex`, so when those two agreed it kept `prev`
    // and threw the fetched object away. The third provider stayed at its
    // `defaultEnabled: false` forever, every one of its launchers was missing
    // from the sidebar and the wizard, and nothing said why.
    const all = Object.fromEntries(AGENT_KINDS.map((k) => [k, true])) as EnabledBackends;
    expect(sameBackends(all, { ...all })).toBe(true);
    for (const k of AGENT_KINDS) {
      expect(sameBackends(all, { ...all, [k]: false }), `flipping ${k} went unnoticed`).toBe(false);
    }
  });

  it('treats a missing set as different from a real one', () => {
    const all = Object.fromEntries(AGENT_KINDS.map((k) => [k, true])) as EnabledBackends;
    expect(sameBackends(null, all)).toBe(false);
    expect(sameBackends(all, undefined)).toBe(false);
    expect(sameBackends(null, null)).toBe(true);
  });

  it('carries a settings answer through the comparison', () => {
    // End to end: an opt-in provider switched ON in settings must read as a
    // CHANGE against the defaults, or the UI never adopts it.
    const optIn = AGENT_KINDS.filter((k) => !DEFAULT_BACKENDS[k]);
    for (const k of optIn) {
      const next = enabledBackendsFromSettings({ [`${k}.enabled`]: 'true' });
      expect(sameBackends(DEFAULT_BACKENDS, next), `${k} switched on read as no change`).toBe(false);
      expect(next[k]).toBe(true);
    }
  });
});
