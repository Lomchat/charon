// The session search's words, painted inside the bubble a jump landed on:
// CSS Custom Highlights (`::highlight(charon-search)`, app.css) — ranges over
// the text nodes, no DOM change (React owns that DOM). Case and accents are
// ignored, like the hub's index (unicode61 remove_diacritics). Without the
// API (older browsers) the bubble's flash alone marks it.

const NAME = 'charon-search';
const MAX_RANGES = 400;

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | null =>
  (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null;

/** `text` folded (lower case, no accents) and, per folded char, its index in `text`. */
function fold(text: string): { folded: string; at: number[] } {
  let folded = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = text[i]!.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k++) { folded += f[k]; at.push(i); }
  }
  at.push(text.length);
  return { folded, at };
}

export function highlightTerms(root: Element, terms: readonly string[]): void {
  const reg = registry();
  const Ctor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !Ctor) return;
  const words = [...new Set(terms.map((t) => fold(t).folded).filter(Boolean))];
  if (!words.length) { reg.delete(NAME); return; }
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && ranges.length < MAX_RANGES; n = walker.nextNode()) {
    const { folded, at } = fold(n.nodeValue ?? '');
    for (const w of words) {
      for (let i = folded.indexOf(w); i >= 0 && ranges.length < MAX_RANGES; i = folded.indexOf(w, i + w.length)) {
        const r = document.createRange();
        r.setStart(n, at[i]!);
        r.setEnd(n, at[i + w.length] ?? (n.nodeValue ?? '').length);
        ranges.push(r);
      }
    }
  }
  reg.set(NAME, new Ctor(...ranges));
}

export function clearSearchHighlight(): void {
  registry()?.delete(NAME);
}
