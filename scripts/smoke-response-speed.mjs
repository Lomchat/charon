// Browser regression for bursty reception: the provider transport is exercised
// separately. Inject events through the real singleton EventSource dispatcher.
import Database from 'better-sqlite3';

export async function smokeResponseSpeed({ page, open, dbPath, assertAsync }) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const db = new Database(dbPath);
  const vpsId = db.prepare('SELECT vps_id FROM agent_sessions LIMIT 1').get().vps_id;
  for (const provider of ['claude', 'codex', 'cursor']) {
    db.prepare(`INSERT INTO agent_sessions (id,vps_id,cwd,name,status,kind,permission_mode)
      VALUES (?,?,?,?,'thinking',?,?)`).run(`smoke-speed-${provider}`, vpsId, '/tmp',
      `Reception ${provider}`, provider, provider === 'claude' ? 'normal' : 'read-only');
  }
  db.close();
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const streams = new Set();
    window.EventSource = class extends NativeEventSource {
      constructor(...args) { super(...args); streams.add(this); }
      close() { streams.delete(this); super.close(); }
    };
    window.__receptionSmokeEmit = (event) => {
      for (const stream of streams) stream.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
    };
    localStorage.setItem('hub.claude.showTools.v1', '0');
  });

  for (const provider of ['claude', 'codex', 'cursor']) {
    await assertAsync(`RECEPTION ${provider}: SDK counters stay separate from received tools/reasoning`, async () => {
      const sessionId = `smoke-speed-${provider}`;
      await open(`/?session=${sessionId}`);
      const badge = page.locator('.thinking-bar .t-speed');
      await badge.waitFor();
      const sdkBadge = page.locator('.thinking-bar .t-sdk-speed');
      await page.waitForFunction(() => document.querySelector('.t-sdk-speed')?.textContent.includes('pending'));
      await page.evaluate((sid) => {
        window.__receptionSmokeEmit({ type: 'thinking', text: 'Reasoning fragment '.repeat(80), sessionId: sid });
        window.__receptionSmokeEmit({ type: 'tool_use', id: 'speed-tool', name: 'Bash', input: { command: 'echo test' }, sessionId: sid });
        window.__receptionSmokeEmit({ type: 'tool_progress', tool_use_id: 'speed-tool', delta: 'stdout '.repeat(200), sessionId: sid });
        window.__receptionSmokeEmit({ type: 'tool_result', tool_use_id: 'speed-tool', content: 'done '.repeat(200), is_error: false, sessionId: sid });
      }, sessionId);
      await page.waitForFunction(() => Number(document.querySelector('.t-speed')?.textContent.match(/([\d.]+) kB/)?.[1]) > 0);
      if (!(await sdkBadge.innerText()).includes('pending')) throw new Error('text/tool traffic invented a token count');
      await page.evaluate((sid) => {
        window.__receptionSmokeEmit({ type: 'usage', output_tokens: 120,
          sdk_throughput: { output_tokens: 120, elapsed_ms: 3000 }, sessionId: sid });
      }, sessionId);
      await page.waitForFunction(() => document.querySelector('.t-sdk-speed')?.textContent.includes('40.0 tok/s avg'));
      // Includes a full API poll and the reception window expiring.
      await page.waitForFunction(() => document.querySelector('.t-sdk-speed')?.textContent.includes('ago'));
      await page.waitForTimeout(2_500);
      if (!(await sdkBadge.innerText()).includes('40.0 tok/s avg')) throw new Error('SDK rate decayed without a new report');
      if (!(await badge.innerText()).includes('0.0 kB/s')) throw new Error('reception did not return to zero in silence');
      if (await page.locator('.thinking-bar .t-tool').count()) throw new Error('showTools fixture was not applied');
      await page.screenshot({ path: `/tmp/charon-reception-${provider}.png` });
    });
  }
  await assertAsync('RECEPTION: late final SDK report stays visible after stop', async () => {
    const sid = 'smoke-speed-cursor';
    const finishedDb = new Database(dbPath);
    finishedDb.prepare("UPDATE agent_sessions SET status='active' WHERE id=?").run(sid);
    finishedDb.close();
    await page.evaluate((sessionId) => {
      window.__receptionSmokeEmit({ type: 'stop', sessionId });
      window.__receptionSmokeEmit({ type: 'status', status: 'active', sessionId });
      window.__receptionSmokeEmit({ type: 'usage', output_tokens: 500, final: true,
        sdk_throughput: { output_tokens: 500, elapsed_ms: 10000 }, sessionId });
    }, sid);
    await page.waitForFunction(() => [...document.querySelectorAll('.turn-cost')].some((el) => el.textContent.includes('50.0 tok/s avg')));
    // Reopen an active fixture for the mobile layout assertion.
    await open('/?session=smoke-speed-codex');
    await page.locator('.thinking-bar .t-speed').waitFor();
    await page.evaluate(() => window.__receptionSmokeEmit({ type: 'usage', output_tokens: 120,
      sdk_throughput: { output_tokens: 120, elapsed_ms: 3000 }, sessionId: 'smoke-speed-codex' }));
    await page.waitForFunction(() => document.querySelector('.t-sdk-speed')?.textContent.includes('40.0 tok/s avg'));
  });
  await assertAsync('RECEPTION: mobile badge stays inside the thinking bar', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open('/?session=smoke-speed-codex');
    await page.locator('.thinking-bar .t-speed').waitFor();
    await page.evaluate(() => window.__receptionSmokeEmit({ type: 'usage', output_tokens: 120,
      sdk_throughput: { output_tokens: 120, elapsed_ms: 3000 }, sessionId: 'smoke-speed-codex' }));
    await page.waitForFunction(() => document.querySelector('.t-sdk-speed')?.textContent.includes('ago'));
    const badge = page.locator('.thinking-bar .t-sdk-speed');
    const bar = await page.locator('.thinking-bar').boundingBox();
    const box = await badge.boundingBox();
    if (!bar || !box || box.x < bar.x || box.x + box.width > bar.x + bar.width + 1
      || box.x < 0 || box.x + box.width > 390) throw new Error('badge overflows the bar or viewport');
    await page.screenshot({ path: '/tmp/charon-reception-mobile.png' });
    await page.setViewportSize({ width: 1600, height: 1000 });
  });
}
