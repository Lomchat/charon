import { isClaudeAuthExpired } from './authExpired';
import { isTurnInterrupted } from './turnInterrupted';

// Claude CLI failures do not consistently arrive as protocol `error` events.
// Some are emitted as a short synthetic assistant bubble immediately before
// the turn's normal `stop`, so the hub must classify the final bubble itself.
//
// Keep this detector conservative: it is used to change durable session state,
// not merely to render a contextual button. The message must be a short,
// standalone error report anchored at its first line; quoted/fenced examples
// from a session working on error-handling code must not match.
const MAX_LEN = 600;
const ERROR_OPENER =
  /^\s*(?:api error\s*:|authentication error\b|authentication failed\b|auth failed\b|failed to authenticate\b|oauth error\b|unauthorized\b)/i;

export type TerminalClaudeErrorKind = 'authentication' | 'api';

/**
 * Classify a final Claude assistant bubble that represents a failed turn.
 * Returns null for ordinary assistant prose.
 */
export function classifyTerminalClaudeError(
  text: string | null | undefined,
  model?: string | null,
): TerminalClaudeErrorKind | null {
  if (!text) return null;
  const t = text.trim();
  if (!t || t.length > MAX_LEN || t.startsWith('```') || t.startsWith('>')) {
    return null;
  }
  if (isClaudeAuthExpired(t)) return 'authentication';
  if (isTurnInterrupted(t, model)) return 'api';
  if (!ERROR_OPENER.test(t)) return null;
  return /\b(auth(?:entication)?|oauth|credential|token|unauthori[sz]ed|sign[\s-]?in|login)\b/i.test(t)
    ? 'authentication'
    : 'api';
}
