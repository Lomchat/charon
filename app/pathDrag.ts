/**
 * Dragging a VPS path out of the explorer and into the chat.
 *
 * The payload is deliberately NOT a file: the thing being dragged already
 * lives on the VPS, so there is nothing to upload — the drop just splices its
 * absolute path into the message, which is how you tell an agent "read this
 * folder". Same landing spot as an attachment (`insertAtCaret`), none of the
 * transfer (§14.73).
 *
 * The custom MIME is what keeps the three HTML5 drags in this app apart. They
 * all travel through the same `window` events:
 *
 *   • an OS file drag      → `types` has 'Files'          → upload + insert
 *   • a tab/sidebar reorder→ `types` has ONLY 'text/plain'→ ignored by the chat
 *     (`useReorder` puts the row id there, §14.80)
 *   • this one             → `types` has PATH_DRAG_MIME   → insert, no upload
 *
 * so gating on the custom type is what stops a tab reorder from opening the
 * chat's drop overlay. `text/plain` is set too, but only as a courtesy for
 * drops OUTSIDE the app (a terminal, an editor) — never as the discriminator.
 */
export const PATH_DRAG_MIME = 'application/x-charon-path';

/** Producer side, called from `dragstart`. `absPath` is `<cwd>/<relative>`. */
export function setPathDrag(dt: DataTransfer, absPath: string): void {
  // 'copy' on BOTH ends or the drop is silently refused in some browsers —
  // `useReorder` uses 'move', and a mismatched effectAllowed/dropEffect pair
  // is one of the ways an HTML5 drop just never fires.
  dt.effectAllowed = 'copy';
  try {
    dt.setData(PATH_DRAG_MIME, absPath);
    dt.setData('text/plain', absPath);
  } catch { /* Safari can throw on a locked dataTransfer; the drag still runs */ }
}

/**
 * Consumer side. Usable during dragenter/dragover, where the data itself is in
 * "protected mode" and `getData()` returns '' — only `types` can be read.
 */
export function isPathDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.prototype.indexOf.call(dt.types, PATH_DRAG_MIME) !== -1;
}

/** Consumer side, `drop` only — this is where the payload becomes readable. */
export function readPathDrag(dt: DataTransfer | null): string | null {
  if (!dt) return null;
  const v = dt.getData(PATH_DRAG_MIME);
  return v ? v : null;
}
