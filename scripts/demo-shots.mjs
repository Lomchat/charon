// Screenshot capture for the README. Demo hub must be up on :10999 (demo.db)
// with CHARON_DISABLE_AUTOCONNECT=1, and the isolated `sandbox` agent running
// (scripts/demo-agent-setup.sh). 100% fictitious data. Output → docs/img/.
//
// What this captures (the CURRENT interface):
//   dashboard.png   desktop 3-column: Claude + Codex sessions, usage gauge, a
//                   cross-session permission popup, the tool/todo panel
//   claude-chat.png Claude session close-up (streamed answer, tool pairing)
//   codex-chat.png  Codex session close-up (codex logo bubbles, sandbox mode)
//   usage.png       the account-usage gauges (5h / 7d / weekly caps) popover
//   shell.png       a LIVE terminal on the sandbox agent, beside the sessions
//   mobile-select.png / mobile-chat.png   the SAME UI reflowed to a phone
//
// The sidebar is rendered in its DEFAULT compact mode ("details" OFF — forced
// here via localStorage so the shot matches the shipped default on any build).
// Usage gauges are live-only server-side, so we mock GET /api/vps/*/usage.
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:10999';
const OUT = 'docs/img';
const DB = process.env.DEMO_DB || './data/demo.db';
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
// under 34s. Session statuses are re-pinned too (a failed live attach must not
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

const browser = await chromium.launch();

async function shot(ctxOpts, fn, file, opts = {}) {
  resetDemoState(!!opts.keepPending);
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
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
}
const clickSession = async (page, label) => {
  const el = page.getByText(label, { exact: false }).first();
  await el.waitFor({ timeout: 12000 });
  await el.click();
};

// 1) Desktop dashboard — Claude + Codex sessions, usage gauge, permission popup
await shot({ viewport: { width: 1920, height: 1040 } }, async (page) => {
  await open(page);
  await clickSession(page, 'refactor auth middleware');
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 10000 });
  await sleep(2000);
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

// 4) Usage gauges — open the header popover (5h / 7d / weekly caps)
await shot({ viewport: { width: 1440, height: 940 } }, async (page) => {
  await open(page, '/?session=s_auth');
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(700);
  await page.locator('.usage-chip').first().click({ timeout: 6000 }).catch(() => {});
  await sleep(1000);
}, 'usage.png');

// 5) Shell — a LIVE terminal on the isolated sandbox agent, beside the sessions.
//    Create the shell on demand first (so the sandbox VPS + its shell appear).
await shot({ viewport: { width: 1920, height: 1040 } }, async (page) => {
  await page.request.post(`${BASE}/api/vps/v_box/shells`, {
    data: { cwd: '/home/charondemo', name: 'sandbox shell' },
  }).catch(() => {});
  await open(page);
  await clickSession(page, 'sandbox shell');
  await page.locator('.xterm').first().waitFor({ timeout: 12000 });
  await sleep(2500); // WS connect + replay
  await page.locator('.xterm').first().click();
  const cmds = [
    "export PS1='\\[\\e[38;5;75m\\]deploy@sandbox\\[\\e[0m\\]:\\[\\e[38;5;150m\\]\\w\\[\\e[0m\\]$ '",
    'clear', 'cd ~/app', 'ls -la', 'git status -s',
    'git log --oneline -3', 'tail -n 5 deploy.log',
  ];
  for (const c of cmds) { await page.keyboard.type(c); await page.keyboard.press('Enter'); await sleep(700); }
  await sleep(1200);
}, 'shell.png');

// 6) Mobile — the SAME responsive UI at a phone width. The session list is an
//    off-canvas drawer opened with the ☰ header button.
await shot({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true }, async (page) => {
  await open(page, '/');
  await page.getByLabel('open navigation').click({ timeout: 12000 }).catch(() => {});
  await page.getByText('refactor auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(1500);
}, 'mobile-select.png');

// 7) Mobile — deep-link into the chat (full-screen conversation + prompt bar).
await shot({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true }, async (page) => {
  await open(page, '/?session=s_auth');
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(2200);
}, 'mobile-chat.png');

// 8) Mobile — the account-usage drawer (the gauges live in the right drawer on
//    phones). Opens via the ☉ "usage & settings" header button.
await shot({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true }, async (page) => {
  await open(page, '/?session=s_auth');
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(700);
  await page.getByLabel('open usage and settings').click({ timeout: 8000 }).catch(() => {});
  await sleep(1200);
}, 'mobile-usage.png');

await browser.close();
console.log('done');
