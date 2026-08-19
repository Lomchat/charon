import type { SessionProvider } from './sessionCapabilities';

// Durable, provider-neutral description of a blocking session error. Stored in
// claude_session_messages with role='error': the historical table name is a
// compatibility detail, while this payload is shared by Claude and Codex.
export type SessionErrorKind = 'authentication' | 'rate_limit' | 'transport' | 'api';
export type SessionErrorAction = 'sign_in' | 'continue' | null;

export type SessionErrorPayload = {
  type: 'session_error';
  provider: SessionProvider;
  kind: SessionErrorKind;
  message: string;
  action: SessionErrorAction;
  fatal: boolean;
  /** Canonical UTC unix milliseconds; never a timezone-less wall clock. */
  resetAt: number | null;
};

const MAX_MESSAGE = 16 * 1024;

const AUTH_RE = /(?:\b(?:auth(?:entication)?|oauth|credential|unauthori[sz]ed|sign[\s-]?in|log(?:ged)?[\s-]?in)\b|\b401\b|api[ _-]?key|token[^\n]{0,80}(?:expired|invalid|revoked|missing))/i;
const LIMIT_RE = /(?:\b429\b|rate[\s_-]?limit|too many requests|quota|session limit|usage limit|limit (?:reached|exceeded)|insufficient[\s_-]?quota|credits? (?:exhausted|depleted)|billing (?:limit|quota))/i;
const TRANSPORT_RE = /(?:connection (?:closed|reset|aborted|error|timed out)|transport|stream (?:closed|disconnected|ended|failed)|network error|broken pipe|connection refused|temporar(?:y|ily) unavailable|service unavailable|\b(?:502|503|504|529)\b|overload(?:ed)?)/i;

function cleanMessage(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  return (text || 'The turn ended with an API error.').slice(0, MAX_MESSAGE);
}

/** Classify a trusted provider/SDK error, not arbitrary model prose. */
export function classifySessionError(input: {
  provider: SessionProvider;
  message?: string | null;
  turnFailure?: boolean;
  fatal?: boolean;
  hint?: string | null;
  apiStatus?: string | number | null;
  resetAt?: number | null;
}): SessionErrorPayload {
  const message = cleanMessage(input.message);
  const evidence = `${input.hint ?? ''}\n${input.apiStatus ?? ''}\n${message}`;
  const kind: SessionErrorKind = AUTH_RE.test(evidence)
    ? 'authentication'
    : LIMIT_RE.test(evidence)
      ? 'rate_limit'
      : TRANSPORT_RE.test(evidence)
        ? 'transport'
        : 'api';
  const fatal = input.fatal === true;
  const action: SessionErrorAction = kind === 'authentication'
    ? 'sign_in'
    : input.turnFailure && !fatal && kind !== 'rate_limit'
      ? 'continue'
      : null;
  return {
    type: 'session_error', provider: input.provider, kind, message, action, fatal,
    resetAt: kind === 'rate_limit' && Number.isFinite(input.resetAt) ? Math.round(input.resetAt!) : null,
  };
}

export function parseSessionError(value: string | null | undefined): SessionErrorPayload | null {
  if (!value) return null;
  try {
    const p = JSON.parse(value) as Partial<SessionErrorPayload>;
    if (p?.type !== 'session_error') return null;
    if (p.provider !== 'claude' && p.provider !== 'codex') return null;
    if (!['authentication', 'rate_limit', 'transport', 'api'].includes(String(p.kind))) return null;
    if (typeof p.message !== 'string' || !p.message.trim()) return null;
    const action = p.action === 'sign_in' || p.action === 'continue' ? p.action : null;
    return {
      type: 'session_error', provider: p.provider,
      kind: p.kind as SessionErrorKind,
      message: p.message.slice(0, MAX_MESSAGE), action, fatal: p.fatal === true,
      resetAt: typeof p.resetAt === 'number' && Number.isFinite(p.resetAt) ? Math.round(p.resetAt) : null,
    };
  } catch {
    return null;
  }
}
