// Screenshot capture for the README. Demo hub must be up on :10999 (demo.db).
// 100% fictitious data. Output → docs/screenshots/.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:10999';
const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
const COOKIE = {
  name: 'charon_session', value: 'demo-session-screenshot',
  domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();

async function shot(ctxOpts, fn, file) {
  const context = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 2, ...ctxOpts });
  await context.addCookies([COOKIE]);
  const page = await context.newPage();
  try { await fn(page); } catch (e) { console.log('  (step warn)', file, String(e).slice(0, 120)); }
  try { await page.screenshot({ path: `${OUT}/${file}` }); console.log('✓', file); }
  catch (e) { console.log('✗', file, String(e).slice(0, 120)); }
  await context.close();
}

// `domcontentloaded` — NEVER networkidle (the SSE keeps the network busy forever).
async function open(page, path = '/') {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
}

// 1) Desktop dashboard — sidebar (VPS → Claude sessions + shells = dual use) + Claude chat + permission card
await shot({ viewport: { width: 1920, height: 1040 } }, async (page) => {
  await open(page);
  await page.getByText('refactor auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await page.getByText('refactor auth middleware', { exact: false }).first().click();
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 10000 });
  await sleep(1800);
}, 'dashboard.png');

// 2) Claude chat close-up — the discussion view
await shot({ viewport: { width: 1680, height: 1040 } }, async (page) => {
  await open(page);
  await page.getByText('refactor auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await page.getByText('refactor auth middleware', { exact: false }).first().click();
  await page.getByText('Refactor the auth middleware', { exact: false }).first().waitFor({ timeout: 10000 });
  await sleep(2000);
}, 'claude-chat.png');

// 3) Shell — a real live terminal on the isolated demo agent
await shot({ viewport: { width: 1920, height: 1040 } }, async (page) => {
  await open(page);
  await page.getByText('sandbox shell', { exact: false }).first().waitFor({ timeout: 12000 });
  await page.getByText('sandbox shell', { exact: false }).first().click();
  await page.locator('.xterm').first().waitFor({ timeout: 10000 });
  await sleep(2500); // WS connect + replay
  await page.locator('.xterm').first().click();
  const cmds = [
    "export PS1='\\[\\e[38;5;75m\\]deploy@sandbox\\[\\e[0m\\]:\\[\\e[38;5;150m\\]\\w\\[\\e[0m\\]$ '",
    'clear', 'cd ~/app', 'ls -la', 'cat package.json',
    'echo "› tsc: 0 errors, 124 files"', 'tail -n 5 deploy.log',
  ];
  for (const c of cmds) { await page.keyboard.type(c); await page.keyboard.press('Enter'); await sleep(750); }
  await sleep(1200);
}, 'shell.png');

// 4) Mobile — the single responsive UI at a phone width. The sidebar / session
//    list is an off-canvas drawer opened with the ☰ header button; the chat is
//    full-screen once a session is picked (selecting closes the drawer).
await shot({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true }, async (page) => {
  await open(page, '/');
  await page.getByLabel('open navigation').click({ timeout: 12000 }).catch(() => {});
  await page.getByText('refactor auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await sleep(1500);
}, 'mobile-select.png');

await shot({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true }, async (page) => {
  await open(page, '/');
  await page.getByLabel('open navigation').click({ timeout: 12000 }).catch(() => {});
  await page.getByText('refactor auth middleware', { exact: false }).first().waitFor({ timeout: 12000 });
  await page.getByText('refactor auth middleware', { exact: false }).first().click();
  await sleep(2200);
}, 'mobile-chat.png');

await browser.close();
console.log('done');
