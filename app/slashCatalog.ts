// The provider's part of the composer's `/` menu (lib/slashCommands.ts),
// fetched on the first `/` from the session inventory (`GET .../resources`).
// A sleeping session cannot list its commands: the LAST KNOWN list for its
// provider + VPS + folder stands in (memory, then localStorage), never a wake.
import { useCallback, useRef, useState } from 'react';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import { diskSkills, hasNativeSlashItems, nativeSlashItems, type SlashItem } from '@/lib/slashCommands';

const STORE_KEY = 'charon.slashCatalog.v1';
const MAX_KEYS = 24;
/** A list older than this is refetched (in the background, the old one shown). */
const FRESH_MS = 5 * 60_000;
const RETRY_MS = 30_000;

type Entry = { items: SlashItem[]; at: number };

const mem = new Map<string, Entry>();
let loadedStore = false;

function loadStore(): void {
  if (loadedStore) return;
  loadedStore = true;
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, Entry>;
    for (const [k, v] of Object.entries(raw)) {
      if (v && Array.isArray(v.items) && typeof v.at === 'number' && !mem.has(k)) mem.set(k, v);
    }
  } catch { /* unreadable: start empty */ }
}

function remember(key: string, items: SlashItem[]): void {
  mem.delete(key);
  mem.set(key, { items, at: Date.now() });
  while (mem.size > MAX_KEYS) mem.delete(mem.keys().next().value!);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(mem))); } catch { /* full: memory only */ }
}

/** `key` = provider|vps|folder: what a command list depends on. */
export function useSlashCatalog(sessionId: string, provider: SessionProvider, key: string): {
  native: SlashItem[] | null; loading: boolean; ensure: () => void;
} {
  const [native, setNative] = useState<SlashItem[] | null>(() => {
    loadStore();
    return mem.get(key)?.items ?? null;
  });
  const [loading, setLoading] = useState(false);
  const inflight = useRef(false);
  const fetchedAt = useRef(0);

  const ensure = useCallback(() => {
    loadStore();
    const known = mem.get(key);
    if (known && native == null) setNative(known.items);
    if (inflight.current || Date.now() - fetchedAt.current < FRESH_MS) return;
    if (!hasNativeSlashItems(provider)) { fetchedAt.current = Date.now(); setNative([]); return; }
    inflight.current = true;
    setLoading(!known);
    void (async () => {
      let next: SlashItem[] | null = null;
      let live: SlashItem[] | null = null;
      try {
        const r = await fetch(`/api/sessions/${sessionId}/resources`, { credentials: 'same-origin' });
        const body: unknown = r.ok ? await r.json() : null;
        live = body ? nativeSlashItems(provider, body) : null;
        if (live) { remember(key, live); next = live; }
        else next = mem.get(key)?.items ?? (body ? diskSkills(body) : null);
      } catch {
        next = mem.get(key)?.items ?? null;
      } finally {
        inflight.current = false;
        // No live list (asleep, an error): ask again soon — it may wake.
        fetchedAt.current = live ? Date.now() : Date.now() - FRESH_MS + RETRY_MS;
        setLoading(false);
      }
      setNative(next ?? []);
    })();
  }, [key, native, provider, sessionId]);

  return { native, loading, ensure };
}
