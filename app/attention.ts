'use client';
// "Is a human at this device?" — the client half of ATTENDED viewing
// (CLAUDE.md §14.47, SPEC I10). Attended = visible AND input on this device
// within the last 120 s: only an attended view LEAVING a session reads its
// finish — a focus that moves on a hidden or idle tab read nothing.
//
// Input = passive capture of pointerdown/keydown/wheel/touchstart, plus the
// tab becoming visible — never the page load itself (automatic reloads). The SSE URL carries `attentive=1|0`, every focus POST
// carries `attentive`, and on an idle→active transition the device proves its
// attention at once (POST /focus `{kind:'attention'}`), then at most once per
// 30 s while active and a session is focused (the server's window is 120 s).
//
// `createAttentionTracker` is the pure core (unit-tested, clock injected); the
// module-level singleton below wires it to the DOM for globalEventStream.

export const ATTENTION_WINDOW_MS = 120_000;
export const ATTENTION_POST_INTERVAL_MS = 30_000;

export type AttentionTracker = {
  /** A user input (or the tab turning visible) happened now. */
  noteInput(): void;
  /** The tab turned visible: input too, but the focus re-POST that
   *  globalEventStream sends on that same event (carrying `attentive:true`)
   *  is the proof — no second POST. */
  noteVisible(): void;
  isAttentive(): boolean;
  /** The last proof POST was not applied (the hub did not know the conn yet):
   *  the next input proves again instead of waiting out the 30 s interval. */
  noteProofLost(): void;
  /** ms since the last input while attentive, else null. Sent with a focus
   *  POST so the hub dates the proof by the input, not by the POST. */
  attentionAgeMs(): number | null;
};

export function createAttentionTracker(deps: {
  now: () => number;
  isVisible: () => boolean;
  /** A session is focused on this tab's connection (periodic proofs only then). */
  hasFocus: () => boolean;
  /** Send POST /focus `{kind:'attention'}`. */
  post: () => void;
  /** Initial input time; default = never. A page load is NOT input: the
   *  SSE-silence and stale-chunk recoveries reload a forgotten tab on their
   *  own, and that must not read an unread finish (I10). The first real input
   *  is the idle→active proof. */
  initialInputAt?: number;
}): AttentionTracker {
  let lastInputAt = deps.initialInputAt ?? Number.NEGATIVE_INFINITY;
  let lastPostAt = Number.NEGATIVE_INFINITY;
  const attentiveAt = (t: number) => deps.isVisible() && t - lastInputAt <= ATTENTION_WINDOW_MS;
  return {
    noteInput() {
      const t = deps.now();
      const wasAttentive = attentiveAt(t);
      lastInputAt = t;
      if (!deps.isVisible()) return;
      if (!wasAttentive) {
        // idle → active: prove it at once (a focus move that follows reads).
        lastPostAt = t;
        deps.post();
        return;
      }
      if (deps.hasFocus() && t - lastPostAt >= ATTENTION_POST_INTERVAL_MS) {
        lastPostAt = t;
        deps.post();
      }
    },
    noteVisible() {
      const t = deps.now();
      lastInputAt = t;
      lastPostAt = t;
    },
    isAttentive() {
      return attentiveAt(deps.now());
    },
    noteProofLost() {
      lastPostAt = Number.NEGATIVE_INFINITY;
    },
    attentionAgeMs() {
      const t = deps.now();
      return attentiveAt(t) ? Math.max(0, t - lastInputAt) : null;
    },
  };
}

// ── DOM singleton ───────────────────────────────────────────────────────────
let tracker: AttentionTracker | null = null;

const docVisible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';

/**
 * Wire the tracker to the window once (idempotent). `post` and `hasFocus` come
 * from globalEventStream, which owns the connection id and the focus.
 */
export function installAttentionTracking(post: () => void, hasFocus: () => boolean): void {
  if (tracker || typeof window === 'undefined') return;
  const t = createAttentionTracker({ now: () => Date.now(), isVisible: docVisible, hasFocus, post });
  tracker = t;
  const onInput = () => t.noteInput();
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(type, onInput, opts);
  }
  document.addEventListener('visibilitychange', () => {
    if (docVisible()) t.noteVisible();
  });
}

/** visible && an input within the last 120 s. Before installation: no input
 *  was seen yet, so not attentive. */
export function isAttentive(): boolean {
  return tracker ? tracker.isAttentive() : false;
}

/** Age of the attention proof (ms since the last input), null when idle. */
export function attentionAgeMs(): number | null {
  return tracker ? tracker.attentionAgeMs() : null;
}

/** The hub answered a proof POST with ok:false (conn not registered yet). */
export function noteAttentionProofLost(): void {
  tracker?.noteProofLost();
}
