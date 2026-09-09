import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTING_SOURCES, formatSettingSources, parseSettingSources,
  resolveSettingSources, safeParseSettingSources, settingSourcesWarning,
} from '@/lib/settingSources';

/**
 * Which Claude settings files a session loads (§14.100).
 *
 * The whole feature hangs on ONE distinction that four layers have to agree
 * on: "I have no opinion" (null / '') is not "load nothing" ([] / 'none').
 * Collapse the two anywhere and either isolation becomes unreachable, or a
 * layer that meant to defer silently switches every settings file off — and
 * both failures are invisible until a session behaves oddly hours later.
 */
describe('parse / format round trip', () => {
  it('keeps "inherit" and "isolation" apart', () => {
    expect(parseSettingSources(null)).toBeNull();
    expect(parseSettingSources(undefined)).toBeNull();
    expect(parseSettingSources('')).toBeNull();
    expect(parseSettingSources('   ')).toBeNull();

    expect(parseSettingSources('none')).toEqual([]);
    expect(parseSettingSources([])).toEqual([]);

    expect(formatSettingSources(null)).toBe('');
    expect(formatSettingSources([])).toBe('none');
  });

  it('normalises to the canonical order, whatever the input shape', () => {
    expect(parseSettingSources('local,user')).toEqual(['user', 'local']);
    expect(parseSettingSources(['local', 'project', 'user'])).toEqual(['user', 'project', 'local']);
    expect(parseSettingSources(' PROJECT , project ')).toEqual(['project']);
  });

  it('round-trips through storage', () => {
    for (const value of ['', 'none', 'project', 'user,project', 'user,project,local']) {
      expect(formatSettingSources(parseSettingSources(value))).toBe(value);
    }
  });

  it('refuses an unknown scope instead of dropping it', () => {
    // Silently ignoring "userr" would store a scope the operator believes is
    // on. The routes turn this throw into a 400 / a rejected settings key.
    expect(() => parseSettingSources('user,userr')).toThrow(/unknown settings source/);
    expect(() => parseSettingSources(['project', 42 as never])).toThrow();
    expect(safeParseSettingSources('nope')).toBeNull();
  });
});

describe('the resolution chain', () => {
  it('takes the first layer with an opinion, outside-in', () => {
    const session = ['user' as const];
    const vps = ['project' as const, 'local' as const];
    const hub = ['project' as const];

    expect(resolveSettingSources(session, vps, hub)).toEqual(['user']);
    expect(resolveSettingSources(null, vps, hub)).toEqual(['project', 'local']);
    expect(resolveSettingSources(null, null, hub)).toEqual(['project']);
  });

  it('falls back to the historical scope when nothing is configured', () => {
    // An existing fleet must be unaffected by the mere presence of the
    // feature: no layer set anywhere ⇒ exactly what Charon hard-coded before.
    expect(resolveSettingSources(null, null, null)).toEqual(['project']);
    expect(resolveSettingSources()).toEqual([...DEFAULT_SETTING_SOURCES]);
  });

  it('lets a layer explicitly ask for isolation', () => {
    // [] is an OPINION and must beat the layers below it — the falsy-check bug
    // this guards against would resolve it back to ['project'].
    expect(resolveSettingSources([], ['project'])).toEqual([]);
  });

  it('never returns the array it was handed', () => {
    const hub = ['project' as const];
    const resolved = resolveSettingSources(null, null, hub);
    resolved.push('user');
    expect(hub).toEqual(['project']);
  });
});

describe('what the UI warns about', () => {
  it('flags losing CLAUDE.md, and the self-writable local file', () => {
    expect(settingSourcesWarning(['project'])).toBeNull();
    expect(settingSourcesWarning(['user'])).toMatch(/CLAUDE\.md/);
    expect(settingSourcesWarning([])).toMatch(/CLAUDE\.md/);
    expect(settingSourcesWarning(['project', 'local'])).toMatch(/its own rules/);
    expect(settingSourcesWarning(null)).toBeNull();
  });
});
