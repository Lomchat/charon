'use client';
import { useCallback, useRef, useState } from 'react';

// In-memory store of "drafts" for the input area (textarea for messages to
// Claude), indexed by session id.
//
// Persistence is deliberately ephemeral:
//   - Module-level Map → survives component re-mounts triggered by
//     `<ClaudeSessionView key={selectedId}>` (desktop session switch) and
//     route changes /m/select ↔ /m/chat?id=... on mobile.
//   - No localStorage / sessionStorage → an F5 wipes everything. This is the
//     expected behavior (per user request): we keep the draft while
//     navigating between sessions, no more.
//
// Consumed by `app/ClaudeSessionView.tsx` (desktop) and
// `app/m/chat/MobileChat.tsx` (mobile) via the `useInputDraft` hook.

const drafts = new Map<string, string>();

export function getDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? '';
}

export function setDraft(sessionId: string, value: string): void {
  // Emptying the string ⇒ removes the entry (avoids the Map growing
  // indefinitely when the user sends their message or clears everything).
  if (value) drafts.set(sessionId, value);
  else drafts.delete(sessionId);
}

export function clearDraft(sessionId: string): void {
  drafts.delete(sessionId);
}

/**
 * React hook that exposes `[input, setInput]` like a regular `useState`,
 * but wired to the shared store.
 *
 * - Lazy initialization from the store → no flash of empty input on mount.
 * - In-render reconciliation when `sessionId` changes on the same component
 *   (mobile case: `/m/chat?id=A` → `/m/chat?id=B` doesn't remount the page,
 *    so we must resync via a ref vs prop comparison, the "derived state from
 *    props" pattern without useEffect — no flash, no loop).
 * - Each mutation writes to the store, which makes usage transparent:
 *   call-sites do `setInput(value)` as before.
 */
export function useInputDraft(sessionId: string): [string, (v: string) => void] {
  const [input, setInputState] = useState<string>(() => getDraft(sessionId));
  const lastSidRef = useRef(sessionId);
  if (lastSidRef.current !== sessionId) {
    lastSidRef.current = sessionId;
    setInputState(getDraft(sessionId));
  }
  const setInput = useCallback(
    (v: string) => {
      setInputState(v);
      setDraft(sessionId, v);
    },
    [sessionId],
  );
  return [input, setInput];
}
