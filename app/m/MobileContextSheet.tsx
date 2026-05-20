'use client';
import { useEffect, useState } from 'react';
import { ROW_COLORS, type RowColor } from '../SessionContextMenu';

// Bottom-sheet mobile pour les actions session / shell — équivalent du
// SessionContextMenu desktop (clic droit) mais adapté au tactile.
type Props = {
  title: string;
  subtitle?: string;
  initialName?: string;
  currentColor?: string | null;
  canKill?: boolean;
  killLabel?: string;
  killDisabledReason?: string;
  showDelete?: boolean;
  // Callbacks. Le sheet gère lui-même le renommage inline (passe le nouveau nom),
  // les autres actions sont des triggers simples.
  onRename: (newName: string) => void;
  onColor: (color: RowColor) => void;
  onEditCwd?: () => void;
  // Sleep pour les sessions Claude actives. Le caller ne passe `onSleep`
  // que quand la session est active/thinking/starting — sinon l'item
  // n'apparaît pas. Placé au-dessus de Supprimer définitivement.
  onSleep?: () => void;
  onKill?: () => void;
  onDelete?: () => void;
  onClose: () => void;
};

export default function MobileContextSheet({
  title, subtitle, initialName = '', currentColor,
  canKill = true, killLabel = 'Pause', killDisabledReason,
  showDelete = true,
  onRename, onColor, onEditCwd, onSleep, onKill, onDelete, onClose,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(initialName);

  // ESC ferme
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function submitRename() {
    const trimmed = name.trim();
    onRename(trimmed);
    onClose();
  }

  return (
    <>
      <div className="m-ctx-bg" onClick={onClose} />
      <div className="m-ctx-sheet" role="menu" aria-label="actions">
        <div className="m-ctx-handle" onClick={onClose} />
        <header className="m-ctx-head">
          <div className="m-ctx-title">{title}</div>
          {subtitle && <div className="m-ctx-subtitle">{subtitle}</div>}
        </header>

        {renaming ? (
          <div className="m-ctx-rename">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="nouveau nom"
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submitRename(); }
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
            <div className="m-ctx-rename-actions">
              <button type="button" onClick={() => setRenaming(false)}>annuler</button>
              <button type="button" className="primary" onClick={submitRename}>OK</button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="m-ctx-item" onClick={() => setRenaming(true)}>
              <span className="g">✎</span> Renommer
            </button>
            {onEditCwd && (
              <button type="button" className="m-ctx-item" onClick={() => { onEditCwd(); onClose(); }}>
                <span className="g">▤</span> Modifier le dossier (cwd)
              </button>
            )}

            <div className="m-ctx-color-row" role="group" aria-label="couleur">
              {ROW_COLORS.map((c) => {
                const selected = (currentColor ?? null) === c.token;
                const isNone = c.token === null;
                return (
                  <button
                    key={c.token ?? 'none'}
                    type="button"
                    className={`m-ctx-color-dot${selected ? ' on' : ''}${isNone ? ' none' : ''}`}
                    title={c.label}
                    style={{ background: c.css }}
                    onClick={() => { onColor(c.token); onClose(); }}
                    aria-label={`couleur ${c.label}`}
                  >
                    {isNone && <span>∅</span>}
                  </button>
                );
              })}
            </div>

            {/* Sleep — pour les sessions Claude actives. Placé juste avant
                Supprimer pour que l'action réversible soit en haut. */}
            {onSleep && (
              <button
                type="button"
                className="m-ctx-item"
                onClick={() => { onSleep(); onClose(); }}
              >
                <span className="g">💤</span> Mettre en pause (sleep)
              </button>
            )}
            {onKill && (
              <button
                type="button"
                className="m-ctx-item warn"
                onClick={() => { if (canKill) { onKill(); onClose(); } }}
                disabled={!canKill}
              >
                <span className="g">⏏</span> {killLabel}
                {!canKill && killDisabledReason && (
                  <span className="m-ctx-hint"> · {killDisabledReason}</span>
                )}
              </button>
            )}
            {showDelete && onDelete && (
              <button
                type="button"
                className="m-ctx-item danger"
                onClick={() => { onDelete(); onClose(); }}
              >
                <span className="g">✗</span> Supprimer définitivement
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
