// The sidebar's off-screen attention pills (app/SidebarOffscreenPills.tsx):
// which rows count, what they are drawn as when a group hides them, and which
// side of the visible part of the list they sit on. Browser-safe, DOM-free —
// the component measures, this decides.
//
// A row counts when its card is lit by THE attention predicate
// (lib/sessionAttention.ts, the card's own `viewedHere`): orange = waiting on
// you (blocked | question), red = ended in an error nobody opened, green =
// finished, unread (sessions and shells). Only rows the list currently holds
// (paused switch, path filter, focus chips — the caller's own `sessionsOf` /
// `shellsOf`): one a filter hides cannot be scrolled to. A row inside a
// collapsed folder, server or path still counts, anchored to the outermost
// collapsed group; a click unfolds it (`reveal`).
import { attentionForRow, shellAttention, type Attention } from '@/lib/sessionAttention';
import type { SessionListItem } from '@/lib/types/api';

export type OffscreenKind = 'waiting' | 'error' | 'unread';

/** Priority order — the header's: orange, red, green. */
export const OFFSCREEN_KINDS: readonly OffscreenKind[] = ['waiting', 'error', 'unread'];

export const OFFSCREEN_WORDS: Record<OffscreenKind, string> = {
  waiting: 'waiting on you',
  error: 'ended in an error, unread',
  unread: 'finished, unread',
};

export function offscreenKind(a: Attention): OffscreenKind | null {
  if (a === 'blocked' || a === 'question') return 'waiting';
  if (a === 'error') return 'error';
  if (a === 'unread') return 'unread';
  return null;
}

/** What a target is drawn as right now: its own card, or the collapsed group
 *  hiding it. `key` is that element's data attribute value. */
export type OffscreenAnchor = { kind: 'row' | 'folder' | 'vps' | 'path'; key: string };

export type OffscreenTarget = {
  /** The session's or shell's id (its card's `data-tab-id`). */
  id: string;
  kind: OffscreenKind;
  anchor: OffscreenAnchor;
  /** The collapsed groups to unfold before its card exists (null: open). */
  reveal: { folderId: string | null; vpsId: string | null; pathKey: string | null };
};

const ANCHOR_ATTR: Record<OffscreenAnchor['kind'], string> = {
  row: 'data-tab-id', folder: 'data-folder-id', vps: 'data-vps-id', path: 'data-path-key',
};

function cssString(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

export function anchorSelector(a: OffscreenAnchor): string {
  return `[${ANCHOR_ATTR[a.kind]}="${cssString(a.key)}"]`;
}

type OffscreenShell = {
  id: string; cwd?: string | null; unreadFinish?: boolean; liveStatus?: string | null; exited?: boolean;
};

/** Every lit row the list holds, in list order. */
export function buildOffscreenTargets(o: {
  folders: readonly { id: string; collapsed: boolean; vpsIds: readonly string[] }[];
  sessionsOf: (vpsId: string) => readonly SessionListItem[];
  shellsOf: (vpsId: string) => readonly OffscreenShell[];
  collapsedVps: ReadonlySet<string>;
  collapsedPaths: ReadonlySet<string>;
  pathKey: (vpsId: string, cwd: string | null | undefined) => string;
  selectedId: string | null;
  selectedShellId: string | null;
}): OffscreenTarget[] {
  const out: OffscreenTarget[] = [];
  for (const folder of o.folders) {
    for (const vpsId of folder.vpsIds) {
      const lit: { id: string; kind: OffscreenKind; cwd: string | null | undefined }[] = [];
      for (const s of o.sessionsOf(vpsId)) {
        const kind = offscreenKind(attentionForRow(s, { viewedHere: s.id === o.selectedId }));
        if (kind) lit.push({ id: s.id, kind, cwd: s.cwd });
      }
      for (const sh of o.shellsOf(vpsId)) {
        const kind = offscreenKind(shellAttention(sh, { viewedHere: sh.id === o.selectedShellId }));
        if (kind) lit.push({ id: sh.id, kind, cwd: sh.cwd });
      }
      const vpsCollapsed = o.collapsedVps.has(vpsId);
      for (const r of lit) {
        const pathKey = o.pathKey(vpsId, r.cwd);
        const pathCollapsed = o.collapsedPaths.has(pathKey);
        const anchor: OffscreenAnchor = folder.collapsed ? { kind: 'folder', key: folder.id }
          : vpsCollapsed ? { kind: 'vps', key: vpsId }
          : pathCollapsed ? { kind: 'path', key: pathKey }
          : { kind: 'row', key: r.id };
        out.push({
          id: r.id, kind: r.kind, anchor,
          reveal: {
            folderId: folder.collapsed ? folder.id : null,
            vpsId: vpsCollapsed ? vpsId : null,
            pathKey: pathCollapsed ? pathKey : null,
          },
        });
      }
    }
  }
  return out;
}

/** A target as measured: its anchor's vertical extent (any one coordinate
 *  space, the same as the view's). */
export type PlacedTarget = { id: string; kind: OffscreenKind; top: number; bottom: number };
export type OffscreenSide = 'up' | 'down';
export type OffscreenCount = { kind: OffscreenKind; count: number };

/** The part of the list a reader actually sees: from under the pinned server
 *  head to the bottom of the scroller. */
export type OffscreenView = { top: number; bottom: number };

/** Above, below or in view — by the anchor's MIDDLE: a card half under the
 *  pinned head or the bottom edge is as good as unseen. `dist` = how far past
 *  the edge (nearest first). */
export function sideOf(p: { top: number; bottom: number }, view: OffscreenView): { side: OffscreenSide | null; dist: number } {
  const mid = (p.top + p.bottom) / 2;
  if (mid < view.top) return { side: 'up', dist: view.top - mid };
  if (mid > view.bottom) return { side: 'down', dist: mid - view.bottom };
  return { side: null, dist: 0 };
}

/** How many of each kind lie above and below, in priority order, kinds with
 *  none omitted. */
export function countOffscreen(placed: readonly PlacedTarget[], view: OffscreenView): Record<OffscreenSide, OffscreenCount[]> {
  const by: Record<OffscreenSide, Map<OffscreenKind, number>> = { up: new Map(), down: new Map() };
  for (const p of placed) {
    const { side } = sideOf(p, view);
    if (side) by[side].set(p.kind, (by[side].get(p.kind) ?? 0) + 1);
  }
  const list = (m: Map<OffscreenKind, number>) =>
    OFFSCREEN_KINDS.filter((k) => m.has(k)).map((kind) => ({ kind, count: m.get(kind)! }));
  return { up: list(by.up), down: list(by.down) };
}

/** The nearest target of `kind` past `side`'s edge: what a pill click goes to
 *  (the next click, once it is in view, goes to the one after). */
export function nearestOffscreen(
  placed: readonly PlacedTarget[], view: OffscreenView, side: OffscreenSide, kind: OffscreenKind,
): string | null {
  let best: { id: string; dist: number } | null = null;
  for (const p of placed) {
    if (p.kind !== kind) continue;
    const at = sideOf(p, view);
    if (at.side === side && (!best || at.dist < best.dist)) best = { id: p.id, dist: at.dist };
  }
  return best?.id ?? null;
}

/** Equal counts on both sides (the component re-renders only on a change). */
export function sameCounts(a: readonly OffscreenCount[], b: readonly OffscreenCount[]): boolean {
  return a.length === b.length && a.every((x, i) => x.kind === b[i].kind && x.count === b[i].count);
}

/** A collapsed server's lit rows, by kind — its head shows them (they have no
 *  card to pulse on). */
export function collapsedAttentionCounts(
  sessions: readonly SessionListItem[], shells: readonly OffscreenShell[],
  selectedId: string | null, selectedShellId: string | null,
): OffscreenCount[] {
  const m = new Map<OffscreenKind, number>();
  const add = (k: OffscreenKind | null) => { if (k) m.set(k, (m.get(k) ?? 0) + 1); };
  for (const s of sessions) add(offscreenKind(attentionForRow(s, { viewedHere: s.id === selectedId })));
  for (const sh of shells) add(offscreenKind(shellAttention(sh, { viewedHere: sh.id === selectedShellId })));
  return OFFSCREEN_KINDS.filter((k) => m.has(k)).map((kind) => ({ kind, count: m.get(kind)! }));
}
