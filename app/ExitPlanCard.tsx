'use client';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Props = {
  plan: string;
  onApprove: () => void;
  onReject: (feedback: string) => void;
};

// Affichée quand Claude appelle ExitPlanMode : montre le plan en markdown,
// + bouton Approuver / Demander modifs (avec textarea).
export default function ExitPlanCard({ plan, onApprove, onReject }: Props) {
  const [askingFeedback, setAskingFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');

  return (
    <div className="exit-plan-card">
      <header className="ep-head">
        <span className="ep-tag">📋 plan prêt</span>
        <span className="ep-sub">Claude a fini de planifier — relis et choisis</span>
      </header>
      <div className="ep-content md">
        {plan ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        ) : (
          <div className="ep-empty">
            <em>Le plan a été écrit dans un fichier (voir messages au-dessus pour le contenu).</em>
          </div>
        )}
      </div>
      {!askingFeedback ? (
        <footer className="ep-actions">
          <button type="button" className="ep-reject" onClick={() => setAskingFeedback(true)}>
            demander des changements
          </button>
          <button type="button" className="ep-approve" onClick={onApprove}>
            approuver et exécuter
          </button>
        </footer>
      ) : (
        <div className="ep-feedback">
          <textarea
            placeholder="que veux-tu modifier dans le plan ?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={4}
            autoFocus
          />
          <div className="ep-feedback-actions">
            <button type="button" className="ep-cancel" onClick={() => { setAskingFeedback(false); setFeedback(''); }}>
              annuler
            </button>
            <button
              type="button"
              className="ep-send-feedback"
              onClick={() => onReject(feedback.trim() || 'Please revise the plan.')}
              disabled={!feedback.trim()}
            >
              envoyer le feedback
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
