/** Absolute recorded totals; null means no counter was supplied, never zero. */
export type SessionTokenUsage = {
  revision: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requests: number;
  legacyTurns: number;
  missingInput: number;
  missingOutput: number;
  missingTotal: number;
  partial: boolean;
};

/** A poll started before an SSE update must not rewind the counters. */
export function mergeSessionTokenUsage(previous: SessionTokenUsage | null, next: SessionTokenUsage | undefined): SessionTokenUsage | null {
  if (!next || (previous && previous.revision > next.revision)) return previous;
  if (previous && Object.keys(next).every((key) => previous[key as keyof SessionTokenUsage] === next[key as keyof SessionTokenUsage])) return previous;
  return next;
}
