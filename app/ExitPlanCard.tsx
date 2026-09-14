'use client';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { providerText } from '@/lib/providerText';
import type { AgentKind } from '@/lib/types/api';

type Props = {
  plan: string;
  onApprove: () => void;
  onReject: (feedback: string) => void;
  /** Which backend raised it. Only Claude has `exitPlan: 'native'` today, but a
   *  shared card must not be where that is assumed. */
  kind?: AgentKind | null;
};

// Displayed when Claude calls ExitPlanMode: shows the plan in markdown,
// + Approve / Request changes button (with textarea).
export default function ExitPlanCard({ plan, onApprove, onReject, kind }: Props) {
  const [askingFeedback, setAskingFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');

  return (
    <div className="exit-plan-card">
      <header className="ep-head">
        <span className="ep-tag">📋 plan ready</span>
        <span className="ep-sub">{providerText.planReady(kind)}</span>
      </header>
      <div className="ep-content md">
        {plan ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        ) : (
          <div className="ep-empty">
            <em>The plan was written to a file (see messages above for content).</em>
          </div>
        )}
      </div>
      {!askingFeedback ? (
        <footer className="ep-actions">
          <button type="button" className="ep-reject" onClick={() => setAskingFeedback(true)}>
            request changes
          </button>
          <button type="button" className="ep-approve" onClick={onApprove}>
            approve and execute
          </button>
        </footer>
      ) : (
        <div className="ep-feedback">
          <textarea
            placeholder="what would you like to change in the plan?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={4}
            autoFocus
          />
          <div className="ep-feedback-actions">
            <button type="button" className="ep-cancel" onClick={() => { setAskingFeedback(false); setFeedback(''); }}>
              cancel
            </button>
            <button
              type="button"
              className="ep-send-feedback"
              onClick={() => onReject(feedback.trim() || 'Please revise the plan.')}
              disabled={!feedback.trim()}
            >
              send feedback
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
