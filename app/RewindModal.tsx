'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function RewindModal({ busy, error, onConfirm, onClose }: {
  busy: boolean;
  error: string | null;
  onConfirm: (turns: number) => void;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState(1);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);
  const body = (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="claude-modal fork-modal" role="dialog" aria-modal="true" aria-labelledby="rewind-title">
        <div className="fork-head">
          <div><h2 id="rewind-title">Rewind Codex history</h2><p>Remove recent turns from model context</p></div>
          <button type="button" className="modal-close" disabled={busy} onClick={onClose}>×</button>
        </div>
        <label className="nw-field">
          <span>Turns to remove</span>
          <input type="number" min={1} max={100} value={turns}
            onChange={(e) => setTurns(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
        </label>
        <p className="fork-note">Conversation history is removed from Codex and Charon. File changes are not reverted.</p>
        {error && <p className="confirm-err">{error}</p>}
        <div className="confirm-actions">
          <button type="button" onClick={onClose} disabled={busy}>cancel</button>
          <button type="button" className="danger" onClick={() => onConfirm(turns)} disabled={busy}>
            {busy ? 'rewinding…' : `rewind ${turns} turn${turns > 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(body, document.body);
}
