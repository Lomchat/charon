import type { MermaidConfig } from 'mermaid';

// Mermaid owns global configuration. Serialize initialize + render together,
// including failures, so simultaneous bubbles cannot change each other's theme.
let pending: Promise<unknown> = Promise.resolve();
let nextId = 0;

export function renderMermaid(source: string, themeVariables: NonNullable<MermaidConfig['themeVariables']>): Promise<string> {
  const result = pending.then(async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      htmlLabels: false,
      // Diagram directives cannot relax security, quotas or SVG-only labels.
      secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart'],
      flowchart: { htmlLabels: false },
      theme: 'base',
      themeVariables,
    });
    const host = document.createElement('div');
    host.style.position = 'absolute';
    host.style.left = '-10000px';
    host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(host);
    try {
      // A dedicated host also contains parser error markup. Always remove it,
      // even if this bubble unmounts while a queued render is still running.
      const { svg } = await mermaid.render(`charon-mermaid-${++nextId}`, source, host);
      return svg;
    } finally {
      host.remove();
    }
  });
  pending = result.catch(() => undefined);
  return result;
}
