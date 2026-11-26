'use client';
import { useSyncExternalStore } from 'react';

/**
 * The desktop chrome's two folds, browser-local like every layout choice (a
 * phone and a desktop do not share them, §14.78):
 *
 * - how many of the tab bar's upper rows are hidden: 0 = the three rows,
 *   1 = no machine row, 2 = neither machines nor folders. The tab row itself
 *   never hides; what is hidden becomes the trail at its head (TabBar).
 * - whether the session header is reduced to one line (SessionView).
 *
 * The hub renders client-side only (`createRoot`), so the stored value is read
 * synchronously on the first snapshot: no frame of the unfolded chrome first.
 */

export type HiddenTabRows = 0 | 1 | 2;

const TAB_ROWS_KEY = 'hub.tabs.hiddenRows.v1';
const HEADER_KEY = 'hub.sessionHeader.reduced.v1';

type Folds = { tabRows: HiddenTabRows; header: boolean };
const g = globalThis as unknown as {
  __charonChromeFolds?: Folds;
  __charonChromeFoldsSubs?: Set<() => void>;
  __charonChromeFoldsSync?: boolean;
};
g.__charonChromeFoldsSubs ??= new Set<() => void>();

function readStored(): Folds {
  let rows: string | null = null;
  let header: string | null = null;
  try {
    rows = localStorage.getItem(TAB_ROWS_KEY);
    header = localStorage.getItem(HEADER_KEY);
  } catch {}
  const n = Number(rows);
  return { tabRows: n === 1 || n === 2 ? n : 0, header: header === '1' };
}

function folds(): Folds {
  return (g.__charonChromeFolds ??= readStored());
}

function notify(): void {
  for (const fn of g.__charonChromeFoldsSubs!) fn();
}

function subscribe(fn: () => void): () => void {
  g.__charonChromeFoldsSubs!.add(fn);
  // Another tab of this browser folded something: follow it.
  if (!g.__charonChromeFoldsSync && typeof window !== 'undefined') {
    g.__charonChromeFoldsSync = true;
    window.addEventListener('storage', (e) => {
      if (e.key !== TAB_ROWS_KEY && e.key !== HEADER_KEY) return;
      g.__charonChromeFolds = readStored();
      notify();
    });
  }
  return () => { g.__charonChromeFoldsSubs!.delete(fn); };
}

const tabRowsSnapshot = () => folds().tabRows;
const headerSnapshot = () => folds().header;

export function useHiddenTabRows(): HiddenTabRows {
  return useSyncExternalStore(subscribe, tabRowsSnapshot, () => 0 as HiddenTabRows);
}

export function useHeaderReduced(): boolean {
  return useSyncExternalStore(subscribe, headerSnapshot, () => false);
}

export function setHiddenTabRows(next: HiddenTabRows): void {
  if (folds().tabRows === next) return;
  g.__charonChromeFolds = { ...folds(), tabRows: next };
  try { localStorage.setItem(TAB_ROWS_KEY, String(next)); } catch {}
  notify();
}

export function setHeaderReduced(next: boolean): void {
  if (folds().header === next) return;
  g.__charonChromeFolds = { ...folds(), header: next };
  try { localStorage.setItem(HEADER_KEY, next ? '1' : '0'); } catch {}
  notify();
}
