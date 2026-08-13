// Seeds an isolated DB with ONE session holding a long, realistically-shaped
// transcript, so the chat scroller can be driven under Playwright without
// touching the live hub's shared workspace (§14.78 — `?session=` mutates the
// tab layout every device sees).
//
// Shape matters more than volume: the scroll bug being chased comes from
// off-screen height ESTIMATES being wrong, so the seed deliberately mixes the
// extremes — one-line exchanges, collapsed tool cards, and long answers with
// fenced code — rather than 1000 copies of one bubble.
import Database from 'better-sqlite3';

const DB = process.env.SCROLL_DB || './data/scrolltest.db';
const SESSION_ID = 'scrolltest0000000000000000000001';
const VPS_ID = 'scrolltestvps01';
const TURNS = Number(process.env.TURNS || 260);

const db = new Database(DB);
db.pragma('foreign_keys = ON');

db.prepare(`INSERT OR REPLACE INTO vps_folders (id, name, position) VALUES ('default','Default',0)`).run();
db.prepare(
  `INSERT OR REPLACE INTO vps (id, name, ip, ssh_user, ssh_port, folder_id, position, agent_status)
   VALUES (?, 'scroll-test', '192.0.2.10', 'root', 22, 'default', 0, 'ok')`,
).run(VPS_ID);
db.prepare(
  `INSERT OR REPLACE INTO claude_sessions (id, vps_id, cwd, name, status, permission_mode, kind, created_at)
   VALUES (?, ?, '/srv/scrolltest', 'scroll repro', 'sleeping', 'normal', 'claude', unixepoch())`,
).run(SESSION_ID, VPS_ID);
db.prepare('DELETE FROM claude_session_messages WHERE session_id = ?').run(SESSION_ID);

const ins = db.prepare(
  `INSERT INTO claude_session_messages (session_id, role, content, created_at, ts_ms, seq, model)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

const CODE = ['function handler(req, res) {', '  const t = Date.now();', '  return res.json({ t });', '}'].join('\n');
let seq = 1;
let ts = Date.now() - TURNS * 60_000;

const add = (role, content, model = null) => {
  ts += 1000;
  ins.run(SESSION_ID, role, content, Math.floor(ts / 1000), ts, seq++, model);
};

db.transaction(() => {
  for (let i = 0; i < TURNS; i++) {
    add('user', `question ${i}: what does step ${i} of the pipeline do?`);
    // A collapsed tool card is ~36px tall. These are the bubbles a flat
    // estimate over-reserves, and they are the bulk of a real transcript.
    add('tool_use', JSON.stringify({ id: `t${i}`, name: 'Read', input: { file_path: `/srv/app/step${i}.ts` } }));
    add('tool_result', JSON.stringify({ tool_use_id: `t${i}`, content: `ok (${i} lines)`, is_error: false }));
    if (i % 3 === 0) {
      add('tool_use', JSON.stringify({ id: `g${i}`, name: 'Grep', input: { pattern: `step${i}`, path: '/srv/app' } }));
      add('tool_result', JSON.stringify({ tool_use_id: `g${i}`, content: 'no matches', is_error: false }));
    }
    // …and a long answer is what a flat estimate under-reserves. Alternating
    // the two is what makes the scroll range move in both directions.
    const long = i % 4 === 0;
    const body = long
      ? `Step ${i} normalises the payload.\n\n## How\n\n${'It walks the record set and rewrites each key in place, which is why it has to run before validation. '.repeat(6)}\n\n\`\`\`ts\n${CODE}\n\`\`\`\n\n${'Downstream consumers rely on that ordering. '.repeat(8)}`
      : `Step ${i} just forwards the record; nothing to see there.`;
    add('assistant', body, 'claude-sonnet-4-6');
  }
})();

const n = db.prepare('SELECT count(*) c FROM claude_session_messages WHERE session_id = ?').get(SESSION_ID);
console.log(`seeded ${n.c} rows in ${DB} · session=${SESSION_ID}`);
