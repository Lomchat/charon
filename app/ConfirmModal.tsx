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
import { createPortal } from 'react-dom';
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
  // Opt-in: Enter validates and the destructive button takes the focus.
  // OFF by default — for a session delete, reflexive Enter should cancel.
  // ON where the dialog is one step of a keyboard flow the user drives at
  // speed (the file explorer's menu), so every dialog there answers Enter.
  confirmOnEnter?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
};

export default function ConfirmModal({
  title, children, confirmLabel, busyLabel, cancelLabel = 'cancel',
  icon, confirmOnEnter = false, onConfirm, onClose,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === 'Escape') { onClose(); return; }
      // Enter from anywhere in the dialog. Skipped when a button has the
      // focus: the browser already turns Enter into a click there, and
      // handling it twice would confirm on top of a cancel.
      if (confirmOnEnter && e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void handleConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, busy, confirmOnEnter]);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    // A throwing `onConfirm` keeps the dialog open with its reason shown —
    // the caller's own banner may be behind the backdrop, or scrolled away.
    try { await onConfirm(); } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const body = (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="claude-modal confirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="confirm-head">
          <span className="confirm-ico">{icon ?? <IconTrash />}</span>
          <h2>{title}</h2>
        </div>
        {children}
        {error && <p className="confirm-err">{error}</p>}
        <div className="confirm-actions">
          {/* Autofocus the SAFE button: Enter pressed reflexively cancels —
              unless the caller asked for the opposite (confirmOnEnter). */}
          <button type="button" className="confirm-btn ghost" autoFocus={!confirmOnEnter} disabled={busy} onClick={onClose}>
            {cancelLabel}
          </button>
          <button type="button" className="confirm-btn danger" autoFocus={confirmOnEnter} disabled={busy} onClick={handleConfirm}>
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  // Portaled to <body>: callers now include the file explorer, which lives
  // inside `.tool-panel` — a `transform`ed drawer at ≤1100px, and a transform
  // makes that element the containing block for `position: fixed` descendants,
  // so the backdrop would cover the drawer instead of the page. Guarded for
  // SSR: a dialog only ever renders after a click, so nothing is hydrated.
  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}
