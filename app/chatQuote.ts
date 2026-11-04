// Quoting a passage of an agent reply into the composer.
//
// Select text in a FINISHED assistant answer or a thinking block, press the
// floating "Quote" button (or `q`), and the passage lands in the composer as
// a Markdown blockquote with the caret on the line right below it — so a
// question can be answered point by point. It is plain text in the
// textarea: editable, kept in the draft store, nothing new on the wire.

/** Where a selection may start AND end. One element of this set per quote:
 *  a selection spanning two bubbles is not quotable. A live (streaming)
 *  bubble re-renders under the selection, so it is excluded until final. */
export const QUOTABLE_SELECTOR = [
  '.bubble.role-assistant:not(.streaming) > .content',
  '.bubble.thinking .thinking-full',
  '.bubble.thinking .thinking-preview',
].join(', ');

/** `> `-prefix every line of `raw`. Line endings are normalised, trailing
 *  spaces dropped, leading/trailing blank lines removed and runs of blank
 *  lines collapsed to one (a selection across paragraphs picks up several),
 *  which stays one quote: blank lines inside it become a bare `>`. */
export function formatQuote(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').replace(/ /g, ' ').split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out: string[] = [];
  for (const l of lines) {
    if (l === '' && out[out.length - 1] === '') continue;
    out.push(l);
  }
  return out.map((l) => (l === '' ? '>' : `> ${l}`)).join('\n');
}

/**
 * Splice a block (a quote) into `cur` at `pos`, on its own lines: separated
 * from text before it by a blank line, the caret on the very next line, so
 * typing starts the answer right under the quote. Text after the caret is kept,
 * pushed below the answer line.
 */
export function insertQuoteBlock(cur: string, pos: number, block: string): { next: string; caret: number } {
  const at = Math.max(0, Math.min(pos, cur.length));
  const before = cur.slice(0, at).replace(/[ \t]+$/, '');
  const after = cur.slice(at).replace(/^[ \t]+/, '');
  const lead = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const head = before + lead + block + '\n';
  const tail = after === '' ? '' : after.startsWith('\n') ? after : '\n' + after;
  return { next: head + tail, caret: head.length };
}

export type QuoteSegment = { quote: boolean; text: string };

/** Split a plain-text message into runs of `>` lines (rendered as a quote)
 *  and the rest, for the user bubble. A quote line is `>` alone or `> …`
 *  at the start of a line; the marker (and one space) is stripped. */
export function splitQuotedLines(text: string): QuoteSegment[] {
  const segs: QuoteSegment[] = [];
  for (const line of text.split('\n')) {
    const m = /^>(?: |$)(.*)$/.exec(line);
    const quote = !!m;
    const body = m ? m[1] : line;
    const last = segs[segs.length - 1];
    if (last && last.quote === quote) last.text += '\n' + body;
    else segs.push({ quote, text: body });
  }
  // The newline on either side of a quote run belongs to the layout (the
  // quote is a block), not to the neighbouring text.
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].quote) continue;
    if (segs[i - 1]?.quote) segs[i].text = segs[i].text.replace(/^\n/, '');
    if (segs[i + 1]?.quote) segs[i].text = segs[i].text.replace(/\n$/, '');
  }
  return segs;
}

/** The quotable container holding `node`, or null. */
function quotableOf(node: Node | null): Element | null {
  const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
  return el?.closest(QUOTABLE_SELECTOR) ?? null;
}

/** The current selection, if it is quotable inside `root`: it STARTS in a
 *  quotable element and ends in the same one — or just past it (a triple-
 *  click puts the end at the start of the next block; a drag overshoots),
 *  in which case it is clamped to the element. Ending inside ANOTHER
 *  quotable element is a two-bubble selection: not quotable. Returns the
 *  text and the rectangle to anchor the button on. */
export function quotableSelection(root: HTMLElement | null, sel: Selection | null):
  { text: string; rect: DOMRect } | null {
  if (!root || !sel || sel.isCollapsed || sel.rangeCount !== 1) return null;
  const range = sel.getRangeAt(0).cloneRange();
  const startBox = quotableOf(range.startContainer);
  const endBox = quotableOf(range.endContainer);
  const box = startBox ?? endBox;
  if (!box || !root.contains(box)) return null;
  if (startBox && endBox && startBox !== endBox) return null;
  if (!startBox) range.setStart(box, 0);
  if (!endBox) range.setEnd(box, box.childNodes.length);
  const text = range.toString();
  if (!text.trim()) return null;
  const rects = range.getClientRects();
  const rect = rects.length ? rects[0] : range.getBoundingClientRect();
  return { text, rect: rects.length > 1 ? mergeRects(rects) : rect };
}

function mergeRects(rects: DOMRectList): DOMRect {
  let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of Array.from(rects)) {
    if (r.width === 0 && r.height === 0) continue;
    top = Math.min(top, r.top); left = Math.min(left, r.left);
    right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
