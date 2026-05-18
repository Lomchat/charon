'use client';
import { useEffect } from 'react';

// Palette de couleurs pour marquer une row dans la sidebar.
// "transparent" = pas de marker (option par défaut, neutralise un marker existant).
export const ROW_COLORS = [
  { token: null,        css: 'transparent', label: 'aucune' },
  { token: 'gold',      css: '#d8a85a',     label: 'doré' },
  { token: 'green',     css: '#6cbf6c',     label: 'vert' },
  { token: 'cyan',      css: '#7ac4c4',     label: 'cyan' },
  { token: 'blue',      css: '#6a9bd8',     label: 'bleu' },
  { token: 'purple',    css: '#c8a2c8',     label: 'mauve' },
  { token: 'red',       css: '#d97a6b',     label: 'rouge' },
  { token: 'pink',      css: '#e6a4c8',     label: 'rose' },
] as const;

export type RowColor = (typeof ROW_COLORS)[number]['token'];

export function colorToCss(token: string | null | undefined): string {
  if (!token) return 'transparent';
  const entry = ROW_COLORS.find((c) => c.token === token);
  return entry?.css ?? token; // tolère un hex passé directement
}

type Props = {
  title: string;                     // affiché en haut du menu (nom de l'item)
  x: number;
  y: number;
  currentColor?: string | null;
  canKill?: boolean;
  killLabel?: string;                // 'Kill' (session) ou 'Fermer' (shell)
  killDisabledReason?: string;
  showDelete?: boolean;              // bouton "Supprimer définitivement"
  onRename: () => void;
  onColor: (color: RowColor) => void;
  onKill?: () => void;
  onDelete?: () => void;
  onClose: () => void;
};

export default function SessionContextMenu({
  title, x, y, currentColor, canKill = true, killLabel = 'Kill',
  killDisabledReason, showDelete = true,
  onRename, onColor, onKill, onDelete, onClose,
}: Props) {
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement;
      if (!tgt.closest('.session-ctx-menu')) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="session-ctx-menu" style={{ left: x, top: y }} role="menu">
      <div className="ctx-head">{title}</div>
      <button type="button" onClick={() => { onRename(); onClose(); }}>Renommer</button>

      {/* Palette de couleurs — ligne horizontale de pastilles cliquables */}
      <div className="ctx-color-row" role="group" aria-label="couleur">
        {ROW_COLORS.map((c) => {
          const selected = (currentColor ?? null) === c.token;
          const isNone = c.token === null;
          return (
            <button
              key={c.token ?? 'none'}
              type="button"
              className={`ctx-color-dot${selected ? ' on' : ''}${isNone ? ' none' : ''}`}
              title={c.label}
              style={{ background: c.css }}
              onClick={() => { onColor(c.token); onClose(); }}
            >
              {isNone && <span className="x">∅</span>}
            </button>
          );
        })}
      </div>

      {onKill && (
        <button
          type="button"
          onClick={() => { onKill(); onClose(); }}
          disabled={!canKill}
        >
          {killLabel}
          {!canKill && killDisabledReason && <span className="ctx-hint"> · {killDisabledReason}</span>}
        </button>
      )}
      {showDelete && onDelete && (
        <button
          type="button"
          className="danger"
          onClick={() => { onDelete(); onClose(); }}
        >Supprimer définitivement</button>
      )}
    </div>
  );
}
