'use client';
import { useSyncExternalStore } from 'react';
import { DEFAULT_THEME_ID, resolveTheme, type Theme } from './themes';

/** ── Applying a theme in the browser ────────────────────────────────────────
 *  The theme is hub-wide and SERVER-RENDERED onto <html data-theme> by
 *  layout.tsx, which is what makes it flash-free: there is no boot-time
 *  localStorage read to race the first paint, and no client is ever the source
 *  of truth. This module only handles the two things SSR cannot:
 *    · the live swap when the setting changes (preview in Settings, and the
 *      `settings_changed` SSE for every other tab and device);
 *    · the JS-coloured surfaces — xterm and CodeMirror — which subscribe via
 *      useTheme() because they take a colour OBJECT, not a class (§11).
 */

// Seeded from the DOM the server rendered, so the first read already agrees
// with the paint. `document` is absent on the server: components that call
// useTheme() are client-only, and DEFAULT_THEME_ID keeps the snapshot stable.
let current: string = typeof document !== 'undefined'
  ? resolveTheme(document.documentElement.dataset.theme).id
  : DEFAULT_THEME_ID;

const listeners = new Set<() => void>();

export function applyTheme(id: string | null | undefined): void {
  const theme = resolveTheme(id);
  if (theme.id === current) return;
  current = theme.id;
  document.documentElement.dataset.theme = theme.id;
  // The browser chrome colour is document metadata; Next rendered it once and
  // will not re-render <head> for a client-side setting change.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.themeColor);
  for (const listener of listeners) listener();
}

export function currentThemeId(): string {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The active theme, re-rendering the caller when it changes. */
export function useTheme(): Theme {
  return resolveTheme(useSyncExternalStore(subscribe, () => current, () => DEFAULT_THEME_ID));
}
