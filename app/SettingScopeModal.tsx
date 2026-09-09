'use client';
// ── "Which settings files should this VPS load?" (§14.100) ───────────────────
// Two entry points, one dialog:
//   - installing an agent on a VPS (ClaudePanel § openInstallSession), which is
//     the moment the machine's policy is actually being decided;
//   - the VPS card in DataModal, because a choice made at install time is made
//     BEFORE ~/.claude/settings.json exists on a fresh box — it is a policy,
//     not a selection among existing files, and it has to stay changeable
//     without reinstalling an agent.
// The confirm label differs accordingly (`onConfirm` may chain the install).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import SettingSourcesPicker from './SettingSourcesPicker';
import {
  formatSettingSources, parseSettingSources, type ClaudeSettingSource,
} from '@/lib/settingSources';

export default function SettingScopeModal({
  vpsName, initial, hubDefault, confirmLabel, busyLabel, onConfirm, onClose,
}: {
  vpsName: string;
  /** The VPS's stored value: '' = inherit the hub default, 'none' = isolation. */
  initial: string | null;
  /** The hub-wide default this VPS falls back to. */
  hubDefault: readonly ClaudeSettingSource[];
  confirmLabel: string;
  busyLabel?: string;
  /** Receives the value to persist: null = inherit. Throws to stay open. */
  onConfirm: (value: ClaudeSettingSource[] | null) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState<ClaudeSettingSource[] | null>(() => {
    try { return parseSettingSources(initial); } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === 'Escape') { onClose(); return; }
      // Enter validates, like every other dialog here (§14.80). Nothing
      // destructive is behind it, and this sits on the install path — a
      // keyboard flow that must not need the mouse. Skipped on a focused
      // button, which the browser already turns into a click.
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void confirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, busy, value]);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await onConfirm(value); } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  const body = (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="claude-modal scope-modal" role="dialog" aria-modal="true" aria-label="Claude settings scope">
        <h2 className="scope-title">Claude settings on <b>{vpsName}</b></h2>
        <p className="scope-lead">
          Claude sessions running on this machine read the files you tick below.
          Anything not ticked is ignored, including the rules it contains.
        </p>
        <SettingSourcesPicker value={value} onChange={setValue} inherited={hubDefault} />
        {error && <p className="confirm-err">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="confirm-btn ghost" disabled={busy} onClick={onClose}>cancel</button>
          <button type="button" className="confirm-btn primary" autoFocus disabled={busy} onClick={confirm}>
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
        <p className="scope-stored">stored as <code>{formatSettingSources(value) || 'inherit'}</code></p>
      </div>
    </div>
  );

  // Portaled like every other dialog (§14.80): DataModal and the sidebar both
  // live under transformed ancestors at narrow widths.
  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}
