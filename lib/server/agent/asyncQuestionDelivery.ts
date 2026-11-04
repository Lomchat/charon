/**
 * Async-question answers being delivered RIGHT NOW (sync refonte C09, W2
 * review). `delivering` on a pending async question means "a send is in
 * flight", never "answers were once reserved": the reservation
 * (`sessionPendingQuestions.answers`) outlives a failed send on purpose — a
 * retry must reuse the same content — and a form disabled by it could never
 * be answered again. In memory: a hub restart or a failure clears it.
 */
const KEY = '__charon_asyncQuestionsDelivering';
type G = typeof globalThis & { [KEY]?: Set<string> };

function set(): Set<string> {
  const g = globalThis as G;
  return (g[KEY] ??= new Set());
}

export function markAsyncQuestionDelivering(qid: string, on: boolean): void {
  if (on) set().add(qid); else set().delete(qid);
}

export function isAsyncQuestionDelivering(qid: string): boolean {
  return set().has(qid);
}
