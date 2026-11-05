'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ByteViewerProps } from './fileViews';
import {
  countWords, docxErrorText, docxFrameCss, fetchFileBytes, frameDocument, isAbort,
  sniffContainer, summarizeMessages, type ConversionMessage,
} from './documentViews';
import DocFrame, { sanitizeFrameHtml, usePaper } from './DocFrame';
import { useTheme } from './themeClient';

// A Word document as a page (§14.111): mammoth turns the .docx into plain
// semantic HTML (headings, lists, tables, images as data: URIs), shown on
// the white paper plate in a script-less sandbox. Layout-exact rendering
// (columns, headers/footers, page breaks) is Word's job — this is for
// READING. Lazy twice over: this module is a dynamic chunk, and mammoth
// (~600KB with its unzip) loads only once a document is actually opened.

type Mammoth = typeof import('mammoth/mammoth.browser');

let mammothPromise: Promise<Mammoth> | null = null;
function loadMammoth(): Promise<Mammoth> {
  // A browserify bundle: the CommonJS export arrives as `default`.
  mammothPromise ??= import('mammoth/mammoth.browser')
    .then((m) => (m as unknown as { default?: Mammoth }).default ?? (m as unknown as Mammoth))
    .catch((e: unknown) => { mammothPromise = null; throw e; });
  return mammothPromise;
}

/** Word's stock styles mammoth leaves unmapped — each would otherwise be a warning and a plain paragraph. */
const STYLE_MAP = [
  "p[style-name='Title'] => h1.title:fresh",
  "p[style-name='Subtitle'] => p.subtitle:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
];

type Loaded = {
  /** Sanitized body markup; the srcdoc around it follows the theme's paper. */
  body: string;
  empty: boolean;
  words: number;
  messages: Array<ConversionMessage & { count: number }>;
};

export default function DocxViewer({ url, name, rev, active }: ByteViewerProps) {
  // A change noticed while the pane is hidden is fetched once it is shown.
  const [loadRev, setLoadRev] = useState(rev);
  useEffect(() => { if (active) setLoadRev(rev); }, [active, rev]);

  const [doc, setDoc] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showWarnings, setShowWarnings] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    (async () => {
      const buf = await fetchFileBytes(url, ac.signal);
      const container = sniffContainer(new Uint8Array(buf, 0, Math.min(8, buf.byteLength)));
      if (container !== 'zip') throw new Error(docxErrorText(null, container));
      let result: Awaited<ReturnType<Mammoth['convertToHtml']>>;
      try {
        const mammoth = await loadMammoth();
        result = await mammoth.convertToHtml({ arrayBuffer: buf }, { styleMap: STYLE_MAP });
      } catch (e) {
        throw new Error(docxErrorText(e));
      }
      if (ac.signal.aborted) return;
      const clean = sanitizeFrameHtml(result.value);
      // The document on screen stays until its replacement is ready: a
      // reload must not blank the page being read (DocFrame keeps its height).
      setDoc({
        body: clean.body,
        empty: !clean.body.trim(),
        words: countWords(clean.text),
        messages: summarizeMessages(result.messages),
      });
      setErr(null);
    })().catch((e: unknown) => {
      if (!ac.signal.aborted && !isAbort(e)) setErr(e instanceof Error ? e.message : String(e));
    }).finally(() => {
      if (!ac.signal.aborted) setLoading(false);
    });
    return () => ac.abort();
  }, [url, loadRev]);

  const paper = usePaper();
  const { scrollbar } = useTheme();
  const body = doc?.body;
  const srcDoc = useMemo(() => (body ? frameDocument({ css: docxFrameCss(paper), body, scrollbar }) : ''), [body, paper, scrollbar]);
  const warnings = doc?.messages ?? [];
  const note = !doc
    ? (loading ? 'loading…' : '')
    : `${doc.words.toLocaleString()} ${doc.words === 1 ? 'word' : 'words'}${loading ? ' · reloading…' : ''}`;

  return (
    <div className="docxv">
      <div className="viewer-bar">
        <span className="viewer-bar-note">{note}</span>
        <span className="viewer-bar-spacer" />
        {warnings.length > 0 && (
          <button type="button" className={showWarnings ? 'on' : ''} onClick={() => setShowWarnings((v) => !v)}
            title="What the conversion could not carry over">
            Warnings ({warnings.length})
          </button>
        )}
      </div>
      {err && <div className="dvm-note err">{err}</div>}
      {showWarnings && warnings.length > 0 && (
        <ul className="docxv-warnings">
          {warnings.map((m, i) => (
            <li key={i} className={m.type === 'error' ? 'err' : undefined}>
              {m.message}{m.count > 1 && <span className="docxv-count"> ×{m.count}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="docxv-scroll" aria-label={name}>
        {doc && (doc.empty
          ? <div className="docxv-empty">This document has no text.</div>
          : (
            <div className="docxv-page">
              <DocFrame className="docxv-frame" title={name} srcDoc={srcDoc} />
            </div>
          ))}
      </div>
    </div>
  );
}
