// Detection of "this VPS's `claude login` is dead" from a session's own output.
//
// When the per-VPS OAuth token expires, the CLI does NOT emit a protocol
// `error` event — it answers the user's turn with a plain ASSISTANT message:
//
//   Failed to authenticate. API Error: 401 OAuth access token has expired.
//   Re-authenticate to continue.
//
// So the only place this is observable is the assistant text. Two consumers
// share this detector, hence a PLAIN module (no 'server-only'): sessionOps
// flips `vps.claudeLoggedIn` to 0 + broadcasts `vps_status`, and <Message>
// renders a "sign in again" affordance right under the offending bubble
// (§14.65).
//
// FALSE POSITIVES are the real design risk here: a session that is itself
// working on OAuth code will happily print these words, and wrongly marking a
// healthy VPS as signed-out would push a pointless login modal at the user
// (this very repo's sessions discuss `claude auth login` constantly). The
// guards below keep it tight:
//   - the real message is a SHORT standalone line → cap the length;
//   - it must look like a report ABOUT the API call, not prose: we require an
//     explicit 401/`API Error` marker together with an auth/OAuth mention;
//   - markdown prose about it is almost always longer, or quoted/fenced.

/** The genuine message is ~100 chars; allow slack, refuse essays. */
const MAX_LEN = 400;

const PATTERNS: RegExp[] = [
  // The canonical CLI line, anchored: "Failed to authenticate. API Error: 401 …"
  /^\s*failed to authenticate\b[\s\S]{0,120}?\b401\b/i,
  // Same failure surfaced API-first: "API Error: 401 … oauth/authenticate …"
  /^\s*api error:\s*401\b[\s\S]{0,160}?\b(oauth|authenticat|credential)/i,
  // Token-expiry phrasing without the numeric code. Anchored AND requiring the
  // CLI's imperative, because "the OAuth token has expired, so I'll re-run
  // login" is a sentence an agent narrating its own work writes all the time —
  // "Re-authenticate" as an instruction is what makes it a REPORT, not prose.
  /^\s*(your |the )?(claude )?(oauth )?(access )?token (has )?expired\b[\s\S]{0,80}?\bre-?authenticate\b/i,
];

/**
 * True when `text` is the CLI reporting that this VPS's OAuth credentials are
 * no longer valid — i.e. the user must run the Claude sign-in again.
 */
export function isClaudeAuthExpired(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t || t.length > MAX_LEN) return false;
  // A fenced/quoted block is someone DISCUSSING the error, not hitting it.
  if (t.startsWith('```') || t.startsWith('>')) return false;
  return PATTERNS.some((re) => re.test(t));
}
