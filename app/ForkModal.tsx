'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { AgentKind } from '@/lib/types/api';
import AgentLogo from './AgentLogo';

type Props = {
  sourceName: string;
  vpsName?: string | null;
  codexAvailable: boolean;
  busy: AgentKind | null;
  error: string | null;
  onChoose: (kind: AgentKind) => void;
  onClose: () => void;
};

export default function ForkModal({
  sourceName, vpsName, codexAvailable, busy, error, onChoose, onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const body = (
    <div className="claude-modal-bg" onClick={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className="claude-modal fork-modal" role="dialog" aria-modal="true" aria-labelledby="fork-title">
        <div className="fork-head">
          <div>
            <h2 id="fork-title">Fork conversation</h2>
            <p>{sourceName}</p>
          </div>
          <button type="button" className="modal-close" aria-label="close" disabled={!!busy} onClick={onClose}>×</button>
        </div>
        <p className="fork-intro">Choose which agent should continue with this history.</p>
        <div className="fork-choices">
          <button
            type="button"
            className="fork-choice"
            autoFocus
            disabled={!!busy}
            onClick={() => onChoose('claude')}
          >
            <AgentLogo kind="claude" size={28} />
            <span className="fork-choice-copy">
              <b>Claude</b>
              <small>Native transcript fork · same model settings</small>
            </span>
            <span className="fork-choice-go">{busy === 'claude' ? '…' : '→'}</span>
          </button>
          <button
            type="button"
            className="fork-choice"
            disabled={!!busy || !codexAvailable}
            onClick={() => onChoose('codex')}
          >
            <AgentLogo kind="codex" size={28} />
            <span className="fork-choice-copy">
              <b>Codex</b>
              <small>{codexAvailable
                ? 'Imports the conversation into a new Codex thread'
                : `Unavailable${vpsName ? ` on ${vpsName}` : ' on this VPS'}`}</small>
            </span>
            <span className="fork-choice-go">{busy === 'codex' ? '…' : '→'}</span>
          </button>
        </div>
        <p className="fork-note">The current Claude session keeps running untouched.</p>
        {error && <p className="confirm-err">{error}</p>}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}
