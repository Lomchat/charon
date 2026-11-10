import { describe, it, expect } from 'vitest';
import { apiTokenMatches, apiTokenRouteAllowed, isBearerAttempt } from '../lib/server/apiToken';

/**
 * The automation token (§12) opens hub routes without a login. What matters is
 * which way it fails: an unset or weak token must open NOTHING, and a valid one
 * must never reach a route outside its allow-list (settings, shells, logins…).
 */
const TOKEN = 'a'.repeat(24) + 'b'.repeat(24);
const env = { CHARON_API_TOKEN: TOKEN };

describe('apiTokenMatches', () => {
  it('accepts only the exact configured token, and only when it is long enough', () => {
    expect(apiTokenMatches(`Bearer ${TOKEN}`, env)).toBe(true);
    expect(apiTokenMatches(`Bearer ${TOKEN}x`, env)).toBe(false);
    expect(apiTokenMatches(`Bearer ${TOKEN.slice(1)}`, env)).toBe(false);
    expect(apiTokenMatches(TOKEN, env)).toBe(false);
    expect(apiTokenMatches(`Basic ${TOKEN}`, env)).toBe(false);
    expect(apiTokenMatches(null, env)).toBe(false);
    // Unset, empty or short token = the whole path is off, even if the header matches it.
    expect(apiTokenMatches('Bearer ', {})).toBe(false);
    expect(apiTokenMatches('Bearer short', { CHARON_API_TOKEN: 'short' })).toBe(false);
    expect(apiTokenMatches('Bearer ', { CHARON_API_TOKEN: '' })).toBe(false);
    expect(isBearerAttempt('Bearer x')).toBe(true);
    expect(isBearerAttempt('Basic x')).toBe(false);
  });
});

describe('apiTokenRouteAllowed', () => {
  it('opens the session automation routes and nothing else', () => {
    const allowed: Array<[string, string]> = [
      ['GET', '/api/sessions'], ['POST', '/api/sessions'],
      ['GET', '/api/sessions/0123456789abcdef'],
      ['POST', '/api/sessions/0123456789abcdef/input'],
      ['POST', '/api/sessions/0123456789abcdef/endpoint'],
      ['POST', '/api/sessions/0123456789abcdef/sleep'],
      ['POST', '/api/sessions/0123456789abcdef/effort'],
      ['POST', '/api/sessions/0123456789abcdef/hidden'],
      ['GET', '/api/accounts'], ['GET', '/api/custom-endpoints'], ['GET', '/api/codex/models'],
    ];
    const refused: Array<[string, string]> = [
      ['POST', '/api/settings'], ['GET', '/api/settings'],
      ['POST', '/api/accounts/login'], ['POST', '/api/custom-endpoints'],
      ['GET', '/api/shells'], ['POST', '/api/vps'], ['POST', '/api/sync'],
      ['DELETE', '/api/sessions/0123456789abcdef'],
      ['GET', '/api/sessions/0123456789abcdef/input'],
      ['POST', '/api/sessions/0123456789abcdef/rollback'],
      ['POST', '/api/sessions/0123456789abcdef/mode'],
      ['GET', '/api/sessions/a/b'], ['GET', '/api/sessions/../settings'],
      ['POST', '/api/sessions/bulk-delete'], ['GET', '/api/sessions/import'],
      ['GET', '/api/sessions/0123456789abcdef/export'],
    ];
    for (const [m, p] of allowed) expect(apiTokenRouteAllowed(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of refused) expect(apiTokenRouteAllowed(m, p), `${m} ${p}`).toBe(false);
  });
});
