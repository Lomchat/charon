// Drives the chat scroller with real wheel events and records what the scroll
// offset actually does, so "it goes back down in a loop" can be measured
// instead of guessed at.
//
// Runs against the ISOLATED test hub (scripts/scroll-repro-seed.mjs), never the
// live one: opening `?session=` mutates the shared tab layout every device sees
// (§14.78).
//
// Reads: |scrollTop| is the distance from the visual BOTTOM (the scroller is
// column-reverse). Scrolling up must make it grow. Any sample where it drops
// while we are wheeling UP is the bug.
import { readFileSync } from 'node:fs';

// Playwright is not a dependency of this repo (same as scripts/demo-shots.mjs)
// — resolve it wherever the box happens to keep it rather than dying on an
// import a future reader can't diagnose.
const { chromium } = await import('playwright').catch(() =>
  import('/srv/tests/node_modules/playwright/index.mjs'),
);

const BASE = process.env.BASE || 'http://127.0.0.1:10991';
const SID = process.env.SID || 'scrolltest0000000000000000000001';
const TOKEN = (process.env.TOKEN || readFileSync('/tmp/scrolltoken', 'utf8')).trim();
const STEPS = Number(process.env.STEPS || 120);
const DELTA = Number(process.env.DELTA || -400); // negative = wheel up

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await ctx.addCookies([{ name: 'charon_session', value: TOKEN, domain: '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (/error|Error|jump/.test(t)) console.log('  [console]', t.slice(0, 160));
});

await page.goto(`${BASE}/?session=${SID}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.claude-chat .bubble', { timeout: 30_000 });
// A/B harness: inject a candidate fix as CSS and re-measure, so each theory is
// settled by the same number rather than by argument.
if (process.env.CSS) {
  await page.addStyleTag({ content: process.env.CSS });
  console.log(`[css] ${process.env.CSS}`);
}
await page.waitForTimeout(2500); // let the first window settle

const box = await page.locator('.claude-chat').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

const samples = [];
for (let i = 0; i < STEPS; i++) {
  await page.mouse.wheel(0, DELTA);
  await page.waitForTimeout(60);
  samples.push(
    await page.evaluate(() => {
      const el = document.querySelector('.claude-chat');
      return {
        top: Math.abs(el.scrollTop),
        height: el.scrollHeight,
        client: el.clientHeight,
        bubbles: el.querySelectorAll('.bubble').length,
      };
    }),
  );
}

// A regression is a sample where the distance from the bottom DROPPED while we
// were scrolling up. Wheel deltas are ~DELTA px, so anything beyond a couple of
// pixels of rounding is the scroller moving on its own.
let regressions = 0;
let worst = 0;
let totalBack = 0;
for (let i = 1; i < samples.length; i++) {
  const d = samples[i].top - samples[i - 1].top;
  if (d < -2) {
    regressions++;
    totalBack += -d;
    if (-d > worst) worst = -d;
  }
}

const first = samples[0];
const last = samples[samples.length - 1];
console.log(`\nscrollHeight: ${first.height} → ${last.height}   bubbles: ${first.bubbles} → ${last.bubbles}`);
console.log(`distance from bottom: ${Math.round(first.top)} → ${Math.round(last.top)} (max ${Math.round(last.height - last.client)})`);
console.log(`BACKWARD JUMPS: ${regressions} / ${samples.length - 1} samples · worst ${Math.round(worst)}px · total ${Math.round(totalBack)}px`);

if (process.env.VERBOSE) {
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].top - samples[i - 1].top;
    console.log(
      `${String(i).padStart(3)}  top=${String(Math.round(samples[i].top)).padStart(7)}  d=${String(Math.round(d)).padStart(6)}` +
        `  H=${String(samples[i].height).padStart(7)}  n=${samples[i].bubbles}${d < -2 ? '   <-- BACK' : ''}`,
    );
  }
}

await browser.close();
process.exit(regressions > 0 ? 1 : 0);
