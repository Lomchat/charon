'use client';

type Subscriber = (vpsId: string, paths: string[]) => void;
const g = globalThis as unknown as { __charonFsChangeSubs?: Set<Subscriber> };
const subscribers = (g.__charonFsChangeSubs ??= new Set());

export function publishFsChanged(vpsId: string, paths: unknown): void {
  if (!vpsId) return;
  if (!Array.isArray(paths)) return;
  const clean = paths.filter((p): p is string => typeof p === 'string' && p.startsWith('/'));
  if (!clean.length) return;
  for (const subscriber of subscribers) subscriber(vpsId, clean);
}

export function subscribeFsChanged(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  return () => { subscribers.delete(subscriber); };
}
