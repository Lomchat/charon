'use client';
// Single-input dialog — the `prompt()` replacement for the file explorer's
// create / rename actions (§14.80).
//
// Three things the native prompt could not do, which is the whole reason this
// exists: it is unstyled and OS-modal, it cannot show WHERE the name is about
// to land (a tree action is meaningless without its folder), and it cannot put
// the server's rejection next to the text the user has to fix — with
// `prompt()` a refused name meant a lost draft and a banner somewhere else.
//
// Contract, mirroring ConfirmModal: Enter submits, Escape / backdrop / cancel
// dismiss, and `onSubmit` THROWING keeps the dialog open with the message
// under the input, the typed value intact. The parent closes on success.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  title: string;
  /** Mono line under the title: the folder it lands in, the old path, … */
  hint?: ReactNode;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  /** Swapped in while `onSubmit` runs (defaults to confirmLabel). */
  busyLabel?: string;
  cancelLabel?: string;
  /** Icon inside the tinted circle next to the title. */
  icon?: ReactNode;
  /** 'stem' preselects the name without its extension, as VS Code's rename does. */
  select?: 'all' | 'stem';
  /** Nothing to type — show the value and let the user copy it out. */
  readOnly?: boolean;
  /** Sync check; return a message to block the submit. */
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
};

export default function PromptModal({
  title, hint, initial = '', placeholder, confirmLabel, busyLabel,
  cancelLabel = 'cancel', icon, select = 'all', readOnly = false,
  validate, onSubmit, onClose,
}: Props) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + preselect on open. 'stem' stops at the last dot so renaming
  // `route.ts` → `handler.ts` is one keystroke and not a re-typed extension.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, select === 'stem' && dot > 0 ? dot : initial.length);
  }, [initial, select]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  async function submit() {
    if (busy) return;
    const v = readOnly ? initial : value.trim();
    const bad = readOnly ? null : (!v ? 'a name is required' : validate?.(v) ?? null);
    if (bad) { setError(bad); inputRef.current?.focus(); return; }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(v);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="claude-modal prompt" role="dialog" aria-modal="true" aria-label={title}>
        <div className="confirm-head">
          {icon && <span className="confirm-ico neutral">{icon}</span>}
          <h2>{title}</h2>
        </div>
        {hint && <p className="prompt-hint">{hint}</p>}
        <input
          ref={inputRef}
          className="prompt-input"
          type="text"
          value={readOnly ? initial : value}
          readOnly={readOnly}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          // Enter validates. Escape is handled by the window listener above, so
          // it is stopped here only to keep the two from both firing.
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          }}
        />
        {error && <p className="confirm-err">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="confirm-btn ghost" disabled={busy} onClick={onClose}>
            {cancelLabel}
          </button>
          <button type="button" className="confirm-btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  // Portaled to <body>. The explorer lives inside `.tool-panel`, which becomes
  // a `transform`ed drawer at ≤1100px — and a transform makes that element the
  // containing block for `position: fixed` descendants, so the backdrop would
  // cover the 380px drawer instead of the page. Guarded for SSR: a dialog only
  // ever renders after a click, so there is nothing to hydrate.
  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}
