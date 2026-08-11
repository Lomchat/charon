import { describe, it, expect } from 'vitest';
import { PATH_DRAG_MIME, setPathDrag, isPathDrag, readPathDrag } from '@/app/pathDrag';

/**
 * Dragging a path out of the explorer into the chat (§14.81).
 *
 * Three different HTML5 drags travel through the SAME `window` dragover/drop
 * listeners in `ChatInputBar`, and the only thing telling them apart is the
 * data type they carry. Get that wrong in either direction and something
 * user-visible breaks quietly:
 *
 *   • a tab / sidebar REORDER read as a path drag → dragging a tab to reorder
 *     it blacks the screen out with the chat's drop overlay
 *   • a path drag not recognised → no preventDefault, so the drop never fires
 *     and the browser navigates the tab to the dropped text instead
 *
 * `useReorder` puts the row id in 'text/plain' (§14.80) and this module also
 * sets 'text/plain' as a courtesy payload — so 'text/plain' can NEVER be the
 * discriminator. That is the property under test.
 */

/** Minimal stand-in: only `types`, `getData`, `setData`, `effectAllowed`. */
function fakeDataTransfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    effectAllowed: 'uninitialized' as string,
    get types() { return Array.from(data.keys()); },
    setData(type: string, value: string) { data.set(type, value); },
    getData(type: string) { return data.get(type) ?? ''; },
  } as unknown as DataTransfer;
}

describe('pathDrag', () => {
  it('round-trips an absolute path', () => {
    const dt = fakeDataTransfer();
    setPathDrag(dt, '/srv/charon/app/TreeTab.tsx');
    expect(isPathDrag(dt)).toBe(true);
    expect(readPathDrag(dt)).toBe('/srv/charon/app/TreeTab.tsx');
  });

  it('sets effectAllowed to copy — a mismatch with the drop side kills the drop', () => {
    const dt = fakeDataTransfer();
    setPathDrag(dt, '/tmp/x');
    expect(dt.effectAllowed).toBe('copy');
  });

  it('also exposes text/plain, for drops OUTSIDE the app', () => {
    const dt = fakeDataTransfer();
    setPathDrag(dt, '/tmp/x');
    expect(dt.getData('text/plain')).toBe('/tmp/x');
  });

  // ── The discrimination, both directions ──────────────────────────────────
  it('does NOT match a tab/sidebar reorder, which carries text/plain alone', () => {
    // Exactly what useReorder.itemProps.onDragStart puts in the payload.
    const reorder = fakeDataTransfer({ 'text/plain': 'tab_01H8XYZ' });
    expect(isPathDrag(reorder)).toBe(false);
    expect(readPathDrag(reorder)).toBeNull();
  });

  it('does NOT match an OS file drag', () => {
    expect(isPathDrag(fakeDataTransfer({ Files: '' }))).toBe(false);
  });

  it('is null-safe — a drag can reach a handler with no dataTransfer', () => {
    expect(isPathDrag(null)).toBe(false);
    expect(readPathDrag(null)).toBeNull();
  });

  it('reads as absent when the type is present but empty', () => {
    // dragenter/dragover run in "protected mode": `types` is readable but
    // getData() returns ''. The drop handler must treat that as nothing to
    // insert rather than splicing an empty string at the caret.
    const dt = fakeDataTransfer({ [PATH_DRAG_MIME]: '' });
    expect(readPathDrag(dt)).toBeNull();
  });
});
