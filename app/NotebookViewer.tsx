'use client';
import {
  memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ComponentProps, type ReactNode,
} from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { api } from '@/lib/api';
import {
  MARKDOWN_COMPONENTS, MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS, MessageLink,
} from './Message';
import { remarkFilePaths } from './messageLinks';
import { hastText } from './hastText';
import { markdownSlug, resolveDocPath, rootedPath, type TextViewerProps } from './fileViews';
import {
  fenceCode, htmlNeedsScripts, jupyterAnchor, parseNotebook,
  type NbCell, type NbOutput, type Notebook,
} from './notebook';
import { frameDocument, outputFrameCss } from './documentViews';
import DocFrame, { sanitizeFrameHtml, usePaper } from './DocFrame';
import { useTheme } from './themeClient';

type MarkdownProps = ComponentProps<typeof ReactMarkdown>;
type Components = NonNullable<MarkdownProps['components']>;
type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/** Outputs taller than this fold behind "show all" (a 2000-line log is not the point of a notebook). */
const OUTPUT_FOLD_PX = 400;

/** What every cell needs to resolve links: the notebook's place on the VPS. */
type Ctx = { vpsId: string; root: string; docDir: string; jump: (anchor: string) => void };

/**
 * A Jupyter notebook rendered as Jupyter shows it (§14.111): Markdown cells
 * through the chat's renderer, code with `In [n]:` and highlighting, saved
 * outputs below. Nothing executes — HTML outputs live in a script-less
 * sandbox. It renders the pane's buffer, so unsaved edits show; a hidden pane
 * keeps the last text it showed instead of re-parsing every keystroke.
 */
export default function NotebookViewer({ vpsId, root, path, text, active }: TextViewerProps) {
  const shownText = useRef(text);
  if (active) shownText.current = text;
  const deferred = useDeferredValue(shownText.current);
  const parsed = useMemo(() => parseNotebook(deferred), [deferred]);
  // Mid-edit the JSON is often briefly invalid: keep the last good render
  // under the error instead of blanking the document.
  const lastGood = useRef<Notebook | null>(null);
  if (parsed.ok) lastGood.current = parsed.notebook;
  const nb = parsed.ok ? parsed.notebook : lastGood.current;

  const [showOutputs, setShowOutputs] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const absPath = `${root.replace(/\/+$/, '')}/${path}`;
  const docDir = absPath.slice(0, absPath.lastIndexOf('/')) || '/';

  const jump = useCallback((anchor: string) => {
    const el = scroller.current;
    if (!el) return;
    const q = CSS.escape(anchor);
    el.querySelector(`[data-anchor="${q}"], [data-slug="${CSS.escape(anchor.toLowerCase())}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);
  const ctx = useMemo<Ctx>(() => ({ vpsId, root, docDir, jump }), [vpsId, root, docDir, jump]);

  const counts = useMemo(() => {
    const c = { code: 0, outputs: 0 };
    for (const cell of nb?.cells ?? []) if (cell.type === 'code') { c.code++; c.outputs += cell.outputs.length; }
    return c;
  }, [nb]);

  const language = nb?.language ?? 'python';
  return (
    <div className="nbv">
      <div className="viewer-bar">
        {nb && (
          <span className="viewer-bar-note" title={nb.kernel ?? undefined}>
            {nb.kernel ?? language} · {nb.cells.length.toLocaleString()} {nb.cells.length === 1 ? 'cell' : 'cells'}
            {nb.kernel && nb.kernel.toLowerCase().indexOf(language) < 0 ? ` · ${language}` : ''}
          </span>
        )}
        <span className="viewer-bar-spacer" />
        {counts.outputs > 0 && (
          <button type="button" className={showOutputs ? 'on' : ''} onClick={() => setShowOutputs((v) => !v)}
            title={showOutputs ? 'Hide every output' : 'Show the saved outputs'}>
            Outputs
          </button>
        )}
      </div>
      {!parsed.ok && <div className="dvm-note err">{parsed.error}</div>}
      <div className="nbv-scroll" ref={scroller}>
        {nb && (
          <div className={`nbv-doc${parsed.ok ? '' : ' stale'}`}>
            {nb.cells.length === 0 && <div className="nbv-empty">This notebook has no cells.</div>}
            {nb.cells.map((cell, i) => (
              <Cell key={i} cell={cell} language={language} ctx={ctx} showOutputs={showOutputs} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const Cell = memo(function Cell({ cell, language, ctx, showOutputs }: {
  cell: NbCell; language: string; ctx: Ctx; showOutputs: boolean;
}) {
  if (cell.type === 'markdown') {
    return (
      <section className="nbv-cell nbv-markdown">
        <div className="nbv-prompt" aria-hidden />
        <div className="nbv-body md-doc">
          <MarkdownCell source={cell.source} attachments={cell.attachments} ctx={ctx} />
        </div>
      </section>
    );
  }
  if (cell.type === 'raw') {
    return (
      <section className="nbv-cell nbv-raw">
        <div className="nbv-prompt" aria-hidden />
        <pre className="nbv-body nbv-pre">{cell.source}</pre>
      </section>
    );
  }
  const n = cell.executionCount;
  return (
    <section className="nbv-cell nbv-code">
      <div className="nbv-prompt nbv-in">In&nbsp;[{n ?? ' '}]:</div>
      <div className="nbv-body nbv-input">
        <CodeSource source={cell.source} language={language} />
      </div>
      {showOutputs && cell.outputs.length > 0 && <Outputs outputs={cell.outputs} ctx={ctx} />}
    </section>
  );
});

const CodeSource = memo(function CodeSource({ source, language }: { source: string; language: string }) {
  const md = useMemo(() => fenceCode(source, language), [source, language]);
  return (
    <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {md}
    </ReactMarkdown>
  );
});

// `attachment:` (cell attachments) and inline image data are what notebooks
// embed; react-markdown's default would blank both.
function urlTransform(url: string, key: string): string {
  if (key === 'src' && /^(?:attachment:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,])/i.test(url)) return url;
  return defaultUrlTransform(url);
}

/** A Markdown cell: MarkdownFileView's addressing (links/images from the notebook's folder), per cell. */
const MarkdownCell = memo(function MarkdownCell({ source, attachments, ctx }: {
  source: string; attachments: Record<string, string>; ctx: Ctx;
}) {
  const { vpsId, root, docDir, jump } = ctx;
  const slugs = useRef(new Map<string, number>());
  slugs.current = new Map();

  const remarkPlugins = useMemo<NonNullable<MarkdownProps['remarkPlugins']>>(() => [
    ...MARKDOWN_REMARK_PLUGINS,
    [remarkFilePaths, { accept: (href: string) => resolveDocPath(docDir, href) != null }],
  ], [docDir]);

  const components = useMemo<Components>(() => {
    const heading = (Tag: HeadingTag) => function Heading(
      { node, children, ...props }: ComponentProps<HeadingTag> & { node?: unknown; children?: ReactNode },
    ) {
      const text = hastText(node);
      return (
        <Tag {...props} data-slug={markdownSlug(text, slugs.current)} data-anchor={jupyterAnchor(text)}>
          {children}
        </Tag>
      );
    };
    return {
      ...MARKDOWN_COMPONENTS,
      h1: heading('h1'), h2: heading('h2'), h3: heading('h3'),
      h4: heading('h4'), h5: heading('h5'), h6: heading('h6'),
      a: ({ node: _node, href, ...props }) => {
        if (href?.startsWith('#')) {
          return <a {...props} href={href} onClick={(event) => {
            event.preventDefault();
            let anchor = href.slice(1);
            try { anchor = decodeURIComponent(anchor); } catch { /* keep it raw */ }
            jump(anchor);
          }} />;
        }
        const abs = href ? resolveDocPath(docDir, href) : null;
        return <MessageLink {...props} href={abs ?? href} vpsId={vpsId} cwd={root} />;
      },
      img: ({ node: _node, src, alt, ...props }) => {
        let url = typeof src === 'string' ? src : undefined;
        if (url && /^attachment:/i.test(url)) {
          const name = url.slice('attachment:'.length);
          let decoded = name;
          try { decoded = decodeURIComponent(name); } catch { /* keep it raw */ }
          url = attachments[name] ?? attachments[decoded];
        } else if (url && !/^data:/i.test(url)) {
          const abs = resolveDocPath(docDir, url);
          if (abs) {
            const at = rootedPath(root, abs.split('#', 1)[0]);
            url = api.fsFileUrl(vpsId, at.root, at.path, { inline: true });
          }
        }
        if (!url) return <span className="nbv-missing">[{alt || 'missing image'}]</span>;
        // eslint-disable-next-line @next/next/no-img-element
        return <img {...props} src={url} alt={alt ?? ''} loading="lazy" />;
      },
    };
  }, [vpsId, root, docDir, jump, attachments]);

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      components={components} urlTransform={urlTransform}>
      {source}
    </ReactMarkdown>
  );
});

/** A cell's outputs, folded past OUTPUT_FOLD_PX until asked. */
function Outputs({ outputs, ctx }: { outputs: NbOutput[]; ctx: Ctx }) {
  const inner = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    // Hysteresis: only fold what is clearly longer than the fold.
    const check = () => setTall(el.offsetHeight > OUTPUT_FOLD_PX * 1.25);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const folded = tall && !open;
  return (
    <div className="nbv-outputs">
      <div className={`nbv-output-clip${folded ? ' folded' : ''}`}>
        <div ref={inner}>
          {outputs.map((o, i) => <Output key={i} output={o} ctx={ctx} />)}
        </div>
      </div>
      {tall && (
        <button type="button" className="nbv-more" onClick={() => setOpen((v) => !v)}>
          {open ? 'Collapse output' : 'Show all output'}
        </button>
      )}
    </div>
  );
}

function Output({ output, ctx }: { output: NbOutput; ctx: Ctx }) {
  const prompt = output.kind === 'data' && output.result
    ? <div className="nbv-prompt nbv-out">Out[{output.executionCount ?? ' '}]:</div>
    : <div className="nbv-prompt" aria-hidden />;
  return <div className="nbv-output">{prompt}<div className="nbv-body">{renderOutput(output, ctx)}</div></div>;
}

function renderOutput(o: NbOutput, ctx: Ctx): ReactNode {
  switch (o.kind) {
    case 'stream':
      return <pre className={`nbv-pre nbv-stream${o.name === 'stderr' ? ' stderr' : ''}`}>{o.text}</pre>;
    case 'error':
      return (
        <div className="nbv-error">
          <div className="nbv-error-head">{o.ename}{o.evalue ? `: ${o.evalue}` : ''}</div>
          {o.traceback.trim() && <pre className="nbv-pre">{o.traceback}</pre>}
        </div>
      );
    case 'unsupported':
      return <div className="nbv-unsupported">[output not shown: {o.mimes.join(', ') || 'empty bundle'}]</div>;
    case 'data':
      break;
  }
  const { mime, text } = o;
  if (mime === 'image/svg+xml') return <SvgImage svg={text} width={o.width} height={o.height} />;
  if (mime.startsWith('image/')) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="nbv-img" src={`data:${mime};base64,${text}`} alt="output" width={o.width} height={o.height} />;
  }
  if (mime === 'text/html') return <HtmlOutput html={text} />;
  if (mime === 'text/markdown') {
    return (
      <div className="md-doc nbv-md-output">
        <MarkdownCell source={text} attachments={NO_ATTACHMENTS} ctx={ctx} />
      </div>
    );
  }
  return <pre className="nbv-pre">{text}</pre>;
}

const NO_ATTACHMENTS: Record<string, string> = {};

/** SVG through a Blob URL in an `<img>`: drawn, never scripted, no data-URI escaping. */
function SvgImage({ svg, width, height }: { svg: string; width?: number; height?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [svg]);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img className="nbv-img" src={url} alt="output" width={width} height={height} /> : null;
}

function HtmlOutput({ html }: { html: string }) {
  const paper = usePaper();
  const { scrollbar } = useTheme();
  const clean = useMemo(() => sanitizeFrameHtml(html), [html]);
  const srcDoc = useMemo(
    () => frameDocument({ css: outputFrameCss(paper), head: clean.head, body: clean.body, scrollbar }),
    [clean, paper, scrollbar],
  );
  return (
    <>
      <DocFrame className="nbv-frame" title="HTML output" srcDoc={srcDoc} />
      {htmlNeedsScripts(html) && (
        <div className="nbv-unsupported">This output needs JavaScript, which the viewer never runs: interactive parts may be missing.</div>
      )}
    </>
  );
}
