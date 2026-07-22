import { describe, it, expect, vi, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Chronological pagination across pages (Codex 18.1) ──────────────────────
// The exact scenario from the counter-review: a session larger than the page
// limit, one LOW-seq row missing, then repaired with the HIGHEST id. The
// initial window must NOT contain it (id-based selection would); the older
// page must contain it exactly once, at its true chronological position;
// pages must tile with no duplicate and no displaced row.

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-window-test-')),
  'test.db',
);

vi.mock('server-only', () => ({}));

const VPS_ID = 'testvps0';
const SID = 'b'.repeat(32);

let db: any;
let schema: any;
let loadMessageWindow: any;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  db.insert(schema.claudeSessions).values({ id: SID, vpsId: VPS_ID, cwd: '/tmp', status: 'active' }).onConflictDoNothing().run();

  // 259 live rows: seqs 1..260 EXCEPT 20 (its persist "failed"). A user row
  // (seq NULL) sits after seq 100 to pin the anchoring rule. Then the REPAIR
  // of seq 20 arrives last → highest id.
  for (let s = 1; s <= 260; s++) {
    if (s === 20) continue;
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'assistant', content: `msg-${s}`, seq: s,
    }).run();
    if (s === 100) {
      db.insert(schema.claudeSessionMessages).values({
        sessionId: SID, role: 'user', content: 'user-after-100', seq: null,
      }).run();
    }
    // one attachment riding right after seq 150 (must follow its page)
    if (s === 150) {
      db.insert(schema.claudeSessionMessages).values({
        sessionId: SID, role: 'event', content: '{"type":"todo_update","todos":[]}', seq: null,
      }).run();
    }
  }
  db.insert(schema.claudeSessionMessages).values({
    sessionId: SID, role: 'assistant', content: 'msg-20-REPAIRED', seq: 20,
  }).run();

  ({ loadMessageWindow } = await import('@/lib/server/claude/messageWindow'));
});

describe('chronological pagination with a repaired row (Codex 18)', () => {
  it('the initial window selects by chronology — the repaired row is NOT in the newest page', () => {
    const page1 = loadMessageWindow(SID, 200, null);
    expect(page1.hasMore).toBe(true);
    const contents = page1.messages.map((m: any) => m.content);
    expect(contents).not.toContain('msg-20-REPAIRED'); // id-selection would have included it
    // newest 200 chat rows = seqs 61..260 (user row + event ride along as non-chat/anchored)
    expect(contents[contents.length - 1]).toBe('msg-260');
    // the attachment stays right after its chat neighbor
    const i150 = contents.indexOf('msg-150');
    expect(page1.messages[i150 + 1].role).toBe('event');
  });

  it('the before-page contains the repaired row exactly once, at its true position', () => {
    const page1 = loadMessageWindow(SID, 200, null);
    const page2 = loadMessageWindow(SID, 200, page1.oldestChatId);
    const contents = page2.messages.map((m: any) => m.content);
    expect(contents).toContain('msg-20-REPAIRED');
    const i = contents.indexOf('msg-20-REPAIRED');
    expect(contents[i - 1]).toBe('msg-19'); // true chronological neighbors
    expect(contents[i + 1]).toBe('msg-21');
    expect(page2.hasMore).toBe(false);
  });

  it('pages tile exactly: no duplicate, no lost row, full order = 1..260 + anchored extras', () => {
    const page1 = loadMessageWindow(SID, 200, null);
    const page2 = loadMessageWindow(SID, 200, page1.oldestChatId);
    // Client-side merge is a plain prepend (sessionCache.extendWithOlder) —
    // valid because pages are consecutive slices of one global order.
    const all = [...page2.messages, ...page1.messages];
    const ids = all.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    const chat = all.filter((m: any) => m.role === 'assistant');
    expect(chat).toHaveLength(260); // nothing lost
    const seqs = chat.map((m: any) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b)); // global order
    // user row anchored right after msg-100
    const contents = all.map((m: any) => m.content);
    expect(contents[contents.indexOf('msg-100') + 1]).toBe('user-after-100');
  });

  it('attachments PARTITION across pages: boundary/leading/trailing all owned exactly once (Codex 20)', () => {
    const BSID = 'd'.repeat(32);
    db.insert(schema.claudeSessions).values({ id: BSID, vpsId: VPS_ID, cwd: '/tmp', status: 'sleeping' }).onConflictDoNothing().run();
    const addChat = (s: number) => db.insert(schema.claudeSessionMessages).values({
      sessionId: BSID, role: 'assistant', content: `c-${s}`, seq: s,
    }).run();
    const addEvent = (label: string) => db.insert(schema.claudeSessionMessages).values({
      sessionId: BSID, role: 'event', content: `{"type":"todo_update","label":"${label}"}`, seq: null,
    }).run();
    // Layout (insertion = chronological): E-lead, c1..5, E-after-5, c6..15,
    // E-after-15, c16..25, E-trail. With limit=10 the page boundaries fall
    // EXACTLY after c5 and c15 — E-after-5 and E-after-15 sit on the cuts
    // (the case the closed-bounds slicing dropped entirely).
    addEvent('lead');
    for (let s = 1; s <= 5; s++) addChat(s);
    addEvent('after-5');
    for (let s = 6; s <= 15; s++) addChat(s);
    addEvent('after-15');
    for (let s = 16; s <= 25; s++) addChat(s);
    addEvent('trail');

    const p1 = loadMessageWindow(BSID, 10, null);               // newest: c16..25
    const p2 = loadMessageWindow(BSID, 10, p1.oldestChatId);    // c6..15
    const p3 = loadMessageWindow(BSID, 10, p2.oldestChatId);    // oldest: c1..5
    expect(p3.hasMore).toBe(false);

    const label = (m: any) => m.role === 'event' ? JSON.parse(m.content).label : m.content;
    // Boundary attachment belongs to the page whose LAST chat precedes it…
    expect(p2.messages.map(label)).toContain('after-15');
    expect(p1.messages.map(label)).not.toContain('after-15');
    expect(p3.messages.map(label)).toContain('after-5');
    expect(p2.messages.map(label)).not.toContain('after-5');
    // …the oldest page owns the leading attachment, the newest the trailing.
    expect(p3.messages.map(label)).toContain('lead');
    expect(p1.messages.map(label)).toContain('trail');

    // Full-history concatenation: every id exactly once, in global order.
    const all = [...p3.messages, ...p2.messages, ...p1.messages];
    expect(all).toHaveLength(29); // 25 chat + 4 events
    const ids = all.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(29);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => a - b)); // insertion was chronological here
    expect(all.map(label)).toEqual([
      'lead', 'c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'after-5',
      'c-6', 'c-7', 'c-8', 'c-9', 'c-10', 'c-11', 'c-12', 'c-13', 'c-14', 'c-15', 'after-15',
      'c-16', 'c-17', 'c-18', 'c-19', 'c-20', 'c-21', 'c-22', 'c-23', 'c-24', 'c-25', 'trail',
    ]);
  });

  it('side-channel-only session: attachments are still served, bounded (Codex 22.1)', () => {
    const ESID = 'e'.repeat(32);
    db.insert(schema.claudeSessions).values({ id: ESID, vpsId: VPS_ID, cwd: '/tmp', status: 'sleeping' }).onConflictDoNothing().run();
    for (let i = 1; i <= 15; i++) {
      db.insert(schema.claudeSessionMessages).values({
        sessionId: ESID, role: 'event', content: `{"type":"replay_gap","n":${i}}`, seq: null,
      }).run();
    }
    const win = loadMessageWindow(ESID, 10, null);
    expect(win.messages).toHaveLength(10); // bounded to limit, not dumped whole
    expect(win.messages.every((m: any) => m.role === 'event')).toBe(true);
    // newest tail (6..15), chronological order preserved
    expect(JSON.parse(win.messages[0].content).n).toBe(6);
    expect(JSON.parse(win.messages[9].content).n).toBe(15);
    expect(win.hasMore).toBe(true);
    expect(win.oldestChatId).toBeNull(); // no chat cursor to hand out
    // and a truly empty session still returns empty
    const NSID = 'f'.repeat(32);
    db.insert(schema.claudeSessions).values({ id: NSID, vpsId: VPS_ID, cwd: '/tmp', status: 'sleeping' }).onConflictDoNothing().run();
    const empty = loadMessageWindow(NSID, 10, null);
    expect(empty.messages).toHaveLength(0);
    expect(empty.hasMore).toBe(false);
  });

  it('pagination still exact on a fully-legacy session (all seq NULL → id order)', () => {
    const LEGACY = 'c'.repeat(32);
    db.insert(schema.claudeSessions).values({ id: LEGACY, vpsId: VPS_ID, cwd: '/tmp', status: 'sleeping' }).onConflictDoNothing().run();
    for (let i = 1; i <= 25; i++) {
      db.insert(schema.claudeSessionMessages).values({
        sessionId: LEGACY, role: 'assistant', content: `legacy-${i}`, seq: null,
      }).run();
    }
    const p1 = loadMessageWindow(LEGACY, 10, null);
    expect(p1.messages.map((m: any) => m.content)).toEqual(
      Array.from({ length: 10 }, (_, k) => `legacy-${16 + k}`));
    const p2 = loadMessageWindow(LEGACY, 10, p1.oldestChatId);
    expect(p2.messages.map((m: any) => m.content)).toEqual(
      Array.from({ length: 10 }, (_, k) => `legacy-${6 + k}`));
    expect(p2.hasMore).toBe(true);
  });
});
