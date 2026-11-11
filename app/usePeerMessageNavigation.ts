'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Msg } from './sessionTypes';
import { unfoldBubbleAt } from './bubbleFold';

export function findPeerMessage(root: HTMLElement, messageId: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-peer-message-id]'))
    .find((element) => element.dataset.peerMessageId === messageId) ?? null;
}

/** Scope highlights to the current transcript, and paginate only on a click. */
export function usePeerMessageNavigation(
  root: RefObject<HTMLDivElement | null>,
  { messages, hasMore, isLoadingMore, historyReady, loadMoreHistory, setHistoryHold }: {
    messages: Msg[]; hasMore: boolean; isLoadingMore: boolean; historyReady: boolean;
    loadMoreHistory: () => Promise<void>; setHistoryHold: (hold: boolean) => void;
  },
  { targetAttribute = 'data-peer-message-id', flashClass = 'peer-request-flash', focus = false }: {
    targetAttribute?: string; flashClass?: string; focus?: boolean;
  } = {},
) {
  const findTarget = useCallback((container: HTMLElement, id: string) =>
    Array.from(container.querySelectorAll<HTMLElement>(`[${targetAttribute}]`))
      .find((element) => element.getAttribute(targetAttribute) === id) ?? null, [targetAttribute]);
  const [pending, setPending] = useState<{ id: string } | null>(null);
  const [isJumping, setIsJumping] = useState(false);
  const attemptedWindow = useRef<string | null>(null);
  const hovered = useRef<HTMLElement | null>(null);
  const animation = useRef<number | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashed = useRef<HTMLElement | null>(null);

  const clearHover = useCallback(() => {
    hovered.current?.classList.remove('peer-request-hover');
    hovered.current = null;
  }, []);
  const hoverRequest = useCallback((id: string | null) => {
    clearHover();
    const target = id && root.current ? findPeerMessage(root.current, id) : null;
    if (target) {
      target.classList.add('peer-request-hover');
      hovered.current = target;
    }
  }, [root, clearHover]);

  const clearJump = useCallback(() => {
    if (animation.current != null) cancelAnimationFrame(animation.current);
    animation.current = null;
    if (flashTimer.current != null) clearTimeout(flashTimer.current);
    flashTimer.current = null;
    flashed.current?.classList.remove(flashClass);
    flashed.current = null;
    setIsJumping(false);
  }, [flashClass]);
  const jumpToRequest = useCallback((id: string) => {
    clearHover();
    clearJump();
    setIsJumping(true);
    // Keep paginated history while the selected request is being revealed.
    setHistoryHold(true);
    attemptedWindow.current = null;
    setPending({ id });
  }, [setHistoryHold, clearHover, clearJump]);

  useEffect(() => {
    if (!pending || !historyReady || !root.current) return;
    const container = root.current;
    const target = findTarget(container, pending.id);
    if (!target) {
      if (isLoadingMore) return;
      const windowId = messages[0]?.id ?? '';
      // A failed/empty page must not turn a click into an infinite fetch loop.
      if (!hasMore || attemptedWindow.current === windowId) {
        setPending(null);
        setIsJumping(false);
        return;
      }
      attemptedWindow.current = windowId;
      void loadMoreHistory();
      return;
    }
    setPending(null);
    // A folded target opens first; it re-renders before the first frame, where
    // the scroll is measured.
    unfoldBubbleAt(target);
    let start = 0;
    let delta = 0;
    let began = -1;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const step = (now: number) => {
      if (began < 0) {
        began = now;
        start = container.scrollTop;
        delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
      }
      const progress = reduced ? 1 : Math.min(1, (now - began) / 350);
      container.scrollTop = start + delta * (1 - (1 - progress) ** 3);
      if (progress < 1) {
        animation.current = requestAnimationFrame(step);
      } else {
        animation.current = null;
        if (focus) target.focus({ preventScroll: true });
        target.classList.add(flashClass);
        flashed.current = target;
        flashTimer.current = setTimeout(clearJump, 1400);
      }
    };
    animation.current = requestAnimationFrame(step);
  }, [pending, messages, hasMore, isLoadingMore, historyReady, loadMoreHistory, root, clearJump, findTarget, flashClass, focus]);

  useEffect(() => () => { clearHover(); clearJump(); }, [clearHover, clearJump]);
  return { hoverRequest, jumpToRequest, isJumping };
}
