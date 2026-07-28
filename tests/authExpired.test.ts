import { describe, it, expect } from 'vitest';
import { isClaudeAuthExpired } from '../lib/authExpired';

// ── "This VPS's claude login is dead" detection (§14.65) ─────────────────────
// The detector drives TWO destructive-ish side effects: it flips
// `vps.claudeLoggedIn` to 0 fleet-wide-visibly, and it pushes a sign-in CTA at
// the user. A false positive therefore nags the user to re-auth a perfectly
// healthy VPS — and the sessions most likely to TALK about OAuth errors are the
// ones working on this very repo. The negative cases below are the real point
// of this file.

describe('isClaudeAuthExpired', () => {
  it('matches the exact message the CLI produced in the wild', () => {
    // Verbatim from claude_session_messages id=115776 (session 0827823f…).
    expect(isClaudeAuthExpired(
      'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
    )).toBe(true);
  });

  it('matches plausible variants of the same failure', () => {
    expect(isClaudeAuthExpired('Failed to authenticate. API Error: 401 Unauthorized')).toBe(true);
    expect(isClaudeAuthExpired('API Error: 401 {"error":{"message":"OAuth token revoked"}}')).toBe(true);
    expect(isClaudeAuthExpired('OAuth access token has expired. Re-authenticate to continue.')).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isClaudeAuthExpired('\n  Failed to authenticate. API Error: 401 …\n')).toBe(true);
  });

  it('ignores empty / nullish input', () => {
    expect(isClaudeAuthExpired('')).toBe(false);
    expect(isClaudeAuthExpired(null)).toBe(false);
    expect(isClaudeAuthExpired(undefined)).toBe(false);
    expect(isClaudeAuthExpired('   ')).toBe(false);
  });

  it('does NOT fire on prose that merely discusses the error', () => {
    expect(isClaudeAuthExpired(
      "I've added handling for the case where the CLI returns `Failed to authenticate. " +
      'API Error: 401 OAuth access token has expired.` — when that happens we now flip ' +
      'vps.claudeLoggedIn to 0 and surface a sign-in button under the bubble, so the user ' +
      'can recover without hunting through the sidebar. The detector lives in ' +
      'lib/authExpired.ts and is shared by sessionOps and Message.',
    )).toBe(false);
  });

  it('does NOT fire on a quoted or fenced reproduction', () => {
    expect(isClaudeAuthExpired('> Failed to authenticate. API Error: 401 OAuth token expired.')).toBe(false);
    expect(isClaudeAuthExpired('```\nFailed to authenticate. API Error: 401\n```')).toBe(false);
  });

  it('does NOT fire on an agent NARRATING an expiry (no CLI imperative)', () => {
    // Short enough to pass the length cap and it opens with the expiry phrase —
    // only the missing "Re-authenticate" instruction separates it from the real
    // message. This is the case that made the bare token-expiry pattern unsafe.
    expect(isClaudeAuthExpired(
      "The OAuth access token has expired, so I'll re-run login on that box.",
    )).toBe(false);
    expect(isClaudeAuthExpired('Token expired — retrying with a fresh one.')).toBe(false);
  });

  it('does NOT fire on unrelated errors or other status codes', () => {
    expect(isClaudeAuthExpired('API Error: 500 Internal Server Error')).toBe(false);
    expect(isClaudeAuthExpired('API Error: 429 rate limit exceeded')).toBe(false);
    expect(isClaudeAuthExpired('Failed to authenticate to the Postgres database.')).toBe(false);
    expect(isClaudeAuthExpired('The build failed: 401 lines changed.')).toBe(false);
  });

  it('does NOT fire on a long report that happens to open with the phrase', () => {
    // Length cap: the genuine message is a one-liner. A wall of text starting
    // with the phrase is an agent WRITING about it.
    const long = 'Failed to authenticate. API Error: 401 OAuth access token has expired. ' + 'x'.repeat(500);
    expect(isClaudeAuthExpired(long)).toBe(false);
  });
});
