// Office documents and sandboxed HTML (§14.111): which files have a rendered
// view, what their bytes really are, the srcdoc a sandboxed frame shows, and
// the spreadsheet window handed to the CSV grid.
// PLAIN module, no React/DOM — the viewers and vitest share it.
import { scrollbarCss, type ScrollbarColors } from '@/lib/scrollbarCss';

export function isNotebookName(name: string): boolean {
  return /\.ipynb$/i.test(name);
}

export function isDocxName(name: string): boolean {
  return /\.docx$/i.test(name);
}

export function isSpreadsheetName(name: string): boolean {
  return /\.(xlsx|xlsm|xls|ods)$/i.test(name);
}

/** The container under a file's first bytes: OOXML/ODF are ZIP; legacy and ENCRYPTED Office files are CFB. */
export type Container = 'zip' | 'cfb' | 'other';

export function sniffContainer(bytes: Uint8Array): Container {
  const at = (i: number) => bytes[i];
  if (at(0) === 0x50 && at(1) === 0x4b && (at(2) === 3 || at(2) === 5 || at(2) === 7)) return 'zip';
  const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length >= 8 && cfb.every((b, i) => at(i) === b)) return 'cfb';
  return 'other';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A failed .docx conversion, in words. `container` = what the bytes were. */
export function docxErrorText(e: unknown, container?: Container): string {
  if (container === 'cfb') return 'this document is password-protected or in the old .doc format — download it to open it';
  if (container === 'other') return 'this file is not a valid .docx document';
  const m = message(e);
  if (/main document part|zip|end of data|central directory/i.test(m)) return 'this file is not a valid .docx document';
  return `could not read this document: ${m}`;
}

/** A failed workbook read, in words. */
export function spreadsheetErrorText(e: unknown): string {
  const m = message(e);
  if (/password|encrypt/i.test(m)) return 'this workbook is password-protected — download it to open it';
  if (/zip|end of data|corrupt|workbook stream|central directory/i.test(m)) return 'this workbook is damaged or not a spreadsheet';
  return `could not read this workbook: ${m}`;
}

/**
 * Whether the bytes CAN be the format the name claims. SheetJS reads almost
 * anything as text, so a damaged .xlsx would otherwise open as one column of
 * garbage. `.xls` stays open-ended: BIFF, but also HTML/XML/CSV exports
 * named .xls by countless tools.
 */
export function spreadsheetContainerOk(name: string, container: Container): boolean {
  if (/\.xls$/i.test(name)) return true;
  return container !== 'other';
}

/** How a link inside a sandboxed document may behave. */
export type DocHref = 'fragment' | 'external' | 'blocked';

/**
 * In-page anchors scroll; web/mail links open a new tab; everything else
 * (javascript:, data:, file:, paths that only resolved where the document
 * was written) loses its href — `about:srcdoc` has nothing to resolve
 * them against and a popup must never carry a script URL.
 */
export function classifyDocHref(href: string): DocHref {
  const h = href.trim();
  if (h.startsWith('#')) return 'fragment';
  if (/^(?:https?:\/\/|mailto:|tel:)/i.test(h)) return 'external';
  return 'blocked';
}

/** Words as a reader counts them: letters/digits runs, apostrophes and hyphens kept inside. */
export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export type ConversionMessage = { type: string; message: string };

/** Converter warnings, duplicates folded ("Unrecognised style X" × 40 is one line). */
export function summarizeMessages(messages: readonly ConversionMessage[]): Array<ConversionMessage & { count: number }> {
  const out = new Map<string, ConversionMessage & { count: number }>();
  for (const m of messages) {
    const text = m.message.trim();
    const key = `${m.type}\u0000${text}`;
    const hit = out.get(key);
    if (hit) hit.count++; else out.set(key, { type: m.type, message: text, count: 1 });
  }
  return [...out.values()];
}

// ── Sandboxed document frames ───────────────────────────────────────────────
// The frame is `sandbox` WITHOUT allow-scripts: nothing inside can run, so
// the hub can keep `allow-same-origin` and measure the content's height.
// Belt and braces: a CSP forbids scripts too, and author <base>/<meta> are
// dropped by the sanitizer before this wraps the content.

/**
 * Ink and rules of a document drawn on the fixed white paper (`--media-bg`):
 * paper reads black in every theme, like a PDF page — so this is the one
 * place a literal colour is right. Every grey below is derived from it.
 */
const INK = '#000';
const LINK = '#1a55b0';
const ink = (pct: number) => `color-mix(in srgb, ${INK} ${pct}%, transparent)`;

/** A full srcdoc around sanitized content (`css` from the builders below). */
export function frameDocument({ css, head = '', body, scrollbar }: {
  css: string; head?: string; body: string;
  /** The theme's (`useTheme().scrollbar`): a wide table scrolls sideways with the hub's bar. */
  scrollbar?: ScrollbarColors;
}): string {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<base target="_blank">'
    + '<meta name="referrer" content="no-referrer">'
    + `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">`
    + `<style>${scrollbar ? scrollbarCss(scrollbar) : ''}${css}</style>${head}</head><body>${body}</body></html>`;
}

/**
 * Shared frame chrome: the page grows to its content (the hub sizes the
 * iframe), never scrolls vertically itself, scrolls sideways when a table
 * is wider than the pane.
 */
function frameBase(paper: string): string {
  return `html{background:${paper};color:${INK};overflow-y:hidden;overflow-x:auto;color-scheme:light}`
    + 'html,body{margin:0}body{display:flow-root;box-sizing:border-box;overflow-wrap:break-word}'
    + `a{color:${LINK}}img,video{max-width:100%;height:auto}`;
}

/** Word document typography: a readable page, bordered tables, footnotes set apart. `paper` = the resolved `--media-bg`. */
export function docxFrameCss(paper: string): string {
  return frameBase(paper)
    + 'body{max-width:800px;margin:0 auto;padding:56px 64px 72px;'
    + 'font:15px/1.6 Calibri,Carlito,"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif}'
    + 'h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.4em 0 .5em}h1{font-size:1.9em}h2{font-size:1.5em}'
    + 'h3{font-size:1.25em}h4{font-size:1.1em}h5,h6{font-size:1em}'
    + 'body>:first-child{margin-top:0}p{margin:0 0 .8em}ul,ol{margin:0 0 .8em;padding-left:1.8em}'
    + 'h1.title{font-size:2.3em;margin-bottom:.2em}p.subtitle{font-size:1.25em;color:' + ink(60) + ';margin-bottom:1.2em}'
    + 'blockquote{margin:0 0 .8em;padding:0 1em;border-left:3px solid ' + ink(25) + ';color:' + ink(75) + '}'
    + 'table{border-collapse:collapse;margin:0 0 1em;max-width:100%}'
    + 'td,th{border:1px solid ' + ink(40) + ';padding:4px 8px;vertical-align:top;text-align:left}'
    + 'th{background:' + ink(6) + '}td>:last-child,th>:last-child{margin-bottom:0}'
    + 'sup{line-height:0}sup a{text-decoration:none}'
    + 'ol:has(>li[id^="footnote-"]),ol:has(>li[id^="endnote-"]){margin-top:2.4em;padding-top:1em;'
    + 'border-top:1px solid ' + ink(25) + ';font-size:.88em}'
    + '@media (max-width:600px){body{padding:24px 18px 40px;font-size:15px}}';
}

/** Notebook HTML outputs (pandas tables, rich reprs): compact, Jupyter-like tables. */
export function outputFrameCss(paper: string): string {
  return frameBase(paper)
    + 'body{padding:8px 10px;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
    + 'body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}'
    + 'table{border-collapse:collapse;font-size:12px;border:0}'
    + 'th,td{padding:4px 8px;border:0;text-align:right;vertical-align:middle;white-space:nowrap}'
    + 'thead th{border-bottom:1px solid ' + ink(45) + ';vertical-align:bottom}'
    + 'tbody tr:nth-child(odd){background:' + ink(4) + '}tbody tr:hover{background:' + ink(9) + '}'
    + 'tbody th{font-weight:600}pre,code{font-family:ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace;font-size:12px}';
}

// ── Spreadsheets ────────────────────────────────────────────────────────────

/** csvTable.ts's own caps: a window past them would be built only to be cut. */
export const SHEET_MAX_ROWS = 50_000;
export const SHEET_MAX_COLUMNS = 500;
export const SHEET_MAX_CELLS = 1_000_000;

type Range = { s: { r: number; c: number }; e: { r: number; c: number } };

export type SheetWindow = {
  /** The sheet's extent counted from A1 — the grid shows A1 onward so its letters match the workbook's. */
  rows: number;
  cols: number;
  /** What is rendered: capped like the CSV grid. */
  shownRows: number;
  shownCols: number;
};

/**
 * `ref` = the range read (may be cut by the reader's row cap), `full` = the
 * sheet's real range when the reader cut it. Rows shrink to keep the window
 * under the cell cap; columns are capped first (a wide sheet keeps its
 * leading columns, like the CSV grid does).
 */
export function sheetWindow(ref: Range | null, full?: Range | null): SheetWindow {
  if (!ref) return { rows: 0, cols: 0, shownRows: 0, shownCols: 0 };
  const whole = full ?? ref;
  const rows = whole.e.r + 1;
  const cols = whole.e.c + 1;
  const shownCols = Math.min(ref.e.c + 1, SHEET_MAX_COLUMNS);
  const shownRows = Math.min(ref.e.r + 1, SHEET_MAX_ROWS, Math.floor(SHEET_MAX_CELLS / Math.max(1, shownCols)));
  return { rows, cols, shownRows, shownCols };
}

/**
 * Which sheet to show: the one already shown when it survived a reload,
 * else the workbook's active tab when visible, else the first visible sheet,
 * else (every sheet hidden) the first one.
 */
export function pickSheet(names: readonly string[], hidden: readonly boolean[], previous: string | null, activeTab?: number | null): string | null {
  if (!names.length) return null;
  if (previous != null && names.includes(previous)) return previous;
  if (activeTab != null && activeTab >= 0 && activeTab < names.length && !hidden[activeTab]) return names[activeTab];
  const visible = names.findIndex((_, i) => !hidden[i]);
  return names[visible >= 0 ? visible : 0];
}

// ── Bytes ───────────────────────────────────────────────────────────────────

/**
 * A file's bytes from the explorer's raw URL. The route answers failures as
 * JSON — some (agent offline) with a 200 — and the raw bytes as
 * octet-stream, so the content type decides which one arrived.
 */
export async function fetchFileBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if ((res.headers.get('content-type') ?? '').startsWith('application/json')) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : `could not read this file (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`could not read this file (HTTP ${res.status})`);
  return res.arrayBuffer();
}

/** Whether a rejection is just our own abort (a newer load replaced it, or the pane closed). */
export function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}
