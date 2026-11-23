'use client';
// What the user sent that the provider has not read yet (lib/waitingInputs.ts,
// §14.125): docked above the thinking bar, out of the conversation until
// read — then the bubble rises into the chat where the provider took it.
// "Send now" (Claude) has the CLI read one at once.
import { memo, useEffect, useRef, useState } from 'react';
import { IconSend } from './icons';

export type PendingItem = {
  /** The message id (`m<rowId>` / `u-<clientMessageId>`). */
  id: string;
  content: string;
  /** held = a compaction holds it; waiting = at the provider, unread;
   *  sending = on its way. */
  state: 'held' | 'waiting' | 'sending';
  /** A held one's last delivery failure (retried by the hub). */
  error?: string | null;
  /** Epoch ms it started waiting. */
  since?: number;
  /** Its clientMessageId when it can be read now (Claude). */
  sendNowId?: string | null;
};

const LEAVE_MS = 260;
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const NOW_KEYS = IS_MAC ? ['⌘', '⇧', '↵'] : ['Ctrl', '⇧', '↵'];

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const PendingInputs = memo(function PendingInputs({ items, turnRunning, compacting, onSendNow }: {
  items: PendingItem[];
  /** A turn runs: it is read at its next step (else: the next turn). */
  turnRunning: boolean;
  compacting: boolean;
  onSendNow: (clientMessageId: string) => Promise<void>;
}) {
  // Gone from the list = read: kept a moment to rise out.
  const [leaving, setLeaving] = useState<PendingItem[]>([]);
  const prev = useRef<PendingItem[]>(items);
  useEffect(() => {
    const now = new Set(items.map((i) => i.id));
    const gone = prev.current.filter((i) => !now.has(i.id));
    prev.current = items;
    if (!gone.length) return;
    setLeaving((l) => [...l.filter((x) => !now.has(x.id)), ...gone]);
    const t = setTimeout(() => setLeaving((l) => l.filter((x) => !gone.includes(x))), LEAVE_MS);
    return () => clearTimeout(t);
  }, [items]);

  const [, tick] = useState(0);
  const live = items.length > 0;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  const [pressed, setPressed] = useState<string | null>(null);
  useEffect(() => {
    if (pressed && !items.some((i) => i.sendNowId === pressed)) setPressed(null);
  }, [items, pressed]);

  if (!items.length && !leaving.length) return null;
  const nowMs = Date.now();
  const rows = [...items.map((i) => ({ item: i, gone: false })), ...leaving.map((i) => ({ item: i, gone: true }))];
  // One button: the CLI reads everything queued along with the one pressed.
  const nowId = items.find((i) => i.sendNowId)?.sendNowId ?? null;
  return (
    <div className="pending-inputs" aria-live="polite">
      {rows.map(({ item, gone }) => {
        const when = item.state === 'held'
          ? (item.error ? 'not sent · retrying' : 'after compaction')
          : item.state === 'sending' ? 'sending'
          : compacting ? 'after compaction'
          : turnRunning ? 'next step' : 'next turn';
        const busy = pressed != null && pressed === item.sendNowId;
        const offersNow = !gone && item.sendNowId != null && item.sendNowId === nowId;
        return (
          <div key={item.id}
            className={`pending-item is-${item.state}${item.error ? ' is-error' : ''}${gone ? ' is-leaving' : ''}${busy ? ' is-pressed' : ''}`}
            title={item.error ?? undefined}>
            <span className="pi-dot" aria-hidden />
            <span className="pi-text">{item.content}</span>
            <span className="pi-when">
              {when}
              {item.since != null && item.since > 0 && item.state === 'waiting'
                ? <span className="pi-clock">{clock(nowMs - item.since)}</span>
                : null}
            </span>
            {offersNow && (
              <button type="button" className="pi-now" disabled={busy}
                title="Stops the current step"
                onClick={() => {
                  const id = item.sendNowId!;
                  setPressed(id);
                  onSendNow(id).catch(() => {}).finally(() => {
                    // Still listed after the CLI answered: it is on its way.
                    setTimeout(() => setPressed((p) => (p === id ? null : p)), 4000);
                  });
                }}>
                <IconSend aria-hidden />
                <span className="pi-now-label">{busy ? 'sending' : 'Send now'}</span>
                <span className="pi-keys" aria-hidden>{NOW_KEYS.map((k) => <kbd key={k}>{k}</kbd>)}</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
});
