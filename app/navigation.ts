'use client';
import { useMemo, useSyncExternalStore } from 'react';

// The URL as React state, the way Next's app router exposed it: the query
// string follows pushState/replaceState (Charon's own included — HubPanel
// writes `?session=`/`?shell=` itself, §14.78) and back/forward. One
// notification per tick, after the history call, like Next's.

const listeners = new Set<() => void>();
let patched = false;
let queued = false;

function notify(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    for (const l of listeners) l();
  });
}

function ensurePatched(): void {
  if (patched || typeof window === 'undefined') return;
  patched = true;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      notify();
    };
  }
  window.addEventListener('popstate', notify);
}

function subscribe(listener: () => void): () => void {
  ensurePatched();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const currentSearch = () => window.location.search;

/** The current query string; a new object only when it changes. */
export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, currentSearch, () => '');
  return useMemo(() => new URLSearchParams(search), [search]);
}

/** In-page navigation within the current page; another page is a real load. */
export function useRouter(): { push(url: string): void; replace(url: string): void } {
  return useMemo(() => {
    const go = (url: string, method: 'pushState' | 'replaceState') => {
      ensurePatched();
      const target = new URL(url, window.location.href);
      if (target.origin !== window.location.origin || target.pathname !== window.location.pathname) {
        window.location.assign(target.toString());
        return;
      }
      window.history[method](null, '', target.toString());
    };
    return { push: (url) => go(url, 'pushState'), replace: (url) => go(url, 'replaceState') };
  }, []);
}
