// Screenshot capture for the README. Demo hub must be up on :10999 (demo.db,
// or set DEMO_BASE) with CHARON_DISABLE_AUTOCONNECT=1, and the isolated demo
// agent running (scripts/demo-agent-setup.sh). 100% fictitious data.
// Output → docs/img/.
//
// What this captures (the CURRENT interface):
//   dashboard.png   desktop 3-column: tab bar, Claude + Codex sessions, usage
//                   gauge, a cross-session permission popup, the tool panel
//   claude-chat.png Claude session close-up (streamed answer, tool pairing)
//   codex-chat.png  Codex session close-up (codex logo bubbles, sandbox mode)
//   editor.png      the built-in editor: file tree + CodeMirror on a real file
//   explorer.png    the explorer's context menu over the git-decorated tree
//   git.png         the git tab: changed files, selection, commit box
//   diff.png        the full-screen diff reader
//   usage.png       the account-usage gauges (5h / 7d / weekly caps) popover
//   shell.png       a LIVE terminal, beside that box's sessions
//   mobile-*.png    the SAME UI reflowed to a phone
//
// Everything on `prod-eu-1` is LIVE against the demo agent (files, git,
// terminal); the rest of the fleet is fictitious and unreachable on purpose.
//
// The sidebar is rendered in its DEFAULT compact mode ("details" OFF — forced
// here via localStorage so the shot matches the shipped default on any build).
// Usage gauges are live-only server-side, so we mock GET /api/vps/*/usage.
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:10999';
const OUT = 'docs/img';
const DB = process.env.DEMO_DB || './data/demo.db';
const LIVE_VPS = 'v_eu1';                 // the real local agent (see demo-seed)
const REPO = '/srv/checkout-service';     // its project (see demo-agent-setup.sh)
mkdirSync(OUT, { recursive: true });

const COOKIE = {
  name: 'charon_session', value: 'demo-session-screenshot',
  domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

// ── Fictitious account-usage payloads (AccountUsage shape) ──────────────────
const claudeUsage = {
  ok: true, fetchedAt: Date.now(), provider: 'claude', subscriptionType: 'max',
  fiveHour: { utilization: 41, resetsAt: iso(2.4 * 3600e3) },
  sevenDay: { utilization: 63, resetsAt: iso(3.1 * 86400e3) },
  limits: [
    { kind: 'session',       group: 'session', percent: 41, severity: 'normal',  resetsAt: iso(2.4 * 3600e3) },
    { kind: 'weekly_all',    group: 'weekly',  percent: 63, severity: 'warning',  resetsAt: iso(3.1 * 86400e3) },
    { kind: 'weekly_scoped', group: 'weekly',  percent: 88, severity: 'critical', resetsAt: iso(3.1 * 86400e3), scopeModel: 'Opus' },
  ],
};
const codexUsage = {
  ok: true, fetchedAt: Date.now(), provider: 'codex', subscriptionType: 'pro',
  fiveHour: { utilization: 29, resetsAt: iso(1.7 * 3600e3) },
  sevenDay: { utilization: 47, resetsAt: iso(4.6 * 86400e3) },
  limits: [
    { kind: 'session',    group: 'session', percent: 29, severity: 'normal', resetsAt: iso(1.7 * 3600e3) },
    { kind: 'weekly_all', group: 'weekly',  percent: 47, severity: 'normal', resetsAt: iso(4.6 * 86400e3) },
  ],
};

// ── Keep the demo DB in its seeded, healthy state before every shot ─────────
// Focusing a session on a (deliberately unreachable) fictitious VPS spins up a
// background SSH reconnect that would flip it to 'error' after ~34s. Resetting
// right before each navigation keeps the SSR snapshot green; captures are far
// under 34s. Session statuses are re-pinned too (the live box answers `hello`
// but knows none of these seeded session ids, so a failed attach must not
// leave the hero looking asleep).
const SESSION_STATUS = {
  s_auth: 'active', s_review: 'active', s_tests: 'thinking', s_build: 'active',
  s_mig: 'sleeping', s_docs: 'sleeping', s_pipe: 'sleeping',
};
// The pending permission drives the cross-session popup. Great on the HERO
// dashboard, cluttering on the chat close-ups → keep it only where asked.
const PENDING = {
  id: 'perm-1', session_id: 's_tests', tool_name: 'Bash',
  tool_input: JSON.stringify({ command: 'npm test -- login --runInBand', description: 'Run the login test suite serially' }),
};
function resetDemoState(keepPending) {
  const db = new Database(DB);
  db.pragma('busy_timeout = 5000');
  db.prepare(`UPDATE vps SET agent_status='ok', agent_last_error=NULL`).run();
  const up = db.prepare(`UPDATE claude_sessions SET status=? WHERE id=?`);
  for (const [id, st] of Object.entries(SESSION_STATUS)) up.run(st, id);
  db.prepare(`DELETE FROM claude_pending_permissions WHERE id=?`).run(PENDING.id);
  if (keepPending) {
    db.prepare(`INSERT INTO claude_pending_permissions (id,session_id,tool_name,tool_input,status,created_at)
                VALUES (?,?,?,?, 'pending', unixepoch())`)
      .run(PENDING.id, PENDING.session_id, PENDING.tool_name, PENDING.tool_input);
  }
  db.close();
}
// File tabs opened by a previous shot would linger in the (shared, persisted)
// tab bar and change every later capture. Drop them between shots.
function closeFileTabs() {
  const db = new Database(DB);
  db.pragma('busy_timeout = 5000');
  try { db.prepare(`DELETE FROM tabs WHERE kind='file'`).run(); } catch {}
  db.close();
}

const browser = await chromium.launch();
// SHOTS=editor,git → re-capture just those (names without .png).
const ONLY = (process.env.SHOTS || '').split(',').map((s) => s.trim()).filter(Boolean);

async function shot(ctxOpts, fn, file, opts = {}) {
  if (ONLY.length && !ONLY.includes(file.replace(/\.png$/, ''))) return;
  resetDemoState(!!opts.keepPending);
  if (!opts.keepFileTabs) closeFileTabs();
  const context = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 2, ...ctxOpts });
  await context.addCookies([COOKIE]);
  // Compact sidebar = the shipped default ("details" OFF). Forced so the shot is
  // correct on any build (older builds still defaulted details ON).
  await context.addInitScript(() => {
    try { localStorage.setItem('hub.claude.showDetails.v1', '0'); } catch {}
  });
  // Usage gauges are live-only server-side → mock the hydration endpoint.
  await context.route('**/api/vps/*/usage', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ usage: claudeUsage, codexUsage }) }));
  const page = await context.newPage();
  let ok = true;
  try { await fn(page); } catch (e) { ok = false; console.log('  (step warn)', file, String(e).slice(0, 160)); }
  try { await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {}); } catch {}
  try {
    await page.screenshot({ path: `${OUT}/${file}`, animations: 'disabled', timeout: 60000 });
    console.log((ok ? '✓' : '⚠') + ' ' + file);
  } catch (e) { console.log('✗', file, String(e).slice(0, 160)); }
  await context.close();
}

// `domcontentloaded` — NEVER networkidle (the SSE keeps the network busy forever).
async function open(page, path = '/') {
  // The demo hub SSRs while it is also opening SSH to the live box; the first
  // navigation after a warm-up occasionally blows a short timeout. Retry once.
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
}
const clickSession = async (page, label) => {
  const el = page.getByText(label, { exact: false }).first();
  await el.waitFor({ timeout: 12000 });
  await el.click();
};
// Tool panel tabs are icon-only when inactive; aria-label is the stable handle
// ('files' is the explorer, 'attach' the attachments — see ToolPanel § TABS).
const toolTab = (page, label) => page.locator(`.tp-tabs button[aria-label="${label}"]`);
// The pane re-renders under the pointer while the chat scrolls into place, so a
// plain click occasionally never lands. Retry, then force.
async function clickToolTab(page, label) {
  const b = toolTab(page, label);
  try { await b.click({ timeout: 5000 }); return; } catch {}
  // Last resort: a DOM click, immune to whatever is overlapping the panel
  // (the cross-session permission popup renders exactly over these tabs).
  await page.evaluate((l) => {
    document.querySelector(`.tp-tabs button[aria-label="${l}"]`)?.click();
  }, label);
  await sleep(400);
}
const treeRow = (page, name) => page.locator('.tt-name', { hasText: new RegExp(`^${name}$`) }).first();
// The first RPC to the live agent opens the SSH connection; git/tree calls made
// before it is up answer 'offline'. Warm it, then load the page.
async function warmAgent(page) {
  await page.request.get(`${BASE}/api/vps/${LIVE_VPS}/fs/list?root=${encodeURIComponent(REPO)}&path=`)
    .catch(() => {});
  await sleep(1200);
}

// 1) Desktop dashboard — tab bar, Claude + Codex sessions, usage, permission
await shot({ viewport: { width: 1920, height: 1040 } }, async (page) => {
  await warmAgent(page);
  await open(page);
  await clickSession(page, 'refactor auth middleware');
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 10000 });
  await sleep(2500);
}, 'dashboard.png', { keepPending: true });

// 2) Claude chat close-up — the discussion view (model chips, tool pairing)
await shot({ viewport: { width: 1680, height: 1040 } }, async (page) => {
  await open(page, '/?session=s_auth');
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(1800);
}, 'claude-chat.png');

// 3) Codex chat close-up — codex logo bubbles, gpt-5-codex, sandbox mode
await shot({ viewport: { width: 1680, height: 1040 } }, async (page) => {
  await open(page, '/?session=s_review');
  await page.getByText('Audit the new /checkout endpoint', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(1800);
}, 'codex-chat.png');

// 4) The built-in editor — LIVE: expand the tree, open the file the seeded
//     conversation just created. It opens as its own tab, explorer beside it.
await shot({ viewport: { width: 1920, height: 940 } }, async (page) => {
  await warmAgent(page);
  await open(page, '/?session=s_auth');
  await page.locator('.claude-chat').first().waitFor({ timeout: 12000 });
  await sleep(1200);   // let the chat settle: it steals the click while it scrolls
  await clickToolTab(page, 'files');
  await treeRow(page, 'src').click({ timeout: 8000 });
  await treeRow(page, 'middleware').click({ timeout: 8000 });
  await treeRow(page, 'rateLimit\\.ts').dblclick({ timeout: 8000 });
  await page.locator('.cm-content').first().waitFor({ timeout: 12000 });
  await sleep(900);
  // The tree remounts when the pane swaps to the file tab, so re-open the
  // folder: the point of the shot is both halves at once.
  await treeRow(page, 'src').click({ timeout: 6000 }).catch(() => {});
  await treeRow(page, 'middleware').click({ timeout: 6000 }).catch(() => {});
  await page.mouse.move(900, 980);   // no stray hover highlight in the tree
  await sleep(900);
}, 'editor.png');

// 5) The explorer's context menu over the git-decorated tree.
await shot({ viewport: { width: 1680, height: 1000 } }, async (page) => {
  await warmAgent(page);
  await open(page, '/?session=s_auth');
  await page.locator('.claude-chat').first().waitFor({ timeout: 12000 });
  await sleep(1200);
  await clickToolTab(page, 'files');
  await treeRow(page, 'src').click({ timeout: 8000 });
  await treeRow(page, 'middleware').click({ timeout: 8000 });
  await treeRow(page, 'rateLimit\\.ts').click({ button: 'right', timeout: 8000 });
  await page.locator('.tt-menu').waitFor({ timeout: 8000 });
  await sleep(600);
}, 'explorer.png');

// 6) The git tab — LIVE status of the demo repo, two files ticked for a commit.
await shot({ viewport: { width: 1680, height: 1000 } }, async (page) => {
  await warmAgent(page);
  await open(page, '/?session=s_auth');
  await page.locator('.claude-chat').first().waitFor({ timeout: 12000 });
  await sleep(1200);
  await clickToolTab(page, 'git');
  await page.locator('.git-tab .gt-files li').first().waitFor({ timeout: 12000 });
  const boxes = page.locator('.git-tab .gt-files li input[type=checkbox]');
  for (const i of [0, 1, 2]) await boxes.nth(i).click({ timeout: 4000 }).catch(() => {});
  await page.locator('.git-tab .gt-msg').first()
    .fill('auth: swap the session lookup to the async store').catch(() => {});
  await sleep(800);
}, 'git.png');

// 7) The diff reader — opened from the git tab. Short viewport on purpose:
//     the modal is full-height and the demo patch is small.
await shot({ viewport: { width: 1680, height: 760 } }, async (page) => {
  await warmAgent(page);
  await open(page, '/?session=s_auth');
  await page.locator('.claude-chat').first().waitFor({ timeout: 12000 });
  await sleep(1200);
  await clickToolTab(page, 'git');
  await page.locator('.git-tab .gt-files li').first().waitFor({ timeout: 12000 });
  await page.locator('.git-tab .gt-open').first().click({ timeout: 8000 });
  await page.locator('.split-diff-modal').first().waitFor({ timeout: 10000 });
  await sleep(1000);
}, 'diff.png');

// 8) Usage gauges — open the header popover (5h / 7d / weekly caps)
await shot({ viewport: { width: 1440, height: 940 } }, async (page) => {
  await open(page, '/?session=s_auth');
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(700);
  await page.locator('.usage-chip').first().click({ timeout: 6000 }).catch(() => {});
  await sleep(1000);
}, 'usage.png');

// 9) Shell — a LIVE terminal on the demo agent, beside that box's sessions.
//    Created on demand so the shell tab/card appears next to them.
await shot({ viewport: { width: 1920, height: 1040 } }, async (page) => {
  await open(page);
  // Mutations go through the PAGE's own fetch, not page.request: the session
  // cookie is SameSite=Lax, so an APIRequestContext POST/DELETE from
  // about:blank silently drops it and every call 401s.
  await page.evaluate(async () => {
    const j = await (await fetch('/api/vps/v_eu1/shells')).json().catch(() => ({ shells: [] }));
    // Otherwise every run stacks another 'deploy shell' card on the box.
    for (const sh of j.shells ?? []) await fetch('/api/shells/' + sh.id, { method: 'DELETE' });
    await fetch('/api/vps/v_eu1/shells', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/srv/checkout-service', name: 'deploy shell' }),
    });
  }).catch(() => {});
  await sleep(1500);        // let the holder spawn
  await open(page);
  await clickSession(page, 'deploy shell');
  await page.locator('.xterm').first().waitFor({ timeout: 12000 });
  await sleep(2500); // WS connect + replay
  await page.locator('.xterm').first().click();
  // No `ls -l` (its owner column would print the demo user) and no line
  // carrying a URL (the wrapped-URL helper would pop over the shot).
  const cmds = [
    "export PS1='\\[\\e[38;5;75m\\]deploy@prod-eu-1\\[\\e[0m\\]:\\[\\e[38;5;150m\\]\\w\\[\\e[0m\\]$ '",
    'clear', 'ls', 'git status -sb', 'git log --oneline -4', 'head -n 3 deploy.log',
    'npm run test --silent 2>/dev/null || true',
  ];
  for (const c of cmds) { await page.keyboard.type(c); await page.keyboard.press('Enter'); await sleep(700); }
  // Typing takes long enough for the unreachable fictitious boxes to go red
  // (3 failed reconnects, §14.34). Re-green them and reload — the terminal
  // comes back from its durable tail replay, the health chips come back clean.
  resetDemoState(false);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('.xterm').first().waitFor({ timeout: 12000 });
  await sleep(2600);
}, 'shell.png');

// 10) Mobile — the SAME responsive UI at a phone width. The session list is an
//     off-canvas drawer opened with the ☰ header button.
await shot({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true }, async (page) => {
  await open(page, '/');
  await page.getByLabel('open navigation').click({ timeout: 12000 }).catch(() => {});
  await page.getByText('refactor auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(1500);
}, 'mobile-select.png');

// 11) Mobile — deep-link into the chat (full-screen conversation + prompt bar).
await shot({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true }, async (page) => {
  await open(page, '/?session=s_auth');
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(2200);
}, 'mobile-chat.png');

// 12) Mobile — the account-usage drawer (the gauges live in the right drawer on
//     phones). Opens via the ☉ "usage & settings" header button.
await shot({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true }, async (page) => {
  await open(page, '/?session=s_auth');
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(700);
  await page.getByLabel('open usage and settings').click({ timeout: 8000 }).catch(() => {});
  await sleep(1200);
}, 'mobile-usage.png');

await browser.close();
console.log('done');
