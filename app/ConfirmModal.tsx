'use client';
// Small styled confirmation dialog — replaces the native `confirm()` for
// destructive actions ("Delete permanently", …), consistent with the other
// `claude-modal` surfaces. Escape / backdrop click / cancel all dismiss;
// the destructive button awaits `onConfirm` and shows a busy label while
// the action runs (the PARENT closes the modal when done, so a failure can
// keep its error banner visible underneath).
//
// Deliberately generic (title + free-form children + labels) so future
// confirms (VPS delete, revert, …) can reuse it instead of `confirm()`.
import { useEffect, useState, type ReactNode } from 'react';
import { IconTrash } from './icons';

type Props = {
  title: string;
  // Free-form body: target card, warning text, …
  children?: ReactNode;
  confirmLabel: string;
  // Label swapped in while `onConfirm` is running (defaults to confirmLabel).
  busyLabel?: string;
  cancelLabel?: string;
  // Icon inside the tinted circle next to the title (defaults to a trash can).
  icon?: ReactNode;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
};

export default function ConfirmModal({
  title, children, confirmLabel, busyLabel, cancelLabel = 'cancel',
  icon, onConfirm, onClose,
}: Props) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  }

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="claude-modal confirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="confirm-head">
          <span className="confirm-ico">{icon ?? <IconTrash />}</span>
          <h2>{title}</h2>
        </div>
        {children}
        <div className="confirm-actions">
          {/* Autofocus the SAFE button: Enter pressed reflexively cancels. */}
          <button type="button" className="confirm-btn ghost" autoFocus disabled={busy} onClick={onClose}>
            {cancelLabel}
          </button>
          <button type="button" className="confirm-btn danger" disabled={busy} onClick={handleConfirm}>
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
