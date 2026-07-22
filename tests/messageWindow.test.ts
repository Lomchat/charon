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
