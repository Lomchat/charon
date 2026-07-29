'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { SessionAttachment } from '@/lib/types/api';

// Session attachments — client state for the drag & drop / paperclip feature.
// ─────────────────────────────────────────────────────────────────────────────
// Owned by ClaudeSessionView because TWO consumers need it and they must agree:
//   - <ChatInputBar> appends a path to the message whenever an upload lands,
//     and gates the UI while one is in flight.
//   - <ToolPanel> "files" tab lists them for re-download / re-insert.
// A per-consumer copy would let the two drift (a file uploaded from the bar
// missing in the tab until a refetch), so there is exactly one list.

export type PendingUpload = {
  // Local-only key: the same file can be dropped twice and both rows must be
  // addressable while in flight.
  key: string;
  name: string;
  size: number;
  error: string | null;
};

export type SessionAttachmentsApi = {
  attachments: SessionAttachment[];
  pending: PendingUpload[];
  /**
   * Upload files sequentially, invoking `onEach` as each one lands.
   *
   * Sequential, not parallel, and deliberately so: every upload costs the hub
   * an SSH push to the VPS, and firing five at once means five concurrent
   * connections to the same box — the exact burst pattern that trips
   * MaxStartups / fail2ban (§14.30). Dropping a folder of screenshots must not
   * look like an attack.
   *
   * `onEach` fires per success so the caller can insert paths progressively;
   * a failed file leaves an error chip and does NOT abort the remaining ones.
   */
  upload: (files: File[], onEach?: (att: SessionAttachment) => void) => Promise<void>;
  remove: (id: string) => Promise<void>;
  dismissPending: (key: string) => void;
  refresh: () => void;
};

export function useSessionAttachments(sessionId: string): SessionAttachmentsApi {
  const [attachments, setAttachments] = useState<SessionAttachment[]>([]);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  // Guards a late response from a previous session clobbering the current list
  // (fast session switching: the component remounts, but an in-flight GET from
  // the old mount can still resolve).
  const aliveRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refresh = useCallback(() => {
    if (!sessionId) return;
    const mySeq = ++seqRef.current;
    api.listSessionAttachments(sessionId)
      .then((r) => {
        if (!aliveRef.current || mySeq !== seqRef.current) return;
        setAttachments(r.attachments ?? []);
      })
      .catch(() => {
        // Non-critical surface: an empty Files tab is a far better failure than
        // a red banner over the chat. The next upload or refresh self-heals.
      });
  }, [sessionId]);

  useEffect(() => { refresh(); }, [refresh]);

  const upload = useCallback(async (files: File[], onEach?: (att: SessionAttachment) => void) => {
    if (!sessionId || files.length === 0) return;
    const entries: PendingUpload[] = files.map((f, i) => ({
      key: `${Date.now()}-${i}-${f.name}`,
      name: f.name,
      size: f.size,
      error: null,
    }));
    setPending((p) => [...p, ...entries]);

    for (let i = 0; i < files.length; i++) {
      const entry = entries[i];
      try {
        const { attachment } = await api.uploadSessionAttachment(sessionId, files[i]);
        if (!aliveRef.current) return;
        setAttachments((prev) => [...prev, attachment]);
        setPending((p) => p.filter((x) => x.key !== entry.key));
        onEach?.(attachment);
      } catch (e: any) {
        if (!aliveRef.current) return;
        // Keep the chip with its message instead of dropping it: an upload that
        // silently vanishes reads as "it worked" and the user sends a prompt
        // pointing at a file that isn't there.
        const msg = String(e?.message ?? e).slice(0, 200);
        setPending((p) => p.map((x) => (x.key === entry.key ? { ...x, error: msg } : x)));
      }
    }
  }, [sessionId]);

  const remove = useCallback(async (id: string) => {
    // Optimistic: the row disappears immediately, and is restored by the
    // refresh below if the server disagreed.
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    try {
      await api.deleteSessionAttachment(sessionId, id);
    } catch {
      refresh();
    }
  }, [sessionId, refresh]);

  const dismissPending = useCallback((key: string) => {
    setPending((p) => p.filter((x) => x.key !== key));
  }, []);

  return { attachments, pending, upload, remove, dismissPending, refresh };
}

/** Human-readable size for the chips and the Files tab. */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
