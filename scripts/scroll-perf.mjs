// What does `content-visibility: auto` on chat bubbles actually buy?
//
// It is the thing that makes scrolling back through history jump
// (scripts/scroll-repro.mjs), so the question is whether removing it costs
// enough to be worth engineering around. This measures the two things it is
// supposed to protect: frame times while scrolling a long transcript, and the
// layout cost of a big one.
import { chromium } from '/srv/tests/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:10991';
const SID = process.env.SID || 'scrolltest0000000000000000000001';
const TOKEN = (process.env.TOKEN || readFileSync('/tmp/scrolltoken', 'utf8')).trim();
const PAGES = Number(process.env.PAGES || 4); // pages of older history to pull in first

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function run(label, css) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addCookies([{ name: 'charon_session', value: TOKEN, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?session=${SID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.claude-chat .bubble', { timeout: 30_000 });
  if (css) await page.addStyleTag({ content: css });
  await page.waitForTimeout(2000);

  // Pull in a deep history first — content-visibility only claims to matter
  // once the list is long.
  const box = await page.locator('.claude-chat').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < PAGES * 30; i++) {
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(1500);

  const bubbles = await page.evaluate(() => document.querySelectorAll('.claude-chat .bubble').length);

  // Frame times over a sustained scroll, sampled in-page.
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (window.__frames.length < 400) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, i % 2 === 0 ? -500 : 500);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(500);

  const frames = await page.evaluate(() => window.__frames.slice(5));
  frames.sort((a, b) => a - b);
  const p = (q) => frames[Math.min(frames.length - 1, Math.floor(frames.length * q))];
  const long = frames.filter((f) => f > 50).length;

  // Cost of a full forced layout over the whole list.
  const layoutMs = await page.evaluate(() => {
    const el = document.querySelector('.claude-chat');
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      el.style.paddingTop = `${18 + (i % 2)}px`;
      void el.scrollHeight;
    }
    el.style.paddingTop = '';
    return (performance.now() - t0) / 20;
  });

  console.log(
    `${label.padEnd(28)} bubbles=${String(bubbles).padStart(4)}  ` +
      `frame p50=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms  ` +
      `>50ms: ${long}/${frames.length}  forced-layout=${layoutMs.toFixed(1)}ms`,
  );
  await ctx.close();
}

await run('content-visibility: auto', null);
await run('content-visibility: OFF', '.bubble{content-visibility:visible!important}');

await browser.close();
