'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { wheelFactor } from './fileViews';

// The PDF pane (§14.110). The browser's own viewer cannot be the answer here:
// Chrome refuses it inside a sandboxed response, Android has none at all, and
// iOS paints one page as a picture. pdf.js renders the same pages everywhere.
// Lazy twice over: this module is a next/dynamic chunk, and pdf.js itself
// (~1MB + its worker) is imported only once a PDF is actually opened.

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
    // The worker is emitted as a plain asset (never re-bundled): pdf.js loads
    // it as a module worker from this URL.
    m.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url,
    ).toString();
    return m;
  }).catch((e: unknown) => { pdfjsPromise = null; throw e; });
  return pdfjsPromise;
}

/** PDF points → CSS px: scale 1 is the printed size. */
const CSS_UNITS = 96 / 72;
/** "Fit" never blows a page up past this on a wide screen. */
const AUTO_MAX = 1.25;
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const PAD = 16;
/** One canvas past this many device pixels is a memory problem on a phone. */
const MAX_CANVAS_PIXELS = 8_000_000;

type Size = { w: number; h: number };

function errorText(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'PasswordException') return 'this PDF is password-protected — download it to open it';
  if (name === 'InvalidPDFException') return 'this file is not a valid PDF';
  if (name === 'ResponseException') return 'could not read this file from the VPS';
  return e instanceof Error ? e.message : String(e);
}

export default function PdfViewer({ url, name, rev = 0 }: { url: string; name: string; rev?: number }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [lib, setLib] = useState<PdfJs | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(0);
  const [zoom, setZoom] = useState<'auto' | number>('auto');
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  // Where to land after a re-render moves everything: a reload of the same
  // file keeps the reader's place, a zoom keeps the same point of the page.
  const anchorRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    let task: PDFDocumentLoadingTask | null = null;
    if (scroller && scroller.scrollHeight > 0) anchorRef.current = scroller.scrollTop / scroller.scrollHeight;
    setErr(null);
    setProgress(0);
    loadPdfJs().then((pdfjs) => {
      if (!alive) return null;
      setLib(pdfjs);
      task = pdfjs.getDocument({
        url,
        // ONE request. Each range read would be its own SSH channel on the
        // hub (§14.30) — a 10MB file would open a hundred and sixty.
        disableRange: true,
        cMapUrl: '/api/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/api/pdfjs/standard_fonts/',
        wasmUrl: '/api/pdfjs/wasm/',
        iccUrl: '/api/pdfjs/iccs/',
        enableXfa: false,
      });
      task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
        if (alive && total > 0) setProgress(Math.min(1, loaded / total));
      };
      return task.promise;
    }).then(async (pdf) => {
      if (!pdf) return;
      if (!alive) { void pdf.loadingTask.destroy(); return; }
      const first = await pdf.getPage(1);
      if (!alive) { void pdf.loadingTask.destroy(); return; }
      const v1 = first.getViewport({ scale: 1 });
      const base = { w: v1.width, h: v1.height };
      const all: Size[] = Array.from({ length: pdf.numPages }, () => base);
      void docRef.current?.loadingTask.destroy();
      docRef.current = pdf;
      setDoc(pdf);
      setSizes(all);
      setProgress(null);
      // Mixed page sizes (a landscape table in a portrait report) arrive in
      // the background; until then every placeholder borrows page 1's.
      let differs = false;
      for (let i = 2; i <= pdf.numPages; i++) {
        const p = await pdf.getPage(i);
        if (!alive || docRef.current !== pdf) return;
        const v = p.getViewport({ scale: 1 });
        if (v.width !== base.w || v.height !== base.h) { all[i - 1] = { w: v.width, h: v.height }; differs = true; }
      }
      if (differs && alive) setSizes([...all]);
    }).catch((e: unknown) => {
      if (alive) { setErr(errorText(e)); setProgress(null); }
    });
    return () => {
      alive = false;
      // A load still in flight dies here. The document on screen stays until
      // its replacement is ready (or the pane unmounts): a reload must not
      // blank the pages the reader is looking at.
      if (task && docRef.current?.loadingTask !== task) void task.destroy();
    };
  // `scroller` is read for the anchor only; a new element must not reload.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, rev]);

  useEffect(() => () => { void docRef.current?.loadingTask.destroy(); docRef.current = null; }, []);

  useEffect(() => {
    if (!scroller) return;
    const ro = new ResizeObserver(() => setWidth(scroller.clientWidth));
    ro.observe(scroller);
    setWidth(scroller.clientWidth);
    return () => ro.disconnect();
  }, [scroller]);

  const maxW = useMemo(() => sizes.reduce((m, s) => Math.max(m, s.w), 0), [sizes]);
  const fit = maxW > 0 && width > 0 ? Math.max(0.1, (width - 2 * PAD) / (maxW * CSS_UNITS)) : 1;
  const scale = zoom === 'auto' ? Math.min(fit, AUTO_MAX) : zoom;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const zoomTo = useCallback((next: 'auto' | number) => {
    if (scroller && scroller.scrollHeight > 0) anchorRef.current = scroller.scrollTop / scroller.scrollHeight;
    setZoom(next);
  }, [scroller]);
  const step = useCallback((dir: 1 | -1) => {
    const next = dir > 0
      ? STEPS.find((s) => s > scale * 1.01) ?? STEPS[STEPS.length - 1]
      : [...STEPS].reverse().find((s) => s < scale * 0.99) ?? STEPS[0];
    zoomTo(next);
  }, [scale, zoomTo]);

  useLayoutEffect(() => {
    if (!scroller || anchorRef.current == null || !sizes.length) return;
    scroller.scrollTop = anchorRef.current * scroller.scrollHeight;
    anchorRef.current = null;
  }, [scroller, scale, sizes]);

  // Ctrl+wheel (and a trackpad pinch, which Chrome reports as one) zooms the
  // document, not the whole hub. Native listener: React's wheel is passive.
  useEffect(() => {
    if (!scroller) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // Continuous, like the image viewer: a pinch must not jump a whole
      // step per event.
      const next = Math.min(STEPS[STEPS.length - 1], Math.max(STEPS[0], scaleRef.current * wheelFactor(e)));
      zoomTo(Math.round(next * 100) / 100);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [scroller, zoomTo]);

  const onScroll = useCallback(() => {
    if (!scroller) return;
    const mark = scroller.scrollTop + scroller.clientHeight / 3;
    const pages = scroller.querySelectorAll<HTMLElement>('.pdfv-page');
    let current = 1;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].offsetTop <= mark) current = i + 1; else break;
    }
    setPage(current);
  }, [scroller]);

  const goTo = useCallback((n: number) => {
    if (!scroller || !sizes.length) return;
    const target = Math.min(sizes.length, Math.max(1, Math.round(n)));
    const el = scroller.querySelectorAll<HTMLElement>('.pdfv-page')[target - 1];
    if (el) scroller.scrollTop = el.offsetTop - PAD;
    setPage(target);
  }, [scroller, sizes.length]);

  return (
    <div className="pdfv">
      <div className="viewer-bar">
        <span className="pdfv-pages">
          <input
            aria-label="page"
            inputMode="numeric"
            value={pageDraft ?? String(page)}
            disabled={!doc}
            onChange={(e) => setPageDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={(e) => e.target.select()}
            onBlur={() => setPageDraft(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { goTo(Number(pageDraft || page)); setPageDraft(null); (e.target as HTMLInputElement).blur(); }
              // Taken: this Esc cancels the page number, not the full-screen pane.
              if (e.key === 'Escape') { e.preventDefault(); setPageDraft(null); (e.target as HTMLInputElement).blur(); }
            }}
          />
          <span>/ {sizes.length || '…'}</span>
        </span>
        {progress != null && !err && (
          <span className="viewer-bar-note">loading {Math.round(progress * 100)}%</span>
        )}
        <span className="viewer-bar-spacer" />
        <button type="button" onClick={() => step(-1)} disabled={!doc} title="Zoom out (Ctrl+wheel)">−</button>
        <button type="button" className={zoom === 'auto' ? 'on' : ''} onClick={() => zoomTo('auto')}
                disabled={!doc} title="Fit the page width">
          {Math.round(scale * 100)}%
        </button>
        <button type="button" onClick={() => step(1)} disabled={!doc} title="Zoom in (Ctrl+wheel)">+</button>
      </div>
      {err && <div className="dvm-note err">{err}</div>}
      <div className="pdfv-scroll" ref={setScroller} onScroll={onScroll} aria-label={name}>
        {doc && lib && sizes.map((s, i) => (
          <PdfPage key={i} lib={lib} doc={doc} n={i + 1} size={s} scale={scale} root={scroller} />
        ))}
      </div>
    </div>
  );
}

function PdfPage({ lib, doc, n, size, scale, root }: {
  lib: PdfJs; doc: PDFDocumentProxy; n: number; size: Size; scale: number; root: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const s = scale * CSS_UNITS;
  // The box follows the zoom at once (the old bitmap stretches); the canvas
  // re-renders once the zoom settles — a pinch is dozens of scales a second.
  const [renderS, setRenderS] = useState(s);
  useEffect(() => {
    if (renderS === s) return;
    const t = setTimeout(() => setRenderS(s), 120);
    return () => clearTimeout(t);
  }, [s, renderS]);

  // Render what is on screen or about to be; release what has scrolled far
  // away — a 300-page report must not hold 300 canvases.
  useEffect(() => {
    const el = ref.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root, rootMargin: '150% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (near) return;
    canvasHost.current?.replaceChildren();
    textHost.current?.replaceChildren();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let text: InstanceType<PdfJs['TextLayer']> | null = null;
    (async () => {
      const p = await doc.getPage(n);
      if (cancelled) return;
      const viewport = p.getViewport({ scale: renderS });
      const dpr = window.devicePixelRatio || 1;
      const ratio = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      task = p.render({
        canvas, viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      await task.promise;
      if (cancelled) return;
      // Swapped in only once drawn: during a zoom the old bitmap, stretched,
      // stands in instead of a white flash.
      canvasHost.current?.replaceChildren(canvas);
      const host = textHost.current;
      if (!host) return;
      host.replaceChildren();
      text = new lib.TextLayer({ textContentSource: p.streamTextContent(), container: host, viewport });
      await text.render();
    })().catch((e: unknown) => {
      if ((e as { name?: string })?.name !== 'RenderingCancelledException' && !cancelled) {
        console.warn(`[pdf] page ${n}:`, e);
      }
    });
    return () => {
      cancelled = true;
      task?.cancel();
      text?.cancel();
    };
  }, [near, lib, doc, n, renderS]);

  return (
    <div
      ref={ref}
      className="pdfv-page"
      data-page={n}
      style={{
        width: Math.floor(size.w * s), height: Math.floor(size.h * s),
        '--total-scale-factor': String(s),
      } as CSSProperties}
    >
      <div className="pdfv-canvas" ref={canvasHost} />
      <div className="textLayer" ref={textHost} />
    </div>
  );
}
