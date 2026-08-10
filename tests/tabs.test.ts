import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── The workspace layout (lib/server/claude/tabs.ts, §14.78) ───────────────
//
// The rules that carry the feel of the thing, and would each break silently:
//   * ONE temporary tab per (vpsId, path) — that's what stops browsing a tree
//     from leaving thirty tabs behind, and it is per-folder so previewing a
//     file in one project can't evict the session you're reading in another;
//   * re-opening something already open must NOT evict the group's preview
//     (the preview might be that very tab);
//   * pinning is additive — a new pinned tab never displaces the preview;
//   * closing the active tab moves focus to a neighbour rather than to
//     nothing, and NEVER touches the underlying session;
//   * exactly one row is active, always.

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-tabs-test-')),
  'test.db',
);
vi.mock('server-only', () => ({}));

let db: any;
let S: any;
let T: typeof import('@/lib/server/claude/tabs');

const VPS = 'vps1';
const OTHER = 'vps2';
const P = '/srv/app';
const Q = '/srv/other';

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  S = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  // The migrations already create the protected 'default' folder.
  db.insert(S.vpsFolders).values({ id: 'default', name: 'default', position: 0 })
    .onConflictDoNothing().run();
  for (const id of [VPS, OTHER]) {
    db.insert(S.vps).values({
      id, name: id, ip: '10.0.0.1', sshUser: 'root', sshPort: 22,
      folderId: 'default', position: 0,
    }).run();
  }
  T = await import('@/lib/server/claude/tabs');
});

beforeEach(() => { db.delete(S.tabs).run(); });

const kinds = (list: { kind: string; ref: string }[]) => list.map((t) => `${t.kind}:${t.ref}`);
const inGroup = (vpsId = VPS, p = P) => T.listTabs().filter((t) => t.vpsId === vpsId && t.path === p);

describe('opening', () => {
  it('opens a temporary tab and focuses it', () => {
    const t = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts' });
    expect(t.pinned).toBe(false);
    expect(t.active).toBe(true);
    expect(T.getActiveTab()?.id).toBe(t.id);
  });

  it('a second preview in the same folder REPLACES the first', () => {
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts' });
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'b.ts' });
    expect(kinds(inGroup())).toEqual(['file:b.ts']);
  });

  it('but only within its own folder', () => {
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts' });
    T.openTab({ vpsId: VPS, path: Q, kind: 'file', ref: 'b.ts' });
    T.openTab({ vpsId: OTHER, path: P, kind: 'file', ref: 'c.ts' });
    expect(kinds(inGroup(VPS, P))).toEqual(['file:a.ts']);
    expect(kinds(inGroup(VPS, Q))).toEqual(['file:b.ts']);
    expect(kinds(inGroup(OTHER, P))).toEqual(['file:c.ts']);
  });

  it('a pinned tab survives the next preview', () => {
    T.openTab({ vpsId: VPS, path: P, kind: 'session', ref: 's1', pin: true });
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts' });
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'b.ts' });
    expect(kinds(inGroup())).toEqual(['session:s1', 'file:b.ts']);
  });

  it('re-opening an open tab does not evict the group preview', () => {
    // Clicking back and forth between two open things must not churn the bar.
    const pinned = T.openTab({ vpsId: VPS, path: P, kind: 'session', ref: 's1', pin: true });
    const preview = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts' });
    T.openTab({ vpsId: VPS, path: P, kind: 'session', ref: 's1' });
    expect(kinds(inGroup())).toEqual(['session:s1', 'file:a.ts']);
    expect(T.getActiveTab()?.id).toBe(pinned.id);
    expect(T.listTabs().find((t) => t.id === preview.id)?.pinned).toBe(false);
  });

  it('opening with pin promotes an existing preview in place', () => {
    const t = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts' });
    const again = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    expect(again.id).toBe(t.id);          // same tab, not a duplicate
    expect(again.pinned).toBe(true);
    expect(inGroup()).toHaveLength(1);
  });

  it('is idempotent — one tab per thing per group', () => {
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    expect(inGroup()).toHaveLength(1);
  });
});

describe('pinning', () => {
  it('pinTabForRef promotes wherever the tab lives', () => {
    T.openTab({ vpsId: VPS, path: P, kind: 'session', ref: 's1' });
    T.pinTabForRef('session', 's1');
    expect(inGroup()[0].pinned).toBe(true);
  });

  it('pinTabForRef is a no-op when nothing points at the ref', () => {
    expect(() => T.pinTabForRef('session', 'ghost')).not.toThrow();
  });
});

describe('closing', () => {
  it('moves focus to the left neighbour', () => {
    const a = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    const b = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'b.ts', pin: true });
    expect(T.getActiveTab()?.id).toBe(b.id);
    const r = T.closeTab(b.id);
    expect(r.nextActiveId).toBe(a.id);
    expect(T.getActiveTab()?.id).toBe(a.id);
  });

  it('falls to the right neighbour when there is nothing on the left', () => {
    const a = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    const b = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'b.ts', pin: true });
    T.activateTab(a.id);
    expect(T.closeTab(a.id).nextActiveId).toBe(b.id);
  });

  it('falls to another group rather than to nothing', () => {
    const other = T.openTab({ vpsId: VPS, path: Q, kind: 'file', ref: 'z.ts', pin: true });
    const here = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    expect(T.closeTab(here.id).nextActiveId).toBe(other.id);
  });

  it('closing an inactive tab leaves focus alone', () => {
    const a = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    const b = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'b.ts', pin: true });
    T.closeTab(a.id);
    expect(T.getActiveTab()?.id).toBe(b.id);
  });

  it('the last tab leaves no active tab, and does not throw', () => {
    const a = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts' });
    T.closeTab(a.id);
    expect(T.listTabs()).toEqual([]);
    expect(T.getActiveTab()).toBeNull();
  });

  it('closing a session tab does NOT delete the session', () => {
    // The whole point of the refactor: a tab is a view, not the thing.
    db.insert(S.claudeSessions).values({
      id: 's1', vpsId: VPS, cwd: P, status: 'active', permissionMode: 'auto',
    }).run();
    const t = T.openTab({ vpsId: VPS, path: P, kind: 'session', ref: 's1', pin: true });
    T.closeTab(t.id);
    expect(db.select().from(S.claudeSessions).all()).toHaveLength(1);
  });

  it('bulk close respects its filter and keeps one tab active', () => {
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    const keep = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'b.ts', pin: true });
    T.openTab({ vpsId: VPS, path: Q, kind: 'file', ref: 'c.ts', pin: true });
    expect(T.closeTabsWhere({ vpsId: VPS, path: P, exceptId: keep.id })).toBe(1);
    expect(kinds(inGroup())).toEqual(['file:b.ts']);
    expect(T.getActiveTab()).not.toBeNull();
  });
});

describe('reconcile & seed', () => {
  it('drops tabs whose session is gone, keeps the ones that exist', () => {
    db.insert(S.claudeSessions).values({
      id: 'alive', vpsId: VPS, cwd: P, status: 'active', permissionMode: 'auto',
    }).run();
    T.openTab({ vpsId: VPS, path: P, kind: 'session', ref: 'alive', pin: true });
    T.openTab({ vpsId: VPS, path: P, kind: 'session', ref: 'ghost', pin: true });
    expect(T.reconcileTabs()).toBe(1);
    expect(kinds(T.listTabs())).toEqual(['session:alive']);
    db.delete(S.claudeSessions).run();
  });

  it('always drops install tabs — installs never survive a restart', () => {
    T.openTab({ vpsId: VPS, path: '', kind: 'install', ref: 'i1', pin: true });
    expect(T.reconcileTabs()).toBe(1);
    expect(T.listTabs()).toEqual([]);
  });

  it('keeps an install tab the caller says is still running', () => {
    T.openTab({ vpsId: VPS, path: '', kind: 'install', ref: 'i1', pin: true });
    expect(T.reconcileTabs(new Set(['i1']))).toBe(0);
  });

  it('leaves file tabs alone (nothing tracks them)', () => {
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    expect(T.reconcileTabs()).toBe(0);
  });

  it('repairs a table with no active row', () => {
    const a = T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    db.update(S.tabs).set({ active: 0 }).run();
    T.reconcileTabs();
    expect(T.getActiveTab()?.id).toBe(a.id);
  });

  it('repairs a table with several active rows', () => {
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'a.ts', pin: true });
    T.openTab({ vpsId: VPS, path: P, kind: 'file', ref: 'b.ts', pin: true });
    db.update(S.tabs).set({ active: 1 }).run();
    T.reconcileTabs();
    expect(T.listTabs().filter((t) => t.active)).toHaveLength(1);
  });

  it('seeds one pinned tab per live session, once', () => {
    db.insert(S.claudeSessions).values([
      { id: 'a', vpsId: VPS, cwd: P, status: 'active', permissionMode: 'auto' },
      { id: 'b', vpsId: VPS, cwd: Q, status: 'thinking', permissionMode: 'auto' },
      { id: 'c', vpsId: VPS, cwd: P, status: 'sleeping', permissionMode: 'auto' },
    ]).run();
    expect(T.seedTabsIfEmpty()).toBe(2);          // the sleeping one is not seeded
    expect(T.listTabs().every((t) => t.pinned)).toBe(true);
    expect(T.getActiveTab()).not.toBeNull();
    expect(T.seedTabsIfEmpty()).toBe(0);          // never runs against a non-empty table
    db.delete(S.claudeSessions).run();
  });
});
