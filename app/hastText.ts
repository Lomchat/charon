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

// Only explicitly labelled fenced code is a diagram; ordinary code and
// unlabelled snippets must never be guessed from their contents.
export function hastCodeLanguage(node: unknown): string | undefined {
  const pre = node as { type?: string; tagName?: string; children?: unknown[] } | null | undefined;
  if (pre?.type !== 'element' || pre.tagName !== 'pre' || !Array.isArray(pre.children)) return;
  const code = pre.children[0] as {
    type?: string; tagName?: string; properties?: { className?: unknown };
  } | undefined;
  if (code?.type !== 'element' || code.tagName !== 'code') return;
  const classes = code.properties?.className;
  if (!Array.isArray(classes)) return;
  const language = classes.find((value: unknown) => typeof value === 'string' && value.startsWith('language-'));
  return typeof language === 'string' ? language.slice('language-'.length).toLowerCase() : undefined;
}
