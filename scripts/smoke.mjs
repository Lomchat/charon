// Self-contained local smoke test for Charon.
//
// Usage:   node scripts/smoke.mjs
//
// What it does, all by itself (no real VPS, no agent fan-out):
//   1. Creates an isolated temp SQLite DB, runs the Drizzle migrations
//      against it, then seeds 100% FICTITIOUS data (reusing the demo seeder).
//   2. Spawns the Charon hub as a child process on a TEST PORT, reusing the
//      existing `.next` production build, with autoconnect disabled.
//   3. Drives a headless Chromium (Playwright) authenticated via the seeded
//      session cookie and ASSERTS the core flows render (login/auth,
//      dashboard, session view, add-VPS, shell entry).
//   4. ALWAYS tears down (kills the hub, removes the temp DB files).
//   5. Exits 0 if all assertions pass, else 1, after a "SMOKE: N/M passed".
//
// This is an assertions test, NOT a screenshot tool. See scripts/demo-shots.mjs
// (the model) and scripts/demo-seed.mjs (the seeding approach it reuses).

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

const PORT = Number(process.env.SMOKE_PORT || 10998);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const SESSION_ID = 'demo-session-screenshot'; // matches demo-seed.mjs
const COOKIE = {
  name: 'charon_session', value: SESSION_ID,
  domain: HOST, path: '/', httpOnly: true, secure: false, sameSite: 'Lax',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ── assertion bookkeeping ───────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(ok, label, detail) {
  if (ok) { passed++; log('  ✓', label); }
  else { failed++; log('  ✗', label, detail ? `— ${detail}` : ''); }
}
async function assertAsync(label, fn) {
  try { await fn(); assert(true, label); }
  catch (e) { assert(false, label, String(e && e.message || e).slice(0, 160)); }
}

// ── temp DB ─────────────────────────────────────────────────────────────
const tmpDir = mkdtempSync(join(tmpdir(), 'charon-smoke-'));
const DB_PATH = join(tmpDir, 'smoke.db');
function cleanupDb() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { rmSync(DB_PATH + suffix, { force: true }); } catch {}
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ── child hub ───────────────────────────────────────────────────────────
let hub = null;
function killHub() {
  if (!hub) return;
  try { hub.kill('SIGTERM'); } catch {}
  // Hard-kill if it lingers.
  const pid = hub.pid;
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 1500).unref?.();
  hub = null;
}

function runNode(args, label) {
  const r = spawnSync('node', args, {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: DB_PATH },
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

async function waitForLogin(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hub && hub.exitCode != null) throw new Error(`hub exited early (code ${hub.exitCode})`);
    try {
      const res = await fetch(`${BASE}/login`, { redirect: 'manual' });
      // 200 (login page) or any non-network response means the server is up.
      if (res.status > 0) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`server did not respond at ${BASE}/login within ${timeoutMs}ms`);
}

// Playwright is optional in node_modules; install on demand (chromium is
// already cached under ~/.cache/ms-playwright on the maintainer's box).
async function loadPlaywright() {
  try { return (await import('playwright')).chromium; }
  catch {
    log('· playwright not found — installing (npm i playwright --no-save)…');
    const r = spawnSync('npm', ['i', 'playwright', '--no-save'], { cwd: REPO, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('npm i playwright failed');
    return (await import('playwright')).chromium;
  }
}

async function main() {
  // 1) migrate + seed the isolated DB
  log('→ migrating temp DB:', DB_PATH);
  runNode(['scripts/migrate.mjs'], 'migrate');
  log('→ seeding fictitious data');
  runNode(['scripts/demo-seed.mjs'], 'demo-seed');

  // 2) spawn the hub on the test port, reusing .next
  if (!existsSync(join(REPO, '.next', 'BUILD_ID'))) {
    throw new Error('.next/BUILD_ID missing — run `npm run build` first');
  }
  log(`→ starting hub on ${BASE} (NODE_ENV=production, autoconnect off)`);
  hub = spawn('node', ['server.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CHARON_DISABLE_AUTOCONNECT: '1',
      DATABASE_URL: DB_PATH,
      PORT: String(PORT),
      HOST,
      MASTER_PASSWORD: 'smoke-dummy-password',
      MASTER_SALT: 'smoke-dummy-salt',
      SESSION_SECRET: 'smoke-dummy-session-secret',
      SYNC_TOKEN: 'smoke-dummy-sync-token',
      VAPID_SUBJECT: 'mailto:demo@example.com',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  hub.on('exit', (code) => { if (code) log(`(hub exited with code ${code})`); });

  await waitForLogin();
  log('→ hub is up');

  // 3) Playwright assertions
  const chromium = await loadPlaywright();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies([COOKIE]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  // domcontentloaded ONLY — never networkidle (the SSE keeps the network busy).
  const open = (path = '/') =>
    page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 25000 });

  try {
    // ── LOGIN / AUTH: injected cookie authenticates; no redirect to /login.
    await assertAsync('AUTH: GET / does not redirect to /login', async () => {
      await open('/');
      await page.waitForLoadState('domcontentloaded');
      const u = page.url();
      if (u.includes('/login')) throw new Error(`redirected to ${u}`);
    });

    await assertAsync('AUTH: the Charon shell renders (sidebar present)', async () => {
      // Sidebar VPS-box / folder tree uses cs-* classes; fall back to any seeded text.
      await page.locator('.cs-folder, .cs-vps, [class*="sidebar"], [class*="Sidebar"]')
        .first().waitFor({ timeout: 15000 });
    });

    // ── DASHBOARD: a seeded session name is visible in the sidebar.
    await assertAsync("DASHBOARD: seeded session 'refactor auth middleware' visible", async () => {
      await page.getByText('refactor auth middleware', { exact: false })
        .first().waitFor({ timeout: 15000 });
    });

    // ── SESSION view: clicking it renders the conversation.
    await assertAsync("SESSION: clicking it shows 'Refactor the auth middleware' text", async () => {
      await page.getByText('refactor auth middleware', { exact: false }).first().click();
      await page.getByText('Refactor the auth middleware', { exact: false })
        .first().waitFor({ timeout: 15000 });
    });

    // ── ADD VPS: POST /api/vps with the cookie, attach a session row so the
    //    sidebar (which only shows a VPS that has a visible session/shell)
    //    renders it, then reload and assert it appears.
    const VPS_NAME = 'smoke-fixture-vps';
    await assertAsync('ADD VPS: POST /api/vps creates a fictitious VPS', async () => {
      // Issue the POST from inside the page so it carries the auth cookie
      // exactly like the app does (the browser fetch credentials path).
      const body = await page.evaluate(async (name) => {
        const r = await fetch('/api/vps', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name, ip: '192.0.2.250', sshUser: 'smoke', sshPort: 22, defaultPath: '/srv/app' }),
        });
        if (!r.ok) throw new Error('POST /api/vps -> ' + r.status);
        return r.json();
      }, VPS_NAME);
      if (!body.id) throw new Error('no id in response');
      // Give the new VPS a visible session so the sidebar surfaces it.
      // (The sidebar hides VPSes with no visible session/shell — see Sidebar.tsx.)
      const { default: Database } = await import('better-sqlite3');
      const sdb = new Database(DB_PATH);
      const now = Math.floor(Date.now() / 1000);
      sdb.prepare(`INSERT INTO claude_sessions
        (id,claude_session_id,vps_id,cwd,name,status,permission_mode,created_at,last_used_at,color,model,effort,sleep_requested)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`)
        .run('s_smoke', 'uuid-s_smoke', body.id, '/srv/app', 'smoke session probe',
             'active', 'normal', now - 60, now - 10, '#7c9cff', 'claude-opus-4-8', 'high');
      sdb.close();
    });

    await assertAsync(`ADD VPS: '${VPS_NAME}' appears in the sidebar after reload`, async () => {
      await open('/');
      await page.getByText(VPS_NAME, { exact: false }).first().waitFor({ timeout: 15000 });
    });

    // ── SHELL: a seeded shell entry is visible; the +shell affordance is usable.
    await assertAsync("SHELL: seeded shell 'deploy log' entry visible in sidebar", async () => {
      await page.getByText('deploy log', { exact: false }).first().waitFor({ timeout: 15000 });
    });

    await assertAsync('SHELL: a +shell affordance exists and is enabled', async () => {
      // Per-VPS or global "+Shell" button. Match loosely; only require one to be present + enabled.
      const btn = page.getByRole('button', { name: /shell/i }).first();
      await btn.waitFor({ timeout: 8000 });
      if (await btn.isDisabled()) throw new Error('+shell button is disabled');
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ── run with guaranteed teardown ─────────────────────────────────────────
let exitCode = 1;
try {
  await main();
  exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  failed++; // count the fatal as a failure for the summary
  log('✗ FATAL:', String(e && e.stack || e).slice(0, 500));
  exitCode = 1;
} finally {
  killHub();
  cleanupDb();
  const total = passed + failed;
  log(`\nSMOKE: ${passed}/${total} passed`);
  // Give SIGKILL timers / sockets a tick, then exit deterministically.
  await sleep(200);
  process.exit(exitCode);
}
