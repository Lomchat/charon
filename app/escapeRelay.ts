// Keys pressed inside an <iframe> never reach the hub's document. A framed
// document hands its Esc back — DocFrame listens on its same-origin document,
// a live HTML page posts LIVE_PREVIEW_ESCAPE (lib/livePreview.ts) — and it is
// re-dispatched on the <iframe> element: it bubbles through the hub like a key
// pressed there, so the full-screen file pane (FileEditor) closes on it.
export function relayEscape(frame: HTMLElement): void {
  frame.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
  }));
}
