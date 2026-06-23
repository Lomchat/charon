// Demo data seeder for screenshots — 100% FICTITIOUS data.
// Usage: DATABASE_URL=./data/demo.db node scripts/demo-seed.mjs
// IPs use RFC 5737 documentation ranges (192.0.2.x / 203.0.113.x) — non-routable.
import Database from 'better-sqlite3';

const db = new Database(process.env.DATABASE_URL || './data/demo.db');
db.pragma('foreign_keys = ON');
const now = Math.floor(Date.now() / 1000);

// Wipe (idempotent reseed)
for (const t of ['claude_session_messages', 'claude_pending_permissions', 'claude_pending_questions',
  'claude_session_logs', 'claude_sessions', 'shells', 'vps_paths', 'vps', 'vps_folders', 'sessions', 'users']) {
  try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
}

// User + a long-lived session whose id we'll inject as the cookie
db.prepare(`INSERT INTO users (id, password_hash, password_salt, key_check, created_at)
            VALUES (1,'demo','demo','demo',?)`).run(now);
const SESSION_ID = 'demo-session-screenshot';
db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?,1,?)`)
  .run(SESSION_ID, now + 365 * 24 * 3600);

// Folders
const folders = [
  ['f_prod', 'Production', 0],
  ['f_stg', 'Staging', 1],
  ['f_labs', 'Labs', 2],
  ['default', 'No folder', 99],
];
for (const [id, name, pos] of folders)
  db.prepare(`INSERT INTO vps_folders (id,name,position,collapsed,created_at) VALUES (?,?,?,0,?)`)
    .run(id, name, pos, now);

// VPS (agent_status ok so the sidebar shows them healthy)
const PYZ = 'demoabc12345';
const vpses = [
  ['v_eu1', 'prod-eu-1', '192.0.2.11', 'deploy', 'f_prod', 0],
  ['v_api', 'api-gateway', '192.0.2.24', 'deploy', 'f_prod', 1],
  ['v_stg', 'staging-01', '203.0.113.7', 'ubuntu', 'f_stg', 0],
  ['v_ml', 'ml-trainer', '203.0.113.42', 'root', 'f_labs', 0],
  // sandbox → the REAL isolated localhost agent used for the live shell shot
  ['v_box', 'sandbox', '127.0.0.1', 'charondemo', 'f_labs', 1],
];
for (const [id, name, ip, user, folder, pos] of vpses)
  db.prepare(`INSERT INTO vps (id,name,ip,ssh_user,ssh_port,default_path,created_at,agent_status,
              agent_version,agent_pyz_sha,agent_last_seen_at,folder_id,position,claude_logged_in,claude_logged_in_checked_at)
              VALUES (?,?,?,?,22,?,?,'ok','0.10.0',?,?,?,?,1,?)`)
    .run(id, name, ip, user, '/srv/app', now, PYZ, now, folder, pos, now);

// Claude sessions (varied statuses)
const sessions = [
  ['s_auth', 'v_eu1', '/srv/app', 'refactor auth middleware', 'active', 'normal', '#7c9cff'],
  ['s_tests', 'v_api', '/srv/api', 'fix flaky integration tests', 'thinking', 'acceptEdits', '#ffd479'],
  ['s_mig', 'v_stg', '/srv/web', 'migrate ORM to Drizzle', 'sleeping', 'normal', '#9be29b'],
  ['s_pipe', 'v_ml', '/data/pipeline', 'tune data pipeline', 'sleeping', 'plan', '#ff9bc1'],
];
for (const [id, vps, cwd, name, status, mode, color] of sessions)
  db.prepare(`INSERT INTO claude_sessions (id,claude_session_id,vps_id,cwd,name,status,permission_mode,
              created_at,last_used_at,color,model,effort,sleep_requested)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`)
    .run(id, 'uuid-' + id, vps, cwd, name, status, mode, now - 3600, now - 120, color,
         'claude-opus-4-8', 'high');

// Persistent shells (dual-use: shells live next to Claude sessions)
const shells = [
  ['aa11bb22cc33dd44', 'v_eu1', '/srv/app', 'deploy log', '#7c9cff'],
  ['ee55ff66aa77bb88', 'v_api', '/var/log', 'tail nginx', '#ffd479'],
];
for (const [id, vps, cwd, name, color] of shells)
  db.prepare(`INSERT INTO shells (id,vps_id,cwd,name,color,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, vps, cwd, name, color, now);

// ── A realistic FICTITIOUS conversation for the open session (s_auth) ──
let mid = 1;
const msg = (role, content, dt) =>
  db.prepare(`INSERT INTO claude_session_messages (session_id,role,content,created_at) VALUES (?,?,?,?)`)
    .run('s_auth', role, content, now - dt);

msg('user', 'Refactor the auth middleware to use the new async session store, then add sliding-window rate limiting on the /login route (5 attempts / 15 min per IP).', 600);
msg('thinking', 'Let me read the current middleware and the session store interface before changing anything — I want to keep the cookie contract identical and only swap the lookup.', 590);
msg('assistant', "I'll do this in two steps:\n\n1. Swap the synchronous in-memory session lookup for the new async store (keeping the cookie contract identical).\n2. Add a sliding-window rate limiter on `/login`.\n\nLet me start by reading the relevant files.", 588);
msg('tool_use', JSON.stringify({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/middleware/auth.ts' } }), 585);
msg('tool_result', JSON.stringify({ type: 'tool_result', tool_use_id: 't1', content: "1  import { getSessionSync } from '../lib/store';\n2  export function auth(req, res, next) {\n3    const sid = req.cookies.sid;\n4    const s = getSessionSync(sid);\n5    if (!s) return res.status(401).end();\n6    req.user = s.user; next();\n7  }", is_error: false }), 584);
msg('tool_use', JSON.stringify({ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'src/lib/sessionStore.ts' } }), 582);
msg('tool_result', JSON.stringify({ type: 'tool_result', tool_use_id: 't2', content: "export async function getSession(id: string): Promise<Session | null> { /* redis-backed */ }", is_error: false }), 581);
msg('assistant', 'The middleware reads sessions synchronously from memory. I\'ll switch it to the async Redis-backed `getSession`, making the handler `async`, and preserve the 401-on-missing behaviour. Then I\'ll add the rate limiter.', 578);
msg('tool_use', JSON.stringify({ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: 'src/middleware/auth.ts', old_string: 'getSessionSync', new_string: 'await getSession' } }), 575);
msg('tool_result', JSON.stringify({ type: 'tool_result', tool_use_id: 't3', content: 'Applied edit to src/middleware/auth.ts', is_error: false }), 574);
msg('assistant', "Done with the store swap. Now the rate limiter — I'll add a small in-memory sliding-window keyed by IP and wire it before the login handler. I need to run the test suite to make sure nothing regressed.", 540);

// A pending permission to showcase the approval flow on the open session
db.prepare(`INSERT INTO claude_pending_permissions (id,session_id,tool_name,tool_input,status,created_at)
            VALUES (?,?,?,?, 'pending', ?)`)
  .run('perm-1', 's_auth', 'Bash',
       JSON.stringify({ command: 'npm test -- auth', description: 'Run the auth test suite' }), now - 20);

console.log('demo seed OK · cookie session id =', SESSION_ID);
db.close();
