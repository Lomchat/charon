'use client';
import { useSyncExternalStore } from 'react';

// Which account's banked resets the resets modal shows (§14.126). Any
// surface opens it (the usage popover, the reset calendar); ONE host draws it
// (`ResetsModalHost`), outside every popover: a popover closes on a press
// outside itself, which would unmount a modal it owned.

let target: string | null = null;
const listeners = new Set<() => void>();

function publish(next: string | null): void {
  if (next === target) return;
  target = next;
  for (const l of listeners) l();
}

export function openAccountResets(accountId: string): void { publish(accountId); }
export function closeAccountResets(): void { publish(null); }

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAccountResetsTarget(): string | null {
  return useSyncExternalStore(subscribe, () => target, () => null);
}
