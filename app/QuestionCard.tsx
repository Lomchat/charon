'use client';
import { useState } from 'react';

export type QuestionItem = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

type Props = {
  questions: QuestionItem[];
  onAnswer: (answers: Record<string, string>) => void;
  onCancel: () => void;
};

// Card displayed when Claude calls AskUserQuestion. For each question,
// the user clicks an option (or several if multiSelect), OR types a free
// answer in the textarea (which overrides the click).
// The return is { question_text: "label1, label2" } or { question_text: "free text" }.
export default function QuestionCard({ questions, onAnswer, onCancel }: Props) {
  const [selections, setSelections] = useState<Record<number, Set<string>>>(() => {
    const init: Record<number, Set<string>> = {};
    questions.forEach((_, i) => { init[i] = new Set(); });
    return init;
  });
  const [customs, setCustoms] = useState<Record<number, string>>({});

  function toggle(qIdx: number, label: string, multi: boolean) {
    setSelections((prev) => {
      const next = { ...prev };
      const cur = new Set(prev[qIdx] ?? new Set<string>());
      if (multi) {
        if (cur.has(label)) cur.delete(label); else cur.add(label);
      } else {
        cur.clear();
        cur.add(label);
      }
      next[qIdx] = cur;
      return next;
    });
  }

  function answerForQuestion(qIdx: number): string | null {
    const custom = (customs[qIdx] ?? '').trim();
    if (custom) return custom;
    const sel = selections[qIdx];
    if (!sel || sel.size === 0) return null;
    return Array.from(sel).join(', ');
  }

  const allAnswered = questions.every((_, i) => !!answerForQuestion(i));

  function submit() {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const a = answerForQuestion(i);
      if (a) answers[q.question] = a;
    });
    onAnswer(answers);
  }

  return (
    <div className="user-question-card">
      <header className="uq-card-head">
        <span className="uq-tag">❓ question{questions.length > 1 ? `s × ${questions.length}` : ''}</span>
        <span className="uq-sub">choose an option or write your own answer</span>
      </header>
      <div className="uq-body">
        {questions.map((q, qIdx) => {
          const multi = !!q.multiSelect;
          const sel = selections[qIdx] ?? new Set<string>();
          const customVal = customs[qIdx] ?? '';
          const hasCustom = customVal.trim().length > 0;
          return (
            <div key={qIdx} className="uq-question">
              {q.header && <div className="uq-header">{q.header}</div>}
              <div className="uq-text">{q.question}</div>
              {multi && <div className="uq-multi-hint">multiple choice (☑)</div>}
              <div className={`uq-options${hasCustom ? ' dimmed' : ''}`}>
                {q.options.map((opt) => {
                  const on = sel.has(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={`uq-option${on ? ' selected' : ''}${multi ? ' multi' : ''}`}
                      onClick={() => toggle(qIdx, opt.label, multi)}
                    >
                      <span className="uq-radio">{multi ? (on ? '☑' : '☐') : (on ? '◉' : '◯')}</span>
                      <span className="uq-label">{opt.label}</span>
                      {opt.description && <span className="uq-desc">{opt.description}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="uq-custom">
                <label className="uq-custom-label">or free answer:</label>
                <textarea
                  className="uq-custom-input"
                  placeholder="type your own answer — it will be used instead of the options"
                  value={customVal}
                  onChange={(e) => setCustoms((c) => ({ ...c, [qIdx]: e.target.value }))}
                  rows={2}
                />
              </div>
            </div>
          );
        })}
      </div>
      <footer className="uq-actions">
        <button type="button" className="uq-cancel" onClick={onCancel}>cancel</button>
        <button type="button" className="uq-submit" onClick={submit} disabled={!allAnswered}>
          send
        </button>
      </footer>
    </div>
  );
}
