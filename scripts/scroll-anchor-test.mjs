// Does the reader's position survive a bubble CHANGING HEIGHT elsewhere in the
// list? That is not a hypothetical: a turn ending swaps plain text for rendered
// markdown, an image finishes loading, a tool card gets expanded — all while
// someone is reading further up.
//
// Why it needs testing at all: CSS scroll anchoring computes its correction in
// the scroller's BLOCK FLOW direction, against the block-start edge of the
// scrolling content (css-scroll-anchoring-1 §2.2). `flex-direction:
// column-reverse` does NOT flip block flow — it only flips the scroll origin —
// so in this chat the browser's correction is computed against the edge that
// moves, on top of a layout that was already stable. The spec says nothing
// about reversed scrollers.
//
// Measures the offset before/after a mutation, above and below the viewport,
// with anchoring on and off.
import { readFileSync } from 'node:fs';
const { chromium } = await import('playwright').catch(() =>
  import('/srv/tests/node_modules/playwright/index.mjs'),
);

const BASE = process.env.BASE || 'http://127.0.0.1:10991';
const SID = process.env.SID || 'scrolltest0000000000000000000001';
const TOKEN = (process.env.TOKEN || readFileSync('/tmp/scrolltoken', 'utf8')).trim();

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function run(label, css) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addCookies([{ name: 'charon_session', value: TOKEN, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?session=${SID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.claude-chat .bubble', { timeout: 30_000 });
  if (css) await page.addStyleTag({ content: css });
  await page.waitForTimeout(2000);

  const box = await page.locator('.claude-chat').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(800);

  // Grow a bubble by 300px, on each side of the viewport in turn, and see
  // whether the offset the reader is sitting at survives it.
  const drift = await page.evaluate(async () => {
    const el = document.querySelector('.claude-chat');
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const vTop = el.getBoundingClientRect().top;
    const vBot = el.getBoundingClientRect().bottom;
    const all = [...el.querySelectorAll('.bubble')];
    const above = all.find((b) => b.getBoundingClientRect().bottom < vTop);
    const below = all.find((b) => b.getBoundingClientRect().top > vBot);
    const out = {};
    for (const [name, node] of [['above', above], ['below', below]]) {
      if (!node) { out[name] = null; continue; }
      const before = el.scrollTop;
      node.style.paddingBottom = '300px';
      await frame();
      out[name] = Math.round(Math.abs(el.scrollTop) - Math.abs(before));
      node.style.paddingBottom = '';
      await frame();
    }
    return out;
  });

  // …and the other invariant: pinned at the bottom must STAY pinned.
  const pinned = await page.evaluate(async () => {
    const el = document.querySelector('.claude-chat');
    el.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = el.querySelector('.bubble');
    b.style.paddingBottom = '200px';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const off = Math.round(Math.abs(el.scrollTop));
    b.style.paddingBottom = '';
    return off;
  });

  console.log(
    `${label.padEnd(26)} drift when a bubble ABOVE grows: ${String(drift.above).padStart(5)}px` +
      `   BELOW grows: ${String(drift.below).padStart(5)}px   still pinned at bottom: ${pinned === 0 ? 'yes' : `NO (${pinned}px)`}`,
  );
  await ctx.close();
}

await run('anchoring: default', null);
await run('overflow-anchor: none', '.claude-chat{overflow-anchor:none}');
await browser.close();
