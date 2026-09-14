'use client';
import PickerControl from './PickerControl';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { providerName, providerText } from '@/lib/providerText';
import { SESSION_PROVIDERS } from '@/lib/sessionCapabilities';
import { backendAvailability } from './vpsHealth';
import type { AgentKind } from '@/lib/types/api';
import AgentLogo from './AgentLogo';

type Props = {
  sourceKind: AgentKind;
  sessionId: string;
  sourceName: string;
  vpsName?: string | null;
  /** The VPS row, so availability is read per provider from the registry
   *  (§14.102) instead of one boolean per backend added by hand. */
  vps?: { agentStatus?: string | null } | null;
  busy: AgentKind | null;
  error: string | null;
  onChoose: (kind: AgentKind, options?: { lastTurnId?: string; cutoffMessageId?: number; replacementPrompt?: string }) => void;
  onClose: () => void;
};

export default function ForkModal({
  sourceKind, sessionId, sourceName, vpsName, vps, busy, error, onChoose, onClose,
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
          <PickerControl value={pointIndex} disabled={!!busy || points == null} onValueChange={(nextValue) => {
            const index = Number(nextValue); setPointIndex(index); setEditPrompt(false);
            setReplacement(index >= 0 ? points?.[index]?.prompt ?? '' : '');
          }}>
            <option value={-1}>End of conversation</option>
            {(points ?? []).map((point, index) => <option value={index} key={point.turnId}>
              {new Date((point.createdAt ?? 0) * 1000).toLocaleString()} · {point.prompt.slice(0, 90)}
            </option>)}
          </PickerControl>
        </label>
        {selected && <>
          <label className="fork-edit-toggle"><input type="checkbox" checked={editPrompt}
            disabled={!!busy || !selected.previousTurnId}
            onChange={(e) => setEditPrompt(e.target.checked)} /> Edit this prompt in the new branch</label>
          {editPrompt && <textarea className="fork-edit-prompt" rows={5} value={replacement}
            onChange={(e) => setReplacement(e.target.value)} />}
          {!selected.previousTurnId && <p className="fork-note">The first prompt can be forked after its answer, but cannot be edited in place.</p>}
        </>}
        {/* One choice per declared backend (§14.102): the transports table
            already covers every pair, so the modal must offer every target or
            a backend silently becomes un-forkable-to. */}
        <div className="fork-choices">
          {SESSION_PROVIDERS.map((target, i) => {
            const av = vps ? backendAvailability(vps as any, target) : { ok: true, reason: '' };
            const unavailable = !av.ok;
            return (
              <button
                key={target}
                type="button"
                className="fork-choice"
                autoFocus={i === 0}
                disabled={!!busy || unavailable || (editPrompt && !replacement.trim())}
                onClick={() => choose(target)}
              >
                <AgentLogo kind={target} size={28} />
                <span className="fork-choice-copy">
                  <b>{providerName(target)}</b>
                  <small>{unavailable
                    ? `${av.reason}${vpsName ? ` on ${vpsName}` : ' on this VPS'}`
                    : providerText.forkChoice(sourceKind, target)}</small>
                </span>
                <span className="fork-choice-go">{busy === target ? '…' : '→'}</span>
              </button>
            );
          })}
        </div>
        <p className="fork-note">The current session keeps running untouched. The branch inherits its
          notification rules, plus the model and effort the chosen agent can still honour.</p>
        {error && <p className="confirm-err">{error}</p>}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}
