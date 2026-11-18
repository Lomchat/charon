'use client';
import { createContext, useContext, type RefObject } from 'react';
import type { AgentKind } from '@/lib/types/api';

/** A session the `@` menu offers — SessionView's own `siblings` element shape. */
export type DrawerSibling = { id: string; name: string | null; handle: string; confirmed?: boolean; status: string };

/** What the board lends the drawer. Built ONCE in Desk.tsx: every function is
 *  identity-stable (useStableCallback), the object is useMemo'd with no changing
 *  dep — the context never re-renders its readers. Packages READ it, never extend it. */
export type DrawerHost = {
  /** The order box = Charon's composer textarea (SessionView `composerRef`).
   *  Null while a gate card or the Resume CTA holds its place. `/` focuses it. */
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** Another robot. On the board ⇒ its island, selected (`visit`). Known but not on the
   *  board ⇒ its full view. Unknown yet with a `hint` (a fork just made) ⇒ either,
   *  once its summary lands (≤ 10 s). */
  goTo(id: string, hint?: { vpsId: string; cwd: string }): void;
  /** The full view (SessionModal) — Enter, empty Enter, ⏎. */
  openFull(id: string): void;
  /** Empty Tab in the order: the next robot that wants you. */
  next(back: boolean): void;
  /** Head commands (Charon's routes, Desk's existing helpers). */
  lifecycle(action: 'sleep' | 'resume' | 'stop', id: string): void;
  read(id: string): void;
  openMenu(id: string, x: number, y: number): void;
  deselect(): void;
  /** SessionView's host callbacks. */
  reauth(id: string): void;                                   // C3 sign in again
  newSessionIn(vpsId: string, cwd: string): void;             // /clear
  newRoutine(draft: { vpsId: string; cwd: string; kind: AgentKind; prompt: string }): void; // /routine
  openTools(id: string, tab?: 'git' | 'calls'): void;         // /diff, /mcp → full view, on that tab
  sessionsChanged(): void;                                    // onAfterRevert / onImportError
  killed(id: string): void;                                   // onKilled → deselect + refresh
};

/** Charon's own layers (a dialog, the model / effort popover, a picker's list,
 *  the upload veil): while one is open the keys are its own — the board and the
 *  full view both stand back. */
export const CHARON_LAYER = '.app-modal-bg, .runtime-choice-popover, .picker-popup, .ci-upload-overlay';

export const DrawerHostContext = createContext<DrawerHost | null>(null);
export function useDrawerHost(): DrawerHost {
  const host = useContext(DrawerHostContext);
  if (!host) throw new Error('useDrawerHost() outside the drawer');
  return host;
}
