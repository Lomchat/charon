import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ALL_BACKENDS_ENABLED, enabledBackendsFromSettings, enabledKinds,
} from '../app/enabledBackends';

/**
 * The hub-wide backend switches (`claude.enabled` / `codex.enabled`, §11).
 *
 * The whole feature is "a backend the user turned off has no launcher", and it
 * has exactly one dangerous failure mode: reading absence as OFF. A settings
 * GET that failed, a key never written or an old browser would then subtract a
 * backend from a hub that never asked for it — the buttons vanish and nothing
 * on screen says why. So ON is the answer to everything except the literal
 * string 'false'.
 */
describe('enabledBackendsFromSettings', () => {
  it('defaults to ON when the keys are missing, empty or unreadable', () => {
    expect(enabledBackendsFromSettings({})).toEqual(ALL_BACKENDS_ENABLED);
    expect(enabledBackendsFromSettings(null)).toEqual(ALL_BACKENDS_ENABLED);
    expect(enabledBackendsFromSettings(undefined)).toEqual(ALL_BACKENDS_ENABLED);
    expect(enabledBackendsFromSettings({ 'claude.enabled': '' })).toEqual(ALL_BACKENDS_ENABLED);
  });

  it('only the literal "false" turns a backend off', () => {
    expect(enabledBackendsFromSettings({ 'codex.enabled': 'false' }))
      .toEqual({ claude: true, codex: false });
    expect(enabledBackendsFromSettings({ 'claude.enabled': 'false', 'codex.enabled': 'false' }))
      .toEqual({ claude: false, codex: false });
    // Not 'false' → on. A typo must never silently hide a backend.
    expect(enabledBackendsFromSettings({ 'claude.enabled': 'False' }).claude).toBe(true);
    expect(enabledBackendsFromSettings({ 'claude.enabled': '0' }).claude).toBe(true);
  });
});

describe('enabledKinds', () => {
  it('keeps the canonical claude → codex order', () => {
    expect(enabledKinds({ claude: true, codex: true })).toEqual(['claude', 'codex']);
    expect(enabledKinds({ claude: false, codex: true })).toEqual(['codex']);
    expect(enabledKinds({ claude: true, codex: false })).toEqual(['claude']);
    expect(enabledKinds({ claude: false, codex: false })).toEqual([]);
  });

  it('treats a missing preference as both enabled', () => {
    expect(enabledKinds(null)).toEqual(['claude', 'codex']);
  });
});

describe('the settings route accepts the switches', () => {
  // A key the POST allow-list doesn't carry is dropped silently: the toggle
  // would flip, save "successfully" and come back on at the next GET.
  const route = readFileSync(
    path.join(path.resolve(__dirname, '..'), 'app/api/claude/settings/route.ts'), 'utf8');

  it('allow-lists both keys and validates them as booleans', () => {
    expect(route).toContain("'claude.enabled'");
    expect(route).toContain("'codex.enabled'");
    expect(route).toMatch(/k === 'claude\.enabled' \|\| k === 'codex\.enabled'/);
  });

  it('defaults them to true server-side', () => {
    const settings = readFileSync(
      path.join(path.resolve(__dirname, '..'), 'lib/server/claude/settings.ts'), 'utf8');
    expect(settings).toMatch(/'claude\.enabled':\s*'true'/);
    expect(settings).toMatch(/'codex\.enabled':\s*'true'/);
  });
});
