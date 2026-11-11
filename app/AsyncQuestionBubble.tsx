'use client';
import { memo } from 'react';
import { parseAsyncQuestion } from '@/lib/asyncQuestions';
import type { Msg } from './sessionTypes';
import { LinkifiedText } from './Message';
import { revealAsyncQuestionStrip } from './AsyncQuestionStrip';
import { FoldEdge, FoldLine, foldRootProps, useBubbleFold } from './bubbleFold';

/** An async question in the transcript (§14.96). READ-ONLY: while pending it
 *  points to the one form, the strip above the composer
 *  (AsyncQuestionStrip.tsx); once resolved it shows the answers. */
export default memo(function AsyncQuestionBubble({ message, vpsId, cwd }: {
  message: Msg; vpsId?: string; cwd?: string | null;
}) {
  const isFolded = useBubbleFold(message.id);
  const q = parseAsyncQuestion(message.content);
  if (!q) return null;
  const resolved = !!q.status && q.status !== 'pending';
  return (
    <div className={`bubble role-question${resolved ? ' is-resolved' : ''}${isFolded ? ' is-folded' : ''}`}
      data-msg-role="question" data-question-id={q.id} tabIndex={-1} {...foldRootProps(message.id)}>
      <FoldEdge isFolded={isFolded} />
      <header className="bubble-h">
        <span className="tag">questions</span>
        <span className="uq-state">{resolved ? q.status === 'answered' ? 'answered' : q.status === 'unavailable' ? 'historical question' : 'dismissed' : 'awaiting your answer — answer below ↓'}</span>
        {isFolded && <FoldLine foldKey={message.id} text={q.questions.map((x) => x.question).join(' · ')}
          size={`${q.questions.length} question${q.questions.length === 1 ? '' : 's'}`} />}
      </header>
      <div className="uq-body">
        {q.questions.map((question, i) => (
          <div className="uq-question" key={i}>
            <div className="uq-text"><LinkifiedText text={question.question} vpsId={vpsId} cwd={cwd} /></div>
            {resolved && <div className="uq-answer">
              <LinkifiedText text={q.answers?.[question.question] ?? 'No answer'} vpsId={vpsId} cwd={cwd} />
            </div>}
          </div>
        ))}
      </div>
      {!resolved && (
        <button type="button" className="pending-questions-link"
          onClick={() => revealAsyncQuestionStrip(q.id)}>
          answer below <span aria-hidden>↓</span>
        </button>
      )}
    </div>
  );
});
