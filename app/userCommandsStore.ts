// The user's own `/` commands (§14.121), shared by the composer's menu and
// Settings › commands. Fetched on the first `/`, refreshed after a minute;
// an edit in Settings replaces the list at once.
import { useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import type { UserCommand } from '@/lib/types/api';

const FRESH_MS = 60_000;
let commands: UserCommand[] | null = null;
let fetchedAt = 0;
let inflight = false;
const listeners = new Set<() => void>();

export function setUserCommands(next: UserCommand[]): void {
  commands = next;
  fetchedAt = Date.now();
  for (const l of listeners) l();
}

export function ensureUserCommands(force = false): void {
  if (inflight || (!force && commands && Date.now() - fetchedAt < FRESH_MS)) return;
  inflight = true;
  api.listUserCommands()
    .then((r) => setUserCommands(r.commands))
    .catch(() => { fetchedAt = Date.now(); })
    .finally(() => { inflight = false; });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

const EMPTY: UserCommand[] = [];
export function useUserCommands(): UserCommand[] {
  return useSyncExternalStore(subscribe, () => commands ?? EMPTY, () => EMPTY);
}
