// Raw source text of a hast node, used by the per-code-block copy button
// (`Message § CodeBlock`).
//
// Why not read the React children: by the time a fenced block renders, its
// children are rehype-highlight's `<span class="hljs-…">` soup, so recovering
// the source means walking THAT tree with a case per element — and getting it
// subtly wrong (a dropped span, a joined line) means the clipboard holds
// something that isn't what's on screen. The hast node react-markdown hands
// every custom component still has the original text leaves, unhighlighted,
// in order, so the walk is one case: concatenate them.
export function hastText(node: unknown): string {
  const n = node as { type?: string; value?: unknown; children?: unknown[] } | null | undefined;
  if (!n || typeof n !== 'object') return '';
  if (n.type === 'text') return typeof n.value === 'string' ? n.value : '';
  return Array.isArray(n.children) ? n.children.map(hastText).join('') : '';
}
