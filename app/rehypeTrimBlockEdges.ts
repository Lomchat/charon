/**
 * Chat bubbles render Markdown under `white-space: pre-wrap` (plain text and
 * the live preview need it), so every "\n" that mdast-util-to-hast leaves
 * between blocks shows. BETWEEN two blocks it is the bubble's one blank line.
 * At the START of a list, a list item or a quote it opens a SECOND one: a list
 * two lines under its paragraph, a loose list's bullet alone on its line
 * (`<li>\n<p>`). This drops the blank text at the edges of those containers and
 * nothing else; where white-space collapses (`.md-doc`) it changes nothing.
 */

type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[] };

const EDGE_TRIMMED = new Set(['ul', 'ol', 'li', 'blockquote']);

const isBlank = (n: HastNode | undefined) => n?.type === 'text' && (n.value ?? '').trim() === '';

function trim(node: HastNode): void {
  const c = node.children;
  if (!c) return;
  if (node.type === 'element' && EDGE_TRIMMED.has(node.tagName ?? '')) {
    while (isBlank(c[0])) c.shift();
    while (isBlank(c[c.length - 1])) c.pop();
  }
  for (const child of c) if (child.type === 'element') trim(child);
}

export function rehypeTrimBlockEdges() {
  return (tree: HastNode) => { trim(tree); };
}
