import { describe, it, expect } from 'vitest';
import { isTurnInterrupted, SYNTHETIC_MODEL } from '../lib/turnInterrupted';

// ── "The CLI dropped this turn mid-response" detection (§14.68) ──────────────
// Same design risk as authExpired.test.ts: the detector only draws a button,
// but a false positive glues a "Continue" CTA under an ordinary paragraph of
// assistant prose — and the sessions most likely to WRITE about connection
// errors are the ones working on this very repo (this feature's own session
// discussed the string at length). The negative cases below are the point.

describe('isTurnInterrupted', () => {
  it('matches the exact message the CLI produced in the wild', () => {
    // Verbatim from claude_session_messages id=116808 (session bed9ec72…),
    // which carried model='<synthetic>'.
    const msg = 'API Error: Connection closed mid-response. The response above may be incomplete.';
    expect(isTurnInterrupted(msg, SYNTHETIC_MODEL)).toBe(true);
    // …and still matches without the model hint (older rows have none).
    expect(isTurnInterrupted(msg)).toBe(true);
    expect(isTurnInterrupted(msg, null)).toBe(true);
  });

  it('matches plausible variants of the same failure', () => {
    expect(isTurnInterrupted('Connection closed mid-response.')).toBe(true);
    expect(isTurnInterrupted('API Error: Connection error.')).toBe(true);
    expect(isTurnInterrupted('API Error: Connection reset by peer')).toBe(true);
    expect(isTurnInterrupted('API Error: 500 Internal Server Error — the response above may be incomplete.')).toBe(true);
  });

  it('accepts any API error the CLI itself marked <synthetic>', () => {
    expect(isTurnInterrupted('API Error: 529 {"type":"overloaded_error"}', SYNTHETIC_MODEL)).toBe(true);
    expect(isTurnInterrupted('API Error: Request timed out.', SYNTHETIC_MODEL)).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isTurnInterrupted('\n  API Error: Connection closed mid-response.\n')).toBe(true);
  });

  it('ignores empty / nullish input', () => {
    expect(isTurnInterrupted('')).toBe(false);
    expect(isTurnInterrupted(null)).toBe(false);
    expect(isTurnInterrupted(undefined)).toBe(false);
    expect(isTurnInterrupted('   ')).toBe(false);
    expect(isTurnInterrupted('', SYNTHETIC_MODEL)).toBe(false);
  });

  // ── The false positives that actually matter ──────────────────────────────

  it('does NOT match a session/rate limit — Continue cannot fix it', () => {
    // Also a real <synthetic> bubble (id=92455), hence the explicit model.
    expect(isTurnInterrupted(
      "You've hit your session limit · resets 4:40pm (Europe/Paris)", SYNTHETIC_MODEL,
    )).toBe(false);
    expect(isTurnInterrupted("You've hit your session limit · resets 7:20pm (Europe/Paris)")).toBe(false);
  });

  it('does NOT match an agent NARRATING the error', () => {
    expect(isTurnInterrupted(
      'The stream died with "API Error: Connection closed mid-response", so I retried the request and it went through.',
    )).toBe(false);
    expect(isTurnInterrupted(
      "I'll look at how the auth-expired CTA is wired, then plan the same for the \"Connection closed mid-response\" case.",
    )).toBe(false);
    expect(isTurnInterrupted('Added a regression test for the connection-closed-mid-response path.')).toBe(false);
  });

  it('does NOT match quoted / fenced discussion of the message', () => {
    expect(isTurnInterrupted('> API Error: Connection closed mid-response.')).toBe(false);
    expect(isTurnInterrupted('```\nAPI Error: Connection closed mid-response.\n```')).toBe(false);
    expect(isTurnInterrupted('```\nAPI Error: Connection closed mid-response.\n```', SYNTHETIC_MODEL)).toBe(false);
  });

  it('does NOT match unrelated errors', () => {
    expect(isTurnInterrupted('API Error: 401 OAuth access token has expired.')).toBe(false);
    expect(isTurnInterrupted('Failed to authenticate. API Error: 401 Unauthorized')).toBe(false);
    expect(isTurnInterrupted('The connection to the database was closed.')).toBe(false);
    expect(isTurnInterrupted('curl: (52) Empty reply from server')).toBe(false);
  });

  it('refuses essays even when they open with the marker', () => {
    const long = 'API Error: Connection closed mid-response. ' + 'x'.repeat(500);
    expect(isTurnInterrupted(long)).toBe(false);
    expect(isTurnInterrupted(long, SYNTHETIC_MODEL)).toBe(false);
  });
});
