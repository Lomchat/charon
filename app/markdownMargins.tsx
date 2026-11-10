'use client';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * The Markdown View's "Margins" switch, one value for every pane, full screen
 * and `/view` tab: ON = a readable column, centred; OFF = the full width.
 *
 * Browser-local like `treeHideIgnored.ts`: a way of LOOKING at a document. The
 * first render shows margins (the server has no localStorage and must render
 * the same markup); a stored OFF is adopted after mount.
 */

export const MARKDOWN_MARGINS_KEY = 'hub.markdown.margins.v1';

const g = globalThis as unknown as {
  __charonMdMargins?: boolean;
  __charonMdMarginsSubs?: Set<() => void>;
  __charonMdMarginsRead?: boolean;
};
g.__charonMdMarginsSubs ??= new Set<() => void>();

function notify(): void {
  for (const fn of g.__charonMdMarginsSubs!) fn();
}

function getSnapshot(): boolean {
  return g.__charonMdMargins ?? true;
}

function subscribe(fn: () => void): () => void {
  g.__charonMdMarginsSubs!.add(fn);
  return () => { g.__charonMdMarginsSubs!.delete(fn); };
}

function write(next: boolean): void {
  if (getSnapshot() === next) return;
  g.__charonMdMargins = next;
  try { localStorage.setItem(MARKDOWN_MARGINS_KEY, next ? '1' : '0'); } catch {}
  notify();
}

/** Adopt the stored choice, once per tab and never during render. */
function hydrate(): void {
  if (g.__charonMdMarginsRead) return;
  g.__charonMdMarginsRead = true;
  try {
    if (localStorage.getItem(MARKDOWN_MARGINS_KEY) === '0') {
      g.__charonMdMargins = false;
      notify();
    }
  } catch {}
}

/** `[margins, toggle]`. */
export function useMarkdownMargins(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, () => true);
  useEffect(() => { hydrate(); }, []);
  return [value, useCallback(() => { write(!getSnapshot()); }, [])];
}

/** The header's switch (pane and `/view`), styled like the View/Code toggle. */
export function MarkdownMarginsToggle() {
  const [margins, toggle] = useMarkdownMargins();
  return (
    <span className="fe-view-toggle" role="group" aria-label="Document width">
      <button type="button" className={margins ? 'on' : ''} aria-pressed={margins} onClick={toggle}
              title={margins ? 'Margins on: a readable column — click for the full width'
                : 'Full width — click for margins'}>
        Margins
      </button>
    </span>
  );
}
