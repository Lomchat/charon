import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, tabs, claudeSessions, shells, vps as vpsTable } from '@/lib/db';
import type { TabRow } from '@/lib/db/schema';
import type { TabDTO, TabKind } from '@/lib/types/api';

/**
 * The workspace layout: which things are open, grouped `(vps → path)`. §14.78.
 *
 * Before this existed the tab bar WAS the session list — every non-sleeping
 * session was a tab, and there was no way to close one without acting on the
 * session. Tabs are now their own objects: closing is a view operation, the
 * session keeps running and stays in the sidebar.
 *
 * Two rules carry most of the behaviour:
 *
 *  - **One temporary tab per `(vpsId, path)`.** Opening something is a preview;
 *    opening the next thing in the same folder replaces it. That is what stops
 *    browsing a tree from leaving thirty tabs behind, and it is per-folder
 *    rather than global so previewing a file in one project can't evict the
 *    session you're reading in another.
 *  - **Pinning is what a real interaction does.** Double-click pins
 *    explicitly, but so does sending a message, editing a file, or answering a
 *    permission — if you've worked in a tab, it has stopped being a preview,
 *    and making the user say so twice is the kind of friction nobody notices
 *    until it loses their place.
 *
 * `active` is a single row across the whole table (one workspace, one focus).
 * Writes go through `withActive` so it can never be two.
 */

const KINDS: TabKind[] = ['session', 'shell', 'install', 'file'];
export const isTabKind = (k: string): k is TabKind => (KINDS as string[]).includes(k);

function toDTO(r: TabRow): TabDTO {
  return {
    id: r.id, vpsId: r.vpsId, path: r.path, kind: r.kind as TabKind, ref: r.ref,
    pinned: r.pinned === 1, position: r.position, active: r.active === 1,
  };
}

export function listTabs(): TabDTO[] {
  return db.select().from(tabs)
    .orderBy(tabs.vpsId, tabs.path, tabs.position, tabs.createdAt)
    .all().map(toDTO);
}

export function getActiveTab(): TabDTO | null {
  const [r] = db.select().from(tabs).where(eq(tabs.active, 1)).limit(1).all();
  return r ? toDTO(r) : null;
}

/** Make `id` the one active tab. Single statement pair, one transaction. */
function setActive(id: string | null) {
  db.transaction((tx) => {
    tx.update(tabs).set({ active: 0 }).where(eq(tabs.active, 1)).run();
    if (id) tx.update(tabs).set({ active: 1, updatedAt: nowS() }).where(eq(tabs.id, id)).run();
  });
}

const nowS = () => Math.floor(Date.now() / 1000);

export function activateTab(id: string): TabDTO | null {
  const [r] = db.select().from(tabs).where(eq(tabs.id, id)).limit(1).all();
  if (!r) return null;
  setActive(id);
  return { ...toDTO(r), active: true };
}

export type OpenTabInput = {
  vpsId: string;
  path: string;
  kind: TabKind;
  ref: string;
  /** Open (or promote) as pinned rather than as a preview. */
  pin?: boolean;
  /** Open without stealing focus — used by reconcile-style callers. */
  noActivate?: boolean;
};

/**
 * Idempotent open. Returns the tab, made active unless told otherwise.
 *
 * Re-opening something that already has a tab NEVER evicts the group's
 * temporary tab — the temporary might be this very row, and the common case
 * (clicking back and forth between two open things) must not churn the bar.
 */
export function openTab(input: OpenTabInput): TabDTO {
  const { vpsId, path, kind, ref, pin = false, noActivate = false } = input;
  const id = db.transaction((tx) => {
    const [existing] = tx.select().from(tabs).where(and(
      eq(tabs.vpsId, vpsId), eq(tabs.path, path), eq(tabs.kind, kind), eq(tabs.ref, ref),
    )).limit(1).all();

    if (existing) {
      if (pin && existing.pinned !== 1) {
        tx.update(tabs).set({ pinned: 1, updatedAt: nowS() }).where(eq(tabs.id, existing.id)).run();
      }
      return existing.id;
    }

    // A NEW preview evicts the group's previous preview. A new pinned tab
    // leaves it alone — pinning is additive.
    if (!pin) {
      tx.delete(tabs).where(and(
        eq(tabs.vpsId, vpsId), eq(tabs.path, path), eq(tabs.pinned, 0),
      )).run();
    }
    const [{ max }] = tx.select({ max: sql<number>`coalesce(max(${tabs.position}), -1)` })
      .from(tabs).where(and(eq(tabs.vpsId, vpsId), eq(tabs.path, path))).all();
    const newId = randomUUID().replace(/-/g, '').slice(0, 16);
    tx.insert(tabs).values({
      id: newId, vpsId, path, kind, ref,
      pinned: pin ? 1 : 0, position: (max ?? -1) + 1, active: 0,
      createdAt: nowS(), updatedAt: nowS(),
    }).run();
    return newId;
  });

  if (!noActivate) setActive(id);
  const [r] = db.select().from(tabs).where(eq(tabs.id, id)).limit(1).all();
  return toDTO(r);
}

export function pinTab(id: string): TabDTO | null {
  db.update(tabs).set({ pinned: 1, updatedAt: nowS() }).where(eq(tabs.id, id)).run();
  const [r] = db.select().from(tabs).where(eq(tabs.id, id)).limit(1).all();
  return r ? toDTO(r) : null;
}

/**
 * Pin whatever tab currently points at `ref`, wherever it is.
 *
 * The hook for "a real interaction happened": the caller (sending a message,
 * saving a file) knows the entity, not the tab id, and must not have to care
 * whether a tab exists at all.
 */
export function pinTabForRef(kind: TabKind, ref: string): void {
  db.update(tabs).set({ pinned: 1, updatedAt: nowS() })
    .where(and(eq(tabs.kind, kind), eq(tabs.ref, ref), eq(tabs.pinned, 0))).run();
}

/**
 * Drop every tab pointing at a thing that no longer exists.
 *
 * The ONE direction that propagates: deleting a session removes its tab,
 * while closing a tab never touches the session. Returns whether anything
 * went, so the caller only broadcasts when it must.
 */
export function dropTabsForRef(kind: TabKind, ref: string): boolean {
  const rows = db.select().from(tabs)
    .where(and(eq(tabs.kind, kind), eq(tabs.ref, ref))).all();
  if (rows.length === 0) return false;
  let hadActive = false;
  db.transaction((tx) => {
    for (const r of rows) {
      if (r.active === 1) hadActive = true;
      tx.delete(tabs).where(eq(tabs.id, r.id)).run();
    }
  });
  if (hadActive) {
    const rest = db.select().from(tabs).orderBy(tabs.updatedAt).all().pop() ?? null;
    setActive(rest?.id ?? null);
  }
  return true;
}

/**
 * Close one tab. Returns the tab that should take focus, if this one had it.
 *
 * Focus falls to the left neighbour in the same group, then the right one,
 * then anything else that is open — an editor that lands on a blank pane after
 * a close makes you re-find your place every time.
 */
export function closeTab(id: string): { closed: boolean; nextActiveId: string | null } {
  const [r] = db.select().from(tabs).where(eq(tabs.id, id)).limit(1).all();
  if (!r) return { closed: false, nextActiveId: null };

  const wasActive = r.active === 1;
  const siblings = db.select().from(tabs)
    .where(and(eq(tabs.vpsId, r.vpsId), eq(tabs.path, r.path)))
    .orderBy(tabs.position, tabs.createdAt).all();
  const idx = siblings.findIndex((s) => s.id === id);

  db.delete(tabs).where(eq(tabs.id, id)).run();

  if (!wasActive) return { closed: true, nextActiveId: null };
  const neighbour = siblings[idx - 1] ?? siblings[idx + 1] ?? null;
  const fallback = neighbour ?? db.select().from(tabs).orderBy(tabs.updatedAt).all().pop() ?? null;
  setActive(fallback?.id ?? null);
  return { closed: true, nextActiveId: fallback?.id ?? null };
}

/** Close every tab of a group / a VPS / everything but one. Used by the UI menus. */
export function closeTabsWhere(filter: { vpsId?: string; path?: string; exceptId?: string }): number {
  const rows = db.select().from(tabs).all().filter((r) =>
    (filter.vpsId === undefined || r.vpsId === filter.vpsId)
    && (filter.path === undefined || r.path === filter.path)
    && (filter.exceptId === undefined || r.id !== filter.exceptId));
  if (rows.length === 0) return 0;
  const hadActive = rows.some((r) => r.active === 1);
  db.transaction((tx) => {
    for (const r of rows) tx.delete(tabs).where(eq(tabs.id, r.id)).run();
  });
  if (hadActive) {
    const rest = db.select().from(tabs).orderBy(tabs.updatedAt).all().pop() ?? null;
    setActive(rest?.id ?? null);
  }
  return rows.length;
}

/**
 * Drop tabs whose thing no longer exists, and make sure exactly one is active.
 *
 * Runs at boot and after any delete. Install tabs ALWAYS go: installs are
 * in-memory and do not survive a hub restart, so a persisted tab pointing at
 * one is guaranteed stale (`liveInstallIds` lets a same-process caller keep
 * the ones still running).
 */
export function reconcileTabs(liveInstallIds?: Set<string>): number {
  const rows = db.select().from(tabs).all();
  if (rows.length === 0) return 0;

  const sessionIds = new Set(db.select({ id: claudeSessions.id }).from(claudeSessions).all().map((r) => r.id));
  const shellIds = new Set(db.select({ id: shells.id }).from(shells).all().map((r) => r.id));
  const vpsIds = new Set(db.select({ id: vpsTable.id }).from(vpsTable).all().map((r) => r.id));

  const dead = rows.filter((r) => {
    if (!vpsIds.has(r.vpsId)) return true;
    if (r.kind === 'session') return !sessionIds.has(r.ref);
    if (r.kind === 'shell') return !shellIds.has(r.ref);
    if (r.kind === 'install') return !liveInstallIds?.has(r.ref);
    return false;   // files are not tracked anywhere; a stale one just fails to open
  });

  if (dead.length) {
    db.transaction((tx) => {
      for (const r of dead) tx.delete(tabs).where(eq(tabs.id, r.id)).run();
    });
  }
  // Exactly one active: repair both directions (none left after a delete,
  // or several after a crash mid-transaction).
  const left = db.select().from(tabs).all();
  const actives = left.filter((r) => r.active === 1);
  if (left.length && actives.length !== 1) setActive((actives[0] ?? left[left.length - 1]).id);
  return dead.length;
}

/**
 * First-run seed: one pinned tab per live session.
 *
 * Without it the bar would be empty the first time this ships, which reads as
 * "the update lost my sessions" even though the sidebar still has them all.
 * Only ever runs against an empty table.
 */
export function seedTabsIfEmpty(): number {
  const [{ n }] = db.select({ n: sql<number>`count(*)` }).from(tabs).all();
  if (n > 0) return 0;
  const live = db.select().from(claudeSessions).all()
    .filter((s) => s.status !== 'sleeping' && s.status !== 'killed');
  if (live.length === 0) return 0;
  for (const s of live) {
    try {
      openTab({ vpsId: s.vpsId, path: s.cwd, kind: 'session', ref: s.id, pin: true, noActivate: true });
    } catch { /* a session whose VPS vanished — skip */ }
  }
  const first = db.select().from(tabs).orderBy(tabs.updatedAt).all().pop();
  if (first) setActive(first.id);
  return live.length;
}
