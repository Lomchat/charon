// Detection of "the CLI aborted this turn mid-flight" from a session's own
// output — the sibling of `authExpired.ts` (§14.65), same shape, same design
// rules, different failure.
//
// When the transport to the API dies mid-turn, the CLI does NOT emit a
// protocol `error` event: it closes the turn with a synthetic ASSISTANT
// message, e.g.
//
//   API Error: Connection closed mid-response. The response above may be
//   incomplete.
//
// The SDK client remains healthy although the turn failed, so Charon uses the
// connected `failed` status (red in the UI, input still live), not the broken
// session status `error`. The one-word recovery is still "Continue", rendered
// as a button under the offending bubble (§14.68).
//
// Two signals, both from the CLI itself:
//   - the TEXT, anchored at the start of the bubble;
//   - the MODEL of the message: the CLI stamps these system-generated bubbles
//     `<synthetic>` (as opposed to a real `claude-*` id), which is a much
//     stronger "this is a report, not prose" marker than any regex. When it's
//     present we accept any `API Error:` opener; when it's absent (older
//     agents / rows persisted before `effective_model`) we fall back to the
//     narrow patterns.
//
// FALSE POSITIVES are the design risk, exactly as in authExpired.ts: sessions
// working on THIS repo write these words constantly, and a "Continue" button
// glued under a paragraph of prose is confusing noise. Hence: a length cap, no
// fenced/quoted text, and a required anchor at position 0.
//
// NOTE: not every `<synthetic>` bubble is continuable — "You've hit your
// session limit · resets 4:40pm" is one too, and Continue cannot fix it. That
// is why even the synthetic tier requires the `API Error:` opener.

/** The genuine messages are one line; allow slack, refuse essays. */
const MAX_LEN = 400;

/** `AssistantMessage.model` on a CLI-generated (non-API) bubble. */
export const SYNTHETIC_MODEL = '<synthetic>';

/** Accepted when the bubble is NOT marked `<synthetic>` — deliberately narrow. */
const PATTERNS: RegExp[] = [
  // The canonical line, with or without the "API Error:" prefix.
  /^\s*(api error:\s*)?connection closed mid-response\b/i,
  // Same family, other transport wording: "API Error: Connection error." /
  // "… Connection reset by peer" / "… Connection timed out".
  /^\s*api error:\s*connection (error|reset|timed out|aborted)\b/i,
  // Any API error that explicitly says the answer was cut short.
  /^\s*api error:[\s\S]{0,200}?\bresponse above may be incomplete\b/i,
];

/** Accepted only when the CLI itself marked the bubble `<synthetic>`. */
const SYNTHETIC_PATTERN = /^\s*api error\b/i;

/**
 * True when `text` is the CLI reporting that it dropped the turn mid-response
 * — i.e. the session is fine and a plain "Continue" resumes the work.
 *
 * @param model the message's API-confirmed model, when known (`<synthetic>`
 *              widens the accepted wording, see the header).
 */
export function isTurnInterrupted(
  text: string | null | undefined,
  model?: string | null,
): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t || t.length > MAX_LEN) return false;
  // A fenced/quoted block is someone DISCUSSING the error, not hitting it.
  if (t.startsWith('```') || t.startsWith('>')) return false;
  if (model === SYNTHETIC_MODEL) return SYNTHETIC_PATTERN.test(t);
  return PATTERNS.some((re) => re.test(t));
}
