'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type Kind = 'uncommittedChanges' | 'baseBranch' | 'commit' | 'custom';

export default function ReviewModal({ provider, busy, error, onConfirm, onClose }: {
  provider: 'Claude' | 'Codex';
  busy: boolean;
  error: string | null;
  onConfirm: (target: Record<string, unknown>, delivery: 'inline' | 'detached') => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>('uncommittedChanges');
  const [value, setValue] = useState('');
  const [delivery, setDelivery] = useState<'inline' | 'detached'>('inline');
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);
  const target = kind === 'baseBranch' ? { type: kind, branch: value.trim() }
    : kind === 'commit' ? { type: kind, sha: value.trim() }
      : kind === 'custom' ? { type: kind, instructions: value.trim() }
        : { type: kind };
  const needsValue = kind !== 'uncommittedChanges';
  const body = (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="claude-modal fork-modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <div className="fork-head">
          <div><h2 id="review-title">Start {provider} review</h2><p>Choose where the reviewer should work</p></div>
          <button type="button" className="modal-close" disabled={busy} onClick={onClose}>×</button>
        </div>
        <label className="nw-field"><span>Target</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setValue(''); }}>
            <option value="uncommittedChanges">Uncommitted changes</option>
            <option value="baseBranch">Compare with base branch</option>
            <option value="commit">Specific commit</option>
            <option value="custom">Custom instructions</option>
          </select>
        </label>
        {needsValue && <label className="nw-field"><span>{kind === 'baseBranch' ? 'Branch' : kind === 'commit' ? 'Commit SHA' : 'Instructions'}</span>
          {kind === 'custom'
            ? <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={4} />
            : <input value={value} onChange={(e) => setValue(e.target.value)} />}
        </label>}
        <div className="review-delivery" role="radiogroup" aria-label="Review destination">
          <button type="button" role="radio" aria-checked={delivery === 'inline'}
            className={delivery === 'inline' ? 'on' : ''} onClick={() => setDelivery('inline')}>
            <b>This session</b><small>Review appears in the current conversation</small>
          </button>
          <button type="button" role="radio" aria-checked={delivery === 'detached'}
            className={delivery === 'detached' ? 'on' : ''} onClick={() => setDelivery('detached')}>
            <b>New session</b><small>Keep review findings in a separate {provider} session</small>
          </button>
        </div>
        {error && <p className="confirm-err">{error}</p>}
        <div className="confirm-actions">
          <button type="button" onClick={onClose} disabled={busy}>cancel</button>
          <button type="button" onClick={() => onConfirm(target, delivery)} disabled={busy || (needsValue && !value.trim())}>
            {busy ? 'starting…' : 'start review'}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(body, document.body);
}
