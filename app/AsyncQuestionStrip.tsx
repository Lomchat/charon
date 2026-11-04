'use client';
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { PendingQuestion } from './sessionTypes';
import QuestionCard from './QuestionCard';
import { isPendingFolded, setPendingFolded, subscribePendingFold } from './PendingZone';

/**
 * The ONE form of a session's async questions (Codex `agentMessage.questions`,
 * §14.96; sync refonte C09): a strip in the composer region, ABOVE the
 * blocking PendingZone / ChatInputBar and above the Resume CTA (answering
 * auto-resumes a sleeping session). It never replaces the composer — the
 * agent is not blocked by these.
 *
 * Oldest first; the oldest is EXPANDED by default with the only editable
 * QuestionCard, the others are one line each. Folded (per question id, in
 * PendingZone's module memory), it is one reminder line. The transcript keeps
 * a read-only bubble per question (AsyncQuestionBubble.tsx) whose button
 * unfolds this strip (`revealAsyncQuestionStrip`). Acks stay pessimistic: a
 * failed answer keeps the form and its draft (§14.18/§14.96).
 */

/** Fold key of the strip while `questionId` is its oldest question. */
export const asyncStripFoldKey = (questionId: string): string => `async:${questionId}`;

const revealListeners = new Set<() => void>();

/** Unfold the strip and bring it into view (the transcript bubble's button). */
export function revealAsyncQuestionStrip(questionId?: string): void {
  if (questionId) setPendingFolded(asyncStripFoldKey(questionId), false);
  for (const fn of [...revealListeners]) fn();
}

/** First question of a form, ≤120 chars — its title in the strip. */
export function asyncQuestionTitle(q: Pick<PendingQuestion, 'questions'>): string {
  const text = (q.questions?.[0]?.question ?? '').trim() || 'question';
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export function asyncQuestionCountLabel(n: number): string {
  return `❓ ${n} question${n === 1 ? '' : 's'} from the agent`;
}

/** The composer region: the strip first, then whatever holds the composer
 *  slot (Resume CTA, PendingZone or ChatInputBar). */
export function ComposerWithAsyncStrip({ strip, children }: { strip: ReactNode; children: ReactNode }) {
  return <>{strip}{children}</>;
}

export default function AsyncQuestionStrip({ questions, onRespond, onShowInTranscript, isJumping = false, vpsId, cwd }: {
  /** Pending ASYNC questions of the session (any order). */
  questions: PendingQuestion[];
  onRespond: (id: string, answers: Record<string, string> | null) => Promise<void>;
  /** Loads older pages until the transcript bubble is found, then highlights it. */
  onShowInTranscript: (id: string) => void;
  isJumping?: boolean;
  vpsId?: string;
  cwd?: string | null;
}) {
  const sorted = [...questions].sort((a, b) => a.createdAt - b.createdAt);
  const oldest = sorted[0] as PendingQuestion | undefined;
  const key = oldest ? asyncStripFoldKey(oldest.id) : '';
  const readFold = useCallback(() => !!key && isPendingFolded(key), [key]);
  const collapsed = useSyncExternalStore(subscribePendingFold, readFold, readFold);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onReveal = () => {
      if (key) setPendingFolded(key, false);
      rootRef.current?.scrollIntoView?.({ block: 'nearest' });
    };
    revealListeners.add(onReveal);
    return () => { revealListeners.delete(onReveal); };
  }, [key]);

  if (!oldest) return null;
  const n = sorted.length;
  const delivering = !!oldest.delivering;

  return (
    <div ref={rootRef} className={`pz-wrap question${collapsed ? ' is-collapsed' : ''}`} data-async-strip="">
      <button
        type="button"
        className="pz-toggle"
        aria-expanded={!collapsed}
        title={collapsed ? 'show the questions' : 'hide the questions — they keep waiting'}
        onClick={() => setPendingFolded(key, !collapsed)}
      >
        <span className="ci-grip-pill" aria-hidden="true" />
        {collapsed && (
          <span className="pz-reminder">
            <span className="pz-dot" aria-hidden="true" />
            {asyncQuestionCountLabel(n)}
            <span className="pz-hint">click to show</span>
          </span>
        )}
      </button>
      {/* Hidden, not unmounted: a half-filled answer survives the fold. */}
      <div className="app-pending-zone" hidden={collapsed}>
        <header className="uq-card-head">
          <span className="uq-tag">{asyncQuestionCountLabel(n)}</span>
          <span className="uq-sub">{delivering ? 'sending…' : asyncQuestionTitle(oldest)}</span>
        </header>
        <button type="button" className="pending-questions-link" disabled={isJumping}
          onClick={() => onShowInTranscript(oldest.id)}>
          {isJumping ? 'Finding question…' : '↑ show in transcript'}
        </button>
        <div data-question-id={oldest.id} aria-busy={delivering || undefined}>
          <fieldset className="uq-fields" disabled={delivering}>
            <QuestionCard key={oldest.id} inline questions={oldest.questions} vpsId={vpsId} cwd={cwd}
              onAnswer={(answers) => onRespond(oldest.id, answers)}
              onCancel={() => onRespond(oldest.id, null)} />
          </fieldset>
        </div>
        {sorted.slice(1).map((q) => (
          <div key={q.id} className="uq-sub" data-queued-question-id={q.id}>
            {q.delivering ? 'sending… ' : 'next: '}{asyncQuestionTitle(q)}
          </div>
        ))}
      </div>
    </div>
  );
}
