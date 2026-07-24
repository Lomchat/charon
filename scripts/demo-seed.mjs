// Demo data seeder for the README screenshots — 100% FICTITIOUS data.
// Usage:  DEMO_DB=./data/demo.db node scripts/demo-seed.mjs
// (SESSION_SECRET is read from .env so the seeded browser session validates.)
//
// IPs use RFC 5737 documentation ranges (192.0.2.x / 203.0.113.x) — non-routable
// — except `sandbox` = 127.0.0.1, the ISOLATED local charon-agent used for the
// live shell screenshot (see scripts/demo-agent-setup.sh).
//
// The dataset showcases the CURRENT interface: Claude AND Codex sessions side by
// side (kind='codex'), per-message model chips, a "finished — unread" glow, a
// cross-session permission popup, and healthy per-VPS health chips.
import 'dotenv/config';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// Safety: this script WIPES tables — never let it touch the real DB.
const DB_PATH = process.env.DEMO_DB || './data/demo.db';
if (!/demo/.test(DB_PATH)) {
  console.error(`refusing to seed a non-demo DB: ${DB_PATH} (set DEMO_DB=./data/demo.db)`);
  process.exit(1);
}

// Mirror of lib/server/sessionHash.js: the cookie holds the RAW token, the DB
// stores HMAC-SHA256(SESSION_SECRET, token). demo-shots.mjs sends RAW_TOKEN.
const RAW_TOKEN = 'demo-session-screenshot';
function hashSessionToken(token) {
  const s = process.env.SESSION_SECRET;
  return s
    ? crypto.createHmac('sha256', s).update(token).digest('hex')
    : crypto.createHash('sha256').update(token).digest('hex');
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
const now = Math.floor(Date.now() / 1000);

// Wipe (idempotent reseed)
for (const t of ['claude_session_messages', 'claude_pending_permissions', 'claude_pending_questions',
  'claude_session_logs', 'claude_sessions', 'shells', 'vps_paths', 'vps', 'vps_folders', 'sessions', 'users']) {
  try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
}

// User + a long-lived browser session whose HASHED id we store (cookie = RAW_TOKEN).
db.prepare(`INSERT INTO users (id, password_hash, password_salt, key_check, created_at)
            VALUES (1,'demo','demo','demo',?)`).run(now);
db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?,1,?)`)
  .run(hashSessionToken(RAW_TOKEN), now + 365 * 24 * 3600);

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

// VPS. agent_status='ok' + a current pyz sha (matches the built .pyz so no
// spurious "update agent" badge). Most boxes run BOTH backends
// (codex_available=1, codex_logged_in=1) → the +Codex launch button is enabled
// and the health chips read "claude ✓ / codex ✓". `sandbox` is a shells-only
// box (no SDK, no login).
const PYZ = '9a979df10530';           // first 12 of sha256(agent/dist/charon-agent.pyz)
const AGENT_V = '0.21.0';
const SDK_V = '0.19.1';               // claude-agent-sdk in the venv
const CODEX_V = '0.5.2';              // openai-codex in the venv
// [id, name, ip, user, folder, pos, dual]  dual=false → Claude-only / shells-only
const vpses = [
  ['v_eu1', 'prod-eu-1',  '192.0.2.11',   'deploy', 'f_prod', 0, true],
  ['v_api', 'api-gateway', '192.0.2.24',  'deploy', 'f_prod', 1, true],
  ['v_stg', 'staging-01',  '203.0.113.7', 'ubuntu', 'f_stg',  0, true],
  ['v_ml',  'ml-trainer',  '203.0.113.42', 'root',  'f_labs', 0, true],
  // sandbox → the REAL isolated localhost agent used for the live shell shot
  // (marked healthy so the sidebar card is clean — no "claude login" bar).
  ['v_box', 'sandbox',     '127.0.0.1',   'charondemo', 'f_labs', 1, true],
];
const insVps = db.prepare(`INSERT INTO vps
  (id,name,ip,ssh_user,ssh_port,default_path,created_at,agent_status,agent_version,
   agent_pyz_sha,sdk_version,agent_last_seen_at,folder_id,position,
   claude_logged_in,claude_logged_in_checked_at,
   codex_available,codex_sdk_version,codex_logged_in,codex_logged_in_checked_at)
  VALUES (?,?,?,?,22,?,?,'ok',?,?,?,?,?,?,?,?,?,?,?,?)`);
for (const [id, name, ip, user, folder, pos, dual] of vpses)
  insVps.run(id, name, ip, user, '/srv/app', now, AGENT_V, PYZ,
    dual ? SDK_V : null, now, folder, pos,
    dual ? 1 : null, dual ? now : null,
    dual ? 1 : null, dual ? CODEX_V : null, dual ? 1 : null, dual ? now : null);

// Known cwds (path autocomplete + sidebar groupings)
for (const [vps, path] of [
  ['v_eu1', '/srv/app'], ['v_api', '/srv/api'], ['v_stg', '/srv/web'], ['v_ml', '/data/pipeline'],
]) db.prepare(`INSERT INTO vps_paths (vps_id,path,created_at) VALUES (?,?,?)`).run(vps, path, now);

// ── Sessions: Claude + Codex side by side, varied statuses ──────────────────
// [id, kind, vps, cwd, name, status, mode, color, model, effort, effModel, unread]
const CO = '#7c9cff', CY = '#ffd479', GR = '#9be29b', PK = '#ff9bc1', VB = '#b79bff', TL = '#79d6c4';
const sessions = [
  // Production · prod-eu-1 — Claude (HERO) + Codex on the SAME box (dual-use)
  ['s_auth',   'claude', 'v_eu1', '/srv/app',  'refactor auth middleware',   'active',   'acceptEdits',     CO, 'claude-opus-4-8', 'high',   'claude-opus-4-8', 0],
  ['s_review', 'codex',  'v_eu1', '/srv/app',  'audit /checkout endpoint',   'active',   'workspace-write', TL, 'gpt-5-codex',     'high',   'gpt-5-codex',     0],
  // Production · api-gateway — Claude (thinking, pending permission) + Codex
  ['s_tests',  'claude', 'v_api', '/srv/api',  'fix flaky integration tests','thinking', 'normal',          CY, 'claude-opus-4-8', 'high',   'claude-opus-4-8', 0],
  ['s_build',  'codex',  'v_api', '/srv/api',  'port build to esbuild',      'active',   'workspace-write', VB, 'gpt-5-codex',     'medium', 'gpt-5-codex',     0],
  // Staging · staging-01 — a sleeping Claude session + a finished-unread one
  ['s_mig',    'claude', 'v_stg', '/srv/web',  'migrate ORM to Drizzle',     'sleeping', 'normal',          GR, 'claude-sonnet-4-6','high',  null,              0],
  ['s_docs',   'claude', 'v_stg', '/srv/web',  'generate API reference',     'sleeping', 'normal',          CO, 'claude-opus-4-8', 'medium', 'claude-opus-4-8', 1],
  // Labs · ml-trainer — a sleeping Codex session (read-only sandbox)
  ['s_pipe',   'codex',  'v_ml',  '/data/pipeline', 'profile data pipeline', 'sleeping', 'read-only',       PK, 'gpt-5-codex',     'xhigh',  'gpt-5-codex',     0],
];
const insSes = db.prepare(`INSERT INTO claude_sessions
  (id,claude_session_id,vps_id,kind,cwd,name,status,permission_mode,created_at,last_used_at,
   color,model,effort,effective_model,unread_stop,sleep_requested)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
let age = 0;
for (const [id, kind, vps, cwd, name, status, mode, color, model, effort, effModel, unread] of sessions) {
  insSes.run(id, 'thread-' + id, vps, kind, cwd, name, status, mode,
    now - 5400, now - 90 - (age += 30), color, model, effort, effModel, unread);
}

// Persistent shells: NONE seeded on purpose. A seeded shell row on an
// unreachable VPS makes reconcileShellsOnBoot SSH-probe that box at boot and
// flip it to 'error' (and would prune the phantom). The one live/openable shell
// — on the isolated sandbox agent — is created on demand by demo-shots.mjs, so
// it appears next to the Claude/Codex sessions (the dual-use story) in shell.png.

// ── Message helper (stamps assistant rows with the per-message model chip) ──
const insMsg = db.prepare(`INSERT INTO claude_session_messages
  (session_id,role,content,model,created_at) VALUES (?,?,?,?,?)`);
function conv(sessionId, model, entries) {
  for (const [role, content, dt] of entries)
    insMsg.run(sessionId, role, content, role === 'assistant' ? model : null, now - dt);
}
const tu = (id, name, input) => JSON.stringify({ type: 'tool_use', id, name, input });
const tr = (id, content, isErr = false) =>
  JSON.stringify({ type: 'tool_result', tool_use_id: id, content, is_error: isErr });

// ── HERO Claude conversation (s_auth) — auth refactor + a live todo list ──
conv('s_auth', 'claude-opus-4-8', [
  ['user', 'Refactor the auth middleware to use the new async session store, then add sliding-window rate limiting on the /login route (5 attempts / 15 min per IP).', 600],
  ['thinking', 'Let me read the current middleware and the session store interface before changing anything — I want to keep the cookie contract identical and only swap the lookup.', 592],
  ['assistant', "I'll do this in two steps:\n\n1. Swap the synchronous in-memory session lookup for the new async store (keeping the cookie contract identical).\n2. Add a sliding-window rate limiter on `/login`.\n\nLet me start by reading the relevant files.", 590],
  ['tool_use', tu('t1', 'Read', { file_path: 'src/middleware/auth.ts' }), 588],
  ['tool_result', tr('t1', "1  import { getSessionSync } from '../lib/store';\n2  export function auth(req, res, next) {\n3    const sid = req.cookies.sid;\n4    const s = getSessionSync(sid);\n5    if (!s) return res.status(401).end();\n6    req.user = s.user; next();\n7  }"), 587],
  ['tool_use', tu('t2', 'Read', { file_path: 'src/lib/sessionStore.ts' }), 584],
  ['tool_result', tr('t2', "export async function getSession(id: string): Promise<Session | null> { /* redis-backed */ }"), 583],
  ['assistant', "The middleware reads sessions synchronously from memory. I'll switch it to the async Redis-backed `getSession`, make the handler `async`, and preserve the 401-on-missing behaviour — then add the rate limiter.", 580],
  ['tool_use', tu('t3', 'TodoWrite', { todos: [
    { content: 'Swap sync session lookup → async getSession', status: 'completed', activeForm: 'Swapping session lookup' },
    { content: 'Add sliding-window rate limiter on /login', status: 'in_progress', activeForm: 'Adding rate limiter' },
    { content: 'Run the auth test suite', status: 'pending', activeForm: 'Running tests' },
  ] }), 578],
  ['tool_result', tr('t3', 'Todos updated (3 items)'), 577],
  ['tool_use', tu('t4', 'Edit', { file_path: 'src/middleware/auth.ts', old_string: 'const s = getSessionSync(sid);', new_string: 'const s = await getSession(sid);' }), 574],
  ['tool_result', tr('t4', 'Applied edit to src/middleware/auth.ts'), 573],
  ['assistant', "Store swap done. Now the rate limiter — a small sliding-window keyed by IP, wired before the login handler. Let me run the suite to make sure nothing regressed.", 540],
]);

// A captured before/after snapshot for the Edit above → the DIFFS tab of the
// tool panel renders a real diff (the "diff capture & revert" feature). The
// session GET strips the bodies; GET .../edits serves them on demand (§14.41).
const authBefore =
  "import { getSessionSync } from '../lib/store';\n\n" +
  "export function auth(req, res, next) {\n" +
  "  const sid = req.cookies.sid;\n" +
  "  const s = getSessionSync(sid);\n" +
  "  if (!s) return res.status(401).end();\n" +
  "  req.user = s.user;\n  next();\n}\n";
const authAfter =
  "import { getSession } from '../lib/store';\n\n" +
  "export async function auth(req, res, next) {\n" +
  "  const sid = req.cookies.sid;\n" +
  "  const s = await getSession(sid);\n" +
  "  if (!s) return res.status(401).end();\n" +
  "  req.user = s.user;\n  next();\n}\n";
for (const [phase, body, dt] of [['before', authBefore, 574], ['after', authAfter, 573]])
  insMsg.run('s_auth', 'edit_snapshot', JSON.stringify({
    type: 'edit_snapshot', phase, tool_use_id: 't4',
    file_path: 'src/middleware/auth.ts', content: body, size: body.length, truncated: false,
  }), null, now - dt);

// ── Codex conversation (s_review) — a security audit with Codex tools ──
conv('s_review', 'gpt-5-codex', [
  ['user', 'Audit the new /checkout endpoint for injection and authz gaps, then patch anything you find. Keep the diff minimal.', 480],
  ['assistant', "I'll map the request path first, grep for raw query building and missing ownership checks, then patch. Planning it out:", 476],
  ['tool_use', tu('c1', 'update_plan', { plan: [
    { step: 'Trace /checkout handler + its DB calls', status: 'completed' },
    { step: 'Grep for string-interpolated SQL', status: 'in_progress' },
    { step: 'Confirm the cart belongs to the caller', status: 'pending' },
    { step: 'Patch + re-run the endpoint tests', status: 'pending' },
  ] }), 474],
  ['tool_result', tr('c1', 'plan updated (4 steps)'), 473],
  ['tool_use', tu('c2', 'shell', { command: ['rg', '-n', 'SELECT .*\\+', 'server/routes/checkout.ts'] }), 470],
  ['tool_result', tr('c2', "42:  const q = `SELECT * FROM carts WHERE id = ${req.body.cartId}`;\n58:  const row = await db.raw(q);"), 469],
  ['assistant', "Two problems on the same path: line 42 interpolates `cartId` straight into SQL (injection), and nothing checks the cart belongs to `req.user`. I'll switch to a parameterised query and add an ownership guard.", 465],
  ['tool_use', tu('c3', 'apply_patch', { input: "*** Begin Patch\n*** Update File: server/routes/checkout.ts\n@@\n-  const q = `SELECT * FROM carts WHERE id = ${req.body.cartId}`;\n-  const row = await db.raw(q);\n+  const row = await db.one(\n+    'SELECT * FROM carts WHERE id = $1 AND user_id = $2',\n+    [req.body.cartId, req.user.id],\n+  );\n+  if (!row) return res.status(404).end();\n*** End Patch" }), 460],
  ['tool_result', tr('c3', 'Applied patch to server/routes/checkout.ts (1 file changed, +5 −2)'), 459],
  ['assistant', "Patched: the query is now parameterised and scoped to `user_id`, so an attacker can neither inject nor read another user's cart. Running the checkout tests to confirm nothing broke.", 452],
]);

// Codex captures its patch too → the DIFFS tab renders the apply_patch above
// (Codex phase 'diff' carries a unified diff, surfaced as the `after` body).
const checkoutDiff =
  "@@ -40,8 +40,9 @@ export async function checkout(req, res) {\n" +
  "-  const q = `SELECT * FROM carts WHERE id = ${req.body.cartId}`;\n" +
  "-  const row = await db.raw(q);\n" +
  "+  const row = await db.one(\n" +
  "+    'SELECT * FROM carts WHERE id = $1 AND user_id = $2',\n" +
  "+    [req.body.cartId, req.user.id],\n" +
  "+  );\n" +
  "+  if (!row) return res.status(404).end();\n";
insMsg.run('s_review', 'edit_snapshot', JSON.stringify({
  type: 'edit_snapshot', phase: 'diff', tool_use_id: 'c3',
  file_path: 'server/routes/checkout.ts', diff: checkoutDiff, size: checkoutDiff.length, truncated: false,
}), null, now - 459);

// Short openers so the other sessions aren't empty if opened / hovered.
conv('s_tests', 'claude-opus-4-8', [
  ['user', 'The integration tests for /login flake ~1 in 5 runs on CI. Find the race and stabilise them.', 300],
  ['assistant', "Likely a shared-state or timing race. Let me reproduce it under a repeat runner and watch which assertion drops first.", 296],
]);
conv('s_build', 'gpt-5-codex', [
  ['user', 'Replace the webpack build with esbuild; keep the same output layout and env-var injection.', 900],
  ['assistant', "Starting from the webpack config so the esbuild setup matches output paths, loaders and defines exactly.", 895],
]);
conv('s_mig', 'claude-sonnet-4-6', [
  ['user', 'Migrate the raw-SQL models under src/db to Drizzle, one table at a time, tests green between each.', 7200],
]);
conv('s_docs', 'claude-opus-4-8', [
  ['user', 'Generate an OpenAPI reference for every route under /api and wire it into the docs site.', 3600],
  ['assistant', "Done — 37 routes documented and the reference is building into docs/api. I left a TODO where three admin routes need example payloads.", 1200],
]);
conv('s_pipe', 'gpt-5-codex', [
  ['user', 'Profile the nightly ETL and tell me where the 40 min is going before we optimise anything.', 10800],
]);

// A pending permission on the (thinking) api-gateway session — surfaces as a
// cross-session permission popup in the dashboard shot, while the HERO session
// keeps its prompt bar (a pending interaction there would replace it).
db.prepare(`INSERT INTO claude_pending_permissions (id,session_id,tool_name,tool_input,status,created_at)
            VALUES (?,?,?,?, 'pending', ?)`)
  .run('perm-1', 's_tests', 'Bash',
       JSON.stringify({ command: 'npm test -- login --runInBand', description: 'Run the login test suite serially' }), now - 18);

// Settings so the demo hub's boot/ticks don't rewrite our seeded rows:
//  - migration.v2_agent_done : don't flip 'active' sessions to 'sleeping'.
//  - auth.session_ids_hashed : our session id is ALREADY hashed — never
//    double-hash it (that would invalidate the demo cookie). cf. §12.
//  - {sdk,codex}.latest_version(_at) : pin the PyPI "latest" to the SEEDED
//    versions (with a fresh _at so the 12h-TTL sdk-watch won't re-fetch the
//    real PyPI values) → nothing shows a bogus "agent out of date / update" bar.
const nowMs = String(now * 1000);
for (const [k, v] of [
  ['migration.v2_agent_done', String(now)],
  ['auth.session_ids_hashed', '1'],
  ['sdk.latest_version', SDK_V],   ['sdk.latest_version_at', nowMs],
  ['codex.latest_version', CODEX_V], ['codex.latest_version_at', nowMs],
])
  db.prepare(`INSERT OR REPLACE INTO claude_settings (key, value) VALUES (?, ?)`).run(k, v);

console.log(`demo seed OK → ${DB_PATH} · cookie charon_session = ${RAW_TOKEN}`);
db.close();
