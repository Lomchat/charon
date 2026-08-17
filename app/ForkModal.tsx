'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentKind } from '@/lib/types/api';
import AgentLogo from './AgentLogo';

type Props = {
  sourceKind: AgentKind;
  sessionId: string;
  sourceName: string;
  vpsName?: string | null;
  codexAvailable: boolean;
  busy: AgentKind | null;
  error: string | null;
  onChoose: (kind: AgentKind, options?: { lastTurnId?: string; cutoffMessageId?: number; replacementPrompt?: string }) => void;
  onClose: () => void;
};

export default function ForkModal({
  sourceKind, sessionId, sourceName, vpsName, codexAvailable, busy, error, onChoose, onClose,
}: Props) {
  type Point = { turnId: string; previousTurnId?: string | null; prompt: string; messageId?: number | null; cutoffId?: number | null; createdAt?: number };
  const [points, setPoints] = useState<Point[] | null>(null);
  const [pointIndex, setPointIndex] = useState(-1);
  const [editPrompt, setEditPrompt] = useState(false);
  const [replacement, setReplacement] = useState('');
  useEffect(() => {
    let live = true;
    fetch(`/api/claude/sessions/${sessionId}/fork`).then((r) => r.json()).then((data) => {
      if (live) setPoints(Array.isArray(data?.points) ? data.points : []);
    }).catch(() => { if (live) setPoints([]); });
    return () => { live = false; };
  }, [sessionId]);
  const selected = useMemo(() => pointIndex >= 0 ? points?.[pointIndex] ?? null : null, [pointIndex, points]);
  const choose = (kind: AgentKind) => {
    if (!selected) return onChoose(kind);
    if (editPrompt) {
      if (!selected.previousTurnId || selected.messageId == null) return;
      return onChoose(kind, { lastTurnId: selected.previousTurnId,
        cutoffMessageId: Math.max(0, selected.messageId - 1), replacementPrompt: replacement.trim() });
    }
    onChoose(kind, { lastTurnId: selected.turnId,
      ...(selected.cutoffId != null ? { cutoffMessageId: selected.cutoffId } : {}) });
  };
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
        <p className="fork-intro">Choose the exact context, then the agent that should continue it.</p>
        <label className="nw-field"><span>Branch point</span>
          <select value={pointIndex} disabled={!!busy || points == null} onChange={(e) => {
            const index = Number(e.target.value); setPointIndex(index); setEditPrompt(false);
            setReplacement(index >= 0 ? points?.[index]?.prompt ?? '' : '');
          }}>
            <option value={-1}>End of conversation</option>
            {(points ?? []).map((point, index) => <option value={index} key={point.turnId}>
              {new Date((point.createdAt ?? 0) * 1000).toLocaleString()} · {point.prompt.slice(0, 90)}
            </option>)}
          </select>
        </label>
        {selected && <>
          <label className="fork-edit-toggle"><input type="checkbox" checked={editPrompt}
            disabled={!!busy || !selected.previousTurnId}
            onChange={(e) => setEditPrompt(e.target.checked)} /> Edit this prompt in the new branch</label>
          {editPrompt && <textarea className="fork-edit-prompt" rows={5} value={replacement}
            onChange={(e) => setReplacement(e.target.value)} />}
          {!selected.previousTurnId && <p className="fork-note">The first prompt can be forked after its answer, but cannot be edited in place.</p>}
        </>}
        <div className="fork-choices">
          <button
            type="button"
            className="fork-choice"
            autoFocus
            onClick={() => choose('claude')}
            disabled={!!busy || (editPrompt && !replacement.trim())}
          >
            <AgentLogo kind="claude" size={28} />
            <span className="fork-choice-copy">
              <b>Claude</b>
              <small>{sourceKind === 'claude'
                ? 'Native transcript fork · same model settings'
                : 'Imports the complete transcript through VPS handoff files'}</small>
            </span>
            <span className="fork-choice-go">{busy === 'claude' ? '…' : '→'}</span>
          </button>
          <button
            type="button"
            className="fork-choice"
            disabled={!!busy || !codexAvailable || (editPrompt && !replacement.trim())}
            onClick={() => choose('codex')}
          >
            <AgentLogo kind="codex" size={28} />
            <span className="fork-choice-copy">
              <b>Codex</b>
              <small>{codexAvailable
                ? (sourceKind === 'codex' ? 'Native Codex thread fork' : 'Imports the conversation into a new Codex thread')
                : `Unavailable${vpsName ? ` on ${vpsName}` : ' on this VPS'}`}</small>
            </span>
            <span className="fork-choice-go">{busy === 'codex' ? '…' : '→'}</span>
          </button>
        </div>
        <p className="fork-note">The current session keeps running untouched.</p>
        {error && <p className="confirm-err">{error}</p>}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}
