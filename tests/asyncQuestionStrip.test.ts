import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AsyncQuestionStrip, {
  ComposerWithAsyncStrip, asyncQuestionTitle, asyncStripFoldKey, revealAsyncQuestionStrip,
} from '@/app/AsyncQuestionStrip';
import AsyncQuestionBubble from '@/app/AsyncQuestionBubble';
import { isPendingFolded, setPendingFolded } from '@/app/PendingZone';
import type { Msg, PendingQuestion } from '@/app/sessionTypes';

// The vitest transform is classic JSX: components without a React import
// (icons, AgentLogo, the strip) read the global.
(globalThis as { React?: typeof React }).React = React;

const question = (id: string, createdAt: number, text: string, extra: Partial<PendingQuestion> = {}): PendingQuestion => ({
  id, sessionId: 's', createdAt, delivery: 'async',
  questions: [{ question: text, options: [{ label: 'Yes' }, { label: 'No' }] }],
  ...extra,
});

const strip = (questions: PendingQuestion[]) => createElement(AsyncQuestionStrip, {
  questions, onRespond: vi.fn(async () => {}), onShowInTranscript: vi.fn(),
});

afterEach(() => {
  for (const id of ['q-old', 'q-new']) setPendingFolded(asyncStripFoldKey(id), false);
});

describe('AsyncQuestionStrip', () => {
  it('renders the count and the oldest question\'s title, the oldest expanded and editable', () => {
    const html = renderToStaticMarkup(strip([
      question('q-new', 20, 'Second question?'),
      question('q-old', 10, 'Which colour?'),
    ]));
    expect(html).toContain('data-async-strip');
    expect(html).toContain('❓ 2 questions from the agent');
    expect(html).toContain('Which colour?');
    // Only the oldest carries the form.
    expect(html).toMatch(/data-question-id="q-old"/);
    expect(html).not.toMatch(/data-question-id="q-new"/);
    expect(html).toMatch(/data-queued-question-id="q-new"/);
    expect(html).toContain('↑ show in transcript');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('Pending questions');
  });

  it('sits ABOVE the composer and above the Resume CTA', () => {
    const qs = [question('q-old', 10, 'Which colour?')];
    for (const slot of [
      createElement('div', { className: 'app-disconnect-cta' }, createElement('button', null, '↺ RESUME THIS SESSION')),
      createElement('div', { className: 'app-input-bar' }, createElement('textarea')),
    ]) {
      const html = renderToStaticMarkup(createElement(ComposerWithAsyncStrip, { strip: strip(qs), children: slot }));
      const stripAt = html.indexOf('data-async-strip');
      const slotAt = Math.max(html.indexOf('app-disconnect-cta'), html.indexOf('app-input-bar'));
      expect(stripAt).toBeGreaterThanOrEqual(0);
      expect(slotAt).toBeGreaterThan(stripAt);
    }
  });

  it('renders nothing without async questions', () => {
    expect(renderToStaticMarkup(strip([]))).toBe('');
  });

  it('shows "sending…" and disables the form while an answer is delivering', () => {
    const html = renderToStaticMarkup(strip([question('q-old', 10, 'Which colour?', { delivering: true })]));
    expect(html).toContain('sending…');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
  });

  it('folds to one reminder line per question id; the transcript button unfolds it', () => {
    setPendingFolded(asyncStripFoldKey('q-old'), true);
    const html = renderToStaticMarkup(strip([question('q-old', 10, 'Which colour?')]));
    expect(html).toContain('is-collapsed');
    expect(html).toContain('❓ 1 question from the agent');
    expect(html).toContain('aria-expanded="false"');
    revealAsyncQuestionStrip('q-old');
    expect(isPendingFolded(asyncStripFoldKey('q-old'))).toBe(false);
  });

  it('titles are the first question, bounded', () => {
    expect(asyncQuestionTitle({ questions: [{ question: 'x'.repeat(300), options: [] }] })).toHaveLength(120);
  });
});

describe('AsyncQuestionBubble (transcript)', () => {
  const bubble = (content: object) => renderToStaticMarkup(createElement(AsyncQuestionBubble, {
    message: { id: 'question:q-old', role: 'async_question', content: JSON.stringify(content), createdAt: 1 } as Msg,
  }));

  it('is read-only while pending and points to the strip', () => {
    const html = bubble({ id: 'q-old', questions: [{ question: 'Which colour?', options: [{ label: 'Yes' }] }], status: 'pending' });
    expect(html).toContain('data-question-id="q-old"');
    expect(html).toContain('awaiting your answer — answer below ↓');
    expect(html).toContain('Which colour?');
    expect(html).not.toMatch(/<(textarea|input|fieldset)\b/);
    expect(html).not.toContain('validate answers');
  });

  it('shows the answers once resolved', () => {
    const html = bubble({ id: 'q-old', questions: [{ question: 'Which colour?', options: [] }],
      status: 'answered', answers: { 'Which colour?': 'Orange' } });
    expect(html).toContain('answered');
    expect(html).toContain('Orange');
    expect(html).not.toContain('answer below');
  });
});
