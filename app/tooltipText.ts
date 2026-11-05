/**
 * The content of a themed tooltip (app/HoverTip.tsx), and how a plain `title`
 * string becomes one. Pure: no React, no DOM.
 *
 * The platform's ~350 `title` attributes were written for the browser's
 * one-line tooltip, in a few recurring shapes, and each shape has its own
 * reading:
 *   "save to the VPS (Ctrl+S)"         → "Save to the VPS" + keys Ctrl S
 *   "history unavailable — reason"     → headline + a muted detail line
 *   "a\nb\nc"                          → headline + one row per line
 *   "52% used · resets in 2h"          → one row per fact, never dots
 *   "/srv/app/src" or a model id       → the value itself, in monospace
 *   a long sentence                    → body text, not a bold paragraph
 *
 * An element that stands for an OBJECT (a file, a session, a tab) says more,
 * through `tipAttrs`: its `title` is then only the name, headline as written,
 * followed by what it is (`detail` lines), an excerpt (`quote`) and, small at
 * the bottom, what the pointer can do with it (`actions`).
 */

/** A gesture and what it does: ['Double-click', 'keep it open']. */
export type TipAction = readonly [gesture: string, effect: string];

export type HoverTipContent = {
  title?: string;
  /** One muted paragraph under the title (or alone). */
  detail?: string;
  /** Rows under the title (values among them render monospace). */
  lines?: string[];
  /** The detail is a value (path, id, URL): monospace. */
  mono?: boolean;
  /** An excerpt of the object's content, clamped. */
  quote?: string;
  /** What the pointer can do with it, small at the bottom. */
  actions?: TipAction[];
  /** Shown as a pill beside the title when > 0. */
  count?: number;
  /** Keyboard shortcut, rendered as keys. */
  keys?: string[];
  /** A muted last line: what clicking does right now. */
  hint?: string;
  /** Rows read "Label: value": the label renders bold (`tipAttrs({labels})`). */
  labeled?: boolean;
};

/** "Label: value" → its two parts; null when the row has no short label. */
export function splitTipLabel(line: string): [label: string, value: string] | null {
  const m = /^([^:]{1,40}):\s(.+)$/.exec(line);
  return m ? [m[1], m[2]] : null;
}

/** A trailing "(Ctrl+S)", "(Esc)", "(Alt+↑)", "(Shift+F8)". */
const SHORTCUT = /\s*\(((?:Ctrl|Cmd|⌘|Alt|Option|Shift|Esc|Enter|Tab|Space|Del|F\d{1,2}|[↑↓←→])(?:\s*\+\s*[^()+]+?)*)\)\s*$/;
const SEPARATOR = ' — ';
/** Facts a one-line tooltip had to run together: one row each in the card. */
const FACT = ' · ';
const facts = (s: string) => s.split(FACT).map((f) => f.trim()).filter(Boolean);
/** Past this, a single sentence reads better as body text than as a headline. */
const HEADLINE_MAX = 64;

/** A value rather than prose: one token carrying a path, URL, id or version. */
export function isCodeLike(s: string): boolean {
  return !/\s/.test(s.trim()) && /[/.@:_\-\d]/.test(s);
}

/** "scan existing sessions" → "Scan existing sessions". Only prose: a first
 *  word of plain lowercase letters (values never reach here). */
function sentenceCase(s: string): string {
  return /^[a-z]+(?:\s|$)/.test(s) ? s[0].toUpperCase() + s.slice(1) : s;
}

export function tipFromTitle(raw: string | null | undefined): HoverTipContent | null {
  const text = (raw ?? '').replace(/\r/g, '').trim();
  if (!text) return null;
  const all = text.split('\n').map((l) => l.trim());
  let head = all[0];
  let rows = all.slice(1).flatMap(facts);

  let keys: string[] | undefined;
  const shortcut = SHORTCUT.exec(head);
  if (shortcut && shortcut.index > 0) {
    keys = shortcut[1].split('+').map((k) => k.trim()).filter(Boolean);
    head = head.slice(0, shortcut.index).trim();
  }
  let detail: string | undefined;
  const cut = head.indexOf(SEPARATOR);
  if (cut > 0) {
    detail = head.slice(cut + SEPARATOR.length).trim() || undefined;
    head = head.slice(0, cut).trim();
  }
  // "a · b — c · d": the first fact heads, every other one is a row, in
  // reading order (the muted paragraph is for ONE explanation).
  const [first = head, ...more] = facts(head);
  const told = detail ? facts(detail) : [];
  if (more.length || told.length > 1) {
    head = first;
    rows = [...more, ...told, ...rows];
    detail = undefined;
  } else if (detail) detail = sentenceCase(detail);

  if (!detail && !rows.length && !keys) {
    if (isCodeLike(head)) return { detail: head, mono: true };
    if (head.length > HEADLINE_MAX) return { detail: sentenceCase(head) };
  }
  return {
    title: sentenceCase(head),
    detail,
    lines: rows.length ? rows : undefined,
    keys,
  };
}

type TipAttrs = {
  'data-tip-detail'?: string; 'data-tip-quote'?: string; 'data-tip-actions'?: string; 'data-tip-labels'?: string;
};

/** The attributes an object's element spreads beside its `title` (= its name).
 *  Falsy entries are skipped, so conditions read inline. */
export function tipAttrs({ detail, quote, actions, labels }: {
  detail?: (string | null | false | undefined)[];
  quote?: string | null | false;
  actions?: (TipAction | null | false | undefined)[];
  /** Detail rows read "Label: value": render the labels bold. */
  labels?: boolean;
}): TipAttrs {
  const lines = (detail ?? []).filter((l): l is string => !!l && !!l.trim());
  const acts = (actions ?? []).filter((a): a is TipAction => !!a);
  return {
    // Always present (possibly empty): its presence is what says "object".
    'data-tip-detail': lines.join('\n'),
    'data-tip-quote': quote ? quote : undefined,
    'data-tip-actions': acts.length ? JSON.stringify(acts) : undefined,
    'data-tip-labels': labels ? '' : undefined,
  };
}

/** The tooltip of an element carrying `tipAttrs`: its title stays a name. */
export function tipFromAttrs(
  title: string | null | undefined, detail: string | undefined, quote: string | undefined, actions: string | undefined,
  labeled = false,
): HoverTipContent | null {
  const name = (title ?? '').trim();
  const lines = (detail ?? '').split('\n').flatMap(facts);
  let acts: TipAction[] | undefined;
  try {
    const parsed: unknown = actions ? JSON.parse(actions) : null;
    if (Array.isArray(parsed)) {
      acts = parsed.filter((a): a is TipAction => Array.isArray(a) && a.length === 2
        && typeof a[0] === 'string' && typeof a[1] === 'string');
    }
  } catch { /* a malformed list shows no actions */ }
  const q = quote?.trim() || undefined;
  if (!name && !lines.length && !q) return null;
  return {
    title: name || undefined,
    lines: lines.length ? lines : undefined,
    quote: q,
    actions: acts?.length ? acts : undefined,
    ...(labeled && lines.length ? { labeled: true } : {}),
  };
}
