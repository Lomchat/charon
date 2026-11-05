/**
 * The hub's scrollbar (app/globals.css), carried into documents the hub frames
 * but does not style. A live HTML view is somebody's page in an opaque-origin
 * sandbox (§14.110): no stylesheet of ours reaches it, so Chrome drew its grey
 * default there.
 *
 * Injected FIRST in <head>, so the page's own scrollbar rules come later and
 * win. Only the pseudo-elements, never the standard `scrollbar-color` for
 * Chrome: it would override a page's own ::-webkit-scrollbar. Firefox, which
 * has no pseudo-elements, gets the standard pair behind @supports.
 */

export type ScrollbarColors = { thumb: string; hover: string };

const HEX = /^#[0-9a-f]{3,8}$/i;
/** Where a document's <head> starts is decided in its first bytes. */
const SNIFF_BYTES = 64 * 1024;

export function scrollbarCss({ thumb, hover }: ScrollbarColors): string {
  // The colours come from app/themes.ts, never from a request: a literal
  // check keeps a future caller from turning this into a CSS injection.
  if (!HEX.test(thumb) || !HEX.test(hover)) throw new Error('scrollbar colours must be hex');
  return '::-webkit-scrollbar{width:8px;height:8px}'
    + '::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}'
    + `::-webkit-scrollbar-thumb{background:${thumb};border-radius:3px}`
    + `::-webkit-scrollbar-thumb:hover{background:${hover}}`
    + `@supports not selector(::-webkit-scrollbar){html{scrollbar-width:thin;scrollbar-color:${thumb} transparent}}`;
}

/** Server side (Buffer): `html` with the scrollbar style first in its <head>
 *  (else right after <html>, else after the doctype — never before it: that
 *  would drop the page into quirks mode — else at the very start, after a BOM). */
export function withScrollbar(html: Buffer, colors: ScrollbarColors): Buffer {
  const head = html.subarray(0, SNIFF_BYTES).toString('latin1'); // 1 char = 1 byte
  const match = /<head\b[^>]*>/i.exec(head) ?? /<html\b[^>]*>/i.exec(head) ?? /<!doctype\b[^>]*>/i.exec(head);
  const bom = html[0] === 0xef && html[1] === 0xbb && html[2] === 0xbf;
  const at = match ? match.index + match[0].length : bom ? 3 : 0;
  const tag = Buffer.from(`<style data-charon-scrollbar>${scrollbarCss(colors)}</style>`, 'utf8');
  return Buffer.concat([html.subarray(0, at), tag, html.subarray(at)]);
}
