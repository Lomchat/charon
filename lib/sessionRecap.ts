// The recap the hub asks for after each finished turn (§14.122): one or two
// sentences under the last answer, from a side question (no tools, never
// written into the conversation). Not a message: no unread, no notification.

export type SessionRecap = {
  text: string;
  /** The final assistant row it follows: shown only while that row is the
   *  conversation's last word. */
  afterRowId: number;
  at: number;
};

/** What the side question asks. */
export const RECAP_QUESTION = 'Recap where this session stands for someone glancing at it: one or two short '
  + 'sentences — what was just done, and what is left or what you need from the user. Plain text, no '
  + 'preamble, no markdown, in the language the user writes in.';

export const RECAP_MAX_CHARS = 600;

export function parseSessionRecap(json: string | null | undefined): SessionRecap | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Partial<SessionRecap>;
    if (typeof r.text !== 'string' || !r.text.trim() || typeof r.afterRowId !== 'number') return null;
    return { text: r.text, afterRowId: r.afterRowId, at: typeof r.at === 'number' ? r.at : 0 };
  } catch { return null; }
}
