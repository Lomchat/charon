'use client';

import { useEffect, useRef, useState } from 'react';
import { renderMermaid } from './mermaidRenderer';

export default function MermaidDiagram({ source }: { source: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? '');
  const [actualSize, setActualSize] = useState(false);
  const [result, setResult] = useState<{ source: string; theme: string; svg?: string; failed?: boolean }>();

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(root.dataset.theme ?? '');
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;
    const style = getComputedStyle(container.current);
    const token = (name: string) => style.getPropertyValue(name).trim();
    void renderMermaid(source, {
      background: token('--bg-inset'),
      primaryColor: token('--bg-raised'),
      primaryTextColor: token('--text'),
      primaryBorderColor: token('--accent'),
      secondaryColor: token('--bg-elevated'),
      tertiaryColor: token('--bg-inset'),
      textColor: token('--text'),
      lineColor: token('--text-muted'),
      mainBkg: token('--bg-raised'),
      nodeBorder: token('--accent'),
      clusterBkg: token('--bg-elevated'),
      clusterBorder: token('--border'),
      edgeLabelBackground: token('--bg-inset'),
      fontFamily: style.fontFamily,
    }).then(
      (svg) => { if (!cancelled) setResult({ source, theme, svg }); },
      () => { if (!cancelled) setResult({ source, theme, failed: true }); },
    );
    return () => { cancelled = true; };
  }, [source, theme]);

  const current = result?.source === source && result.theme === theme ? result : undefined;
  useEffect(() => {
    const svg = container.current?.querySelector('svg');
    if (svg && svg.viewBox.baseVal.width > 0) {
      // Mermaid's percentage width shrinks a wide flowchart into illegible
      // labels on phones. Use its measured width and scroll the wrapper.
      svg.style.width = `${svg.viewBox.baseVal.width}px`;
    }
  }, [current?.svg, actualSize]);

  return (
    <div ref={container}>
      {current?.svg ? (
        <>
          {/* Mermaid sanitizes the SVG in strict mode; never bind callbacks. */}
          <div className={`mermaid-output${actualSize ? ' actual-size' : ''}`} role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: current.svg }} />
          <button type="button" className="mermaid-size-btn" aria-pressed={actualSize} onClick={() => setActualSize(value => !value)}>
            {actualSize ? 'Fit to width' : 'Actual size'}
          </button>
          <details className="mermaid-source">
            <summary>View source</summary>
            <pre><code className="language-mermaid">{source}</code></pre>
          </details>
        </>
      ) : (
        <>
          <p className="mermaid-status" role="status">
            {current?.failed ? 'Unable to render this diagram. Source shown below.' : 'Rendering diagram…'}
          </p>
          <pre><code className="language-mermaid">{source}</code></pre>
        </>
      )}
    </div>
  );
}
