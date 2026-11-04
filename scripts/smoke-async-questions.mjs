// Isolated browser fixtures: live Codex transport is tested separately on a VPS.
import Database from 'better-sqlite3';

export async function smokeAsyncQuestions({ page, open, dbPath, assertAsync }) {
  const db = new Database(dbPath);
  const sid = 'smoke-async-questions';
  const now = Math.floor(Date.now() / 1000);
  const vpsId = db.prepare('SELECT vps_id FROM agent_sessions LIMIT 1').get().vps_id;
  db.prepare(`INSERT INTO agent_sessions (id,vps_id,cwd,name,status,kind,permission_mode)
    VALUES (?,?,?,'async question smoke','active','codex','read-only')`).run(sid, vpsId, '/tmp');
  const questions = [{ question: 'Which colour?', options: [{ label: 'Orange' }, { label: 'Purple' }] },
    { question: 'Anything else?', options: [] }];
  const insert = db.prepare(`INSERT INTO session_messages (session_id,role,content,created_at,ts_ms)
    VALUES (?,?,?,?,?)`);
  const form = (id, at) => {
    db.prepare(`INSERT INTO session_pending_questions (id,session_id,kind,payload,status,created_at)
      VALUES (?,?,'async_question',?,'pending',?)`).run(id, sid, JSON.stringify(questions), at);
    insert.run(sid, 'async_question', JSON.stringify({ id, questions }), at, at * 1000);
  };
  form('smoke-old-question', now - 1000);
  for (let i = 0; i < 205; i++) insert.run(sid, 'assistant', `Independent work ${i}`, now - 900 + i, (now - 900 + i) * 1000);
  form('smoke-new-question', now - 500);
  let attempts = 0;
  let failNext = true;
  const errors = [];
  const onError = (e) => errors.push(e.message);
  page.on('pageerror', onError);
  await page.route(`**/api/sessions/${sid}/question`, async (route) => {
    attempts++;
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated delivery failure' }) });
      return;
    }
    const { id, answers } = route.request().postDataJSON();
    db.prepare('UPDATE session_pending_questions SET status=?,answers=?,responded_at=? WHERE id=? AND session_id=?')
      .run(answers ? 'answered' : 'cancelled', JSON.stringify(answers), now, id, sid);
    insert.run(sid, 'event', JSON.stringify({ type: 'interaction_resolved', kind: 'question', id,
      outcome: answers ? 'answered' : 'cancelled', answers }), now, Date.now());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  try {
    await open(`/?session=${sid}`);
    // The transcript keeps a READ-ONLY bubble per question; the one form is
    // the strip above the composer (AsyncQuestionStrip.tsx, sync refonte C09).
    const strip = page.locator('[data-async-strip]');
    const stripForm = (id) => strip.locator(`[data-question-id="${id}"]`);
    const newBubble = page.locator('.app-chat [data-question-id="smoke-new-question"]');
    const oldBubble = page.locator('.app-chat [data-question-id="smoke-old-question"]');
    const showInTranscript = strip.getByRole('button', { name: /show in transcript/ });
    const assertReadOnly = async (bubble, label) => {
      if (await bubble.locator('input:enabled, textarea:enabled').count()) throw new Error(`${label} bubble editable while pending`);
      await bubble.locator('.uq-state').filter({ hasText: 'awaiting your answer' }).waitFor();
    };
    await assertAsync('ASYNC: strip sits above a usable composer, the bubble is read-only, both survive reload', async () => {
      await newBubble.waitFor();
      await stripForm('smoke-old-question').waitFor();
      await page.locator('.app-input-bar textarea').waitFor();
      if (await page.locator('.app-pending-zone:not([data-async-strip] *)').count()) throw new Error('async form replaced composer');
      const above = await page.evaluate(() => {
        const s = document.querySelector('[data-async-strip]'), c = document.querySelector('.app-input-bar');
        return !!s && !!c && !!(s.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      if (!above) throw new Error('strip is not above the composer');
      await assertReadOnly(newBubble, 'new');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await newBubble.waitFor();
      await strip.waitFor();
      if (!((await strip.innerText()).includes('2 questions'))) throw new Error('pending count lost');
    });
    await assertAsync('ASYNC: "show in transcript" loads older pages, scrolls and focuses the oldest question', async () => {
      if (await oldBubble.count()) throw new Error('old question should be outside initial history page');
      await showInTranscript.click();
      await oldBubble.waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-question-id') === 'smoke-old-question');
      const visible = await oldBubble.evaluate((el) => {
        const box = el.getBoundingClientRect(), chat = el.closest('.app-chat').getBoundingClientRect();
        return box.top >= chat.top && box.top < chat.bottom;
      });
      if (!visible) throw new Error('show in transcript did not reveal the question');
      await assertReadOnly(oldBubble, 'old');
    });
    await assertAsync('ASYNC: free answer overrides choices; failed validation retains form and selections', async () => {
      const oldForm = stripForm('smoke-old-question');
      const submit = oldForm.getByRole('button', { name: 'validate answers' });
      if (!(await submit.isDisabled())) throw new Error('incomplete form enabled');
      await oldForm.getByRole('button', { name: 'Orange', exact: false }).click();
      await oldForm.locator('textarea').nth(0).fill('Custom orange, with a comma');
      await oldForm.locator('textarea').nth(1).fill('Keep working independently');
      await submit.click();
      await oldForm.getByRole('alert').waitFor();
      if ((await oldForm.locator('textarea').first().inputValue()) !== 'Custom orange, with a comma') throw new Error('draft lost');
      if (await oldBubble.locator('.uq-state').filter({ hasText: 'answered' }).count()) throw new Error('failed response marked resolved');
      await submit.click();
      await oldBubble.locator('.uq-state').filter({ hasText: 'answered' }).waitFor();
      if (!(await oldBubble.innerText()).includes('Custom orange, with a comma')) throw new Error('answer missing');
      if (attempts !== 2) throw new Error('unexpected validation count');
    });
    await assertAsync('ASYNC: mobile choices validate once, retain answers and remove the strip', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const newForm = stripForm('smoke-new-question');
      await newForm.waitFor();
      await newForm.getByRole('button', { name: 'Purple', exact: false }).click();
      await newForm.locator('textarea').nth(1).fill('Mobile answer');
      await newForm.getByRole('button', { name: 'validate answers' }).click();
      await newBubble.locator('.uq-state').filter({ hasText: 'answered' }).waitFor();
      await strip.waitFor({ state: 'detached' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await newBubble.locator('.uq-state').filter({ hasText: 'answered' }).waitFor();
      if (await newBubble.locator('button').count()) throw new Error('resolved bubble still actionable');
      if (!(await newBubble.innerText()).includes('Mobile answer')) throw new Error('answer lost on reload');
    });
    await assertAsync('ASYNC: resolved forms hydrate across history pages without browser exceptions', async () => {
      // Reload may paint the already-paginated browser cache immediately.
      if (!(await oldBubble.count())) {
        await page.locator('.app-chat').evaluate((el) => { el.scrollTop = -el.scrollHeight; });
      }
      await oldBubble.locator('.uq-state').filter({ hasText: 'answered' }).waitFor();
      if (!(await oldBubble.innerText()).includes('Custom orange, with a comma')) throw new Error('old answer not hydrated');
      if (errors.length) throw new Error(errors.join('; '));
    });
  } finally {
    page.off('pageerror', onError);
    await page.unroute(`**/api/sessions/${sid}/question`);
    db.close();
  }
}
