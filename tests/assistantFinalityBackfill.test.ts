import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const migration = fs.readFileSync('drizzle/0045_backfill_assistant_finality.sql', 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE claude_sessions (
      id text PRIMARY KEY, status text NOT NULL, pending_assistant_message_id integer
    );
    CREATE TABLE claude_session_messages (
      id integer PRIMARY KEY, session_id text NOT NULL, role text NOT NULL,
      content text NOT NULL, assistant_final integer, ts_ms integer,
      created_at integer NOT NULL
    );
  `);
  const session = db.prepare('INSERT INTO claude_sessions (id,status,pending_assistant_message_id) VALUES (?,?,?)');
  const message = db.prepare(`INSERT INTO claude_session_messages
    (id,session_id,role,content,assistant_final,ts_ms,created_at) VALUES (?,?,?,?,?,?,?)`);
  const add = (id: number, sid: string, role: string, time: number, final: number | null = null,
    content = role) => message.run(id, sid, role, content, final, time, Math.floor(time / 1000));
  const run = () => {
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  };
  const flags = (sid: string) => db.prepare(`SELECT id, assistant_final FROM claude_session_messages
    WHERE session_id=? AND role='assistant' ORDER BY ts_ms,id`).all(sid);
  return { db, session, add, run, flags };
}

describe('one-time assistant finality backfill', () => {
  it('uses turn boundaries and chronological time, including repaired rows', () => {
    const { db, session, add, run, flags } = fixture();
    session.run('completed', 'active', null);
    add(1, 'completed', 'user', 1_000);
    add(2, 'completed', 'assistant', 2_000);
    add(3, 'completed', 'assistant', 4_000);
    // Inserted late, but belongs between the two earlier assistant rows.
    add(99, 'completed', 'assistant', 3_000);
    add(4, 'completed', 'event', 5_000, null, '{"type":"turn_usage"}');
    add(5, 'completed', 'user', 6_000);
    add(6, 'completed', 'assistant', 7_000);
    add(7, 'completed', 'assistant', 8_000, 1);
    add(8, 'completed', 'assistant', 9_000);
    run();
    expect(flags('completed')).toEqual([
      { id: 2, assistant_final: 0 },
      { id: 99, assistant_final: 0 },
      { id: 3, assistant_final: 1 },
      { id: 6, assistant_final: 0 },
      { id: 7, assistant_final: 1 },
      { id: 8, assistant_final: 1 },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM claude_session_messages WHERE role='assistant' AND assistant_final IS NULL").get())
      .toEqual({ n: 0 });
    db.close();
  });

  it('keeps ongoing answers provisional and preserves a newer pending pointer', () => {
    const { db, session, add, run, flags } = fixture();
    session.run('working', 'thinking', null);
    session.run('newer', 'thinking', 21);
    add(10, 'working', 'user', 1_000);
    add(11, 'working', 'assistant', 2_000);
    add(12, 'working', 'assistant', 3_000);
    add(19, 'newer', 'user', 1_000);
    add(20, 'newer', 'assistant', 2_000);
    add(21, 'newer', 'assistant', 3_000, 0);
    run();
    expect(flags('working')).toEqual([
      { id: 11, assistant_final: 0 }, { id: 12, assistant_final: 0 },
    ]);
    expect(db.prepare('SELECT pending_assistant_message_id AS id FROM claude_sessions WHERE id=?').get('working'))
      .toEqual({ id: 12 });
    expect(db.prepare('SELECT pending_assistant_message_id AS id FROM claude_sessions WHERE id=?').get('newer'))
      .toEqual({ id: 21 });
    db.close();
  });

  it('classifies orphaned historical messages without inventing a live turn', () => {
    const { db, add, run, flags } = fixture();
    add(1, 'orphan', 'user', 1_000);
    add(2, 'orphan', 'assistant', 2_000);
    add(3, 'orphan', 'assistant', 3_000);
    run();
    expect(flags('orphan')).toEqual([
      { id: 2, assistant_final: 0 }, { id: 3, assistant_final: 1 },
    ]);
    db.close();
  });
});
