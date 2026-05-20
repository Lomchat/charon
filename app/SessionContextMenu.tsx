'use client';
import { useEffect } from 'react';

// Color palette to mark a row in the sidebar.
// "transparent" = no marker (default option, neutralizes an existing marker).
export const ROW_COLORS = [
  { token: null,        css: 'transparent', label: 'none' },
  { token: 'gold',      css: '#d8a85a',     label: 'gold' },
  { token: 'green',     css: '#6cbf6c',     label: 'green' },
  { token: 'cyan',      css: '#7ac4c4',     label: 'cyan' },
  { token: 'blue',      css: '#6a9bd8',     label: 'blue' },
  { token: 'purple',    css: '#c8a2c8',     label: 'purple' },
  { token: 'red',       css: '#d97a6b',     label: 'red' },
  { token: 'pink',      css: '#e6a4c8',     label: 'pink' },
] as const;

export type RowColor = (typeof ROW_COLORS)[number]['token'];

export function colorToCss(token: string | null | undefined): string {
  if (!token) return 'transparent';
  const entry = ROW_COLORS.find((c) => c.token === token);
  return entry?.css ?? token; // tolerates a hex passed directly
}

type Props = {
  title: string;                     // shown at the top of the menu (item name)
  subtitle?: string;                 // secondary info (e.g. cwd)
  x: number;
  y: number;
  currentColor?: string | null;
  canKill?: boolean;
  killLabel?: string;                // 'Close' (shell/install). Not used
                                     // for Claude sessions since the
                                     // kill→delete rework (cf. CLAUDE.md §10).
  killDisabledReason?: string;
  showDelete?: boolean;              // "Delete permanently" button
  showRename?: boolean;              // default true; false for install
  showColor?: boolean;               // default true; false for install
  onRename?: () => void;
  onColor?: (color: RowColor) => void;
  onEditCwd?: () => void;            // "Change folder" option
  onSleep?: () => void;              // "💤 Sleep" — for active Claude
                                     // sessions. The caller only passes it
                                     // if the session is in a state where
                                     // "sleep" makes sense (= not already
                                     // sleeping/error). Placed above
                                     // Delete.
  onKill?: () => void;               // "Close" — shell/install only
  onDelete?: () => void;
  onClose: () => void;
};

export default function SessionContextMenu({
  title, subtitle, x, y, currentColor, canKill = true, killLabel = 'Close',
  killDisabledReason, showDelete = true,
  showRename = true, showColor = true,
  onRename, onColor, onEditCwd, onSleep, onKill, onDelete, onClose,
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
      <div className="ctx-head">
        {title}
        {subtitle && <div className="ctx-subtitle">{subtitle}</div>}
      </div>
      {showRename && onRename && (
        <button type="button" onClick={() => { onRename(); onClose(); }}>Rename</button>
      )}
      {onEditCwd && (
        <button type="button" onClick={() => { onEditCwd(); onClose(); }}>Change folder (cwd)</button>
      )}

      {/* Color palette — horizontal row of clickable swatches.
          Hidden for installs (no useful customization). */}
      {showColor && onColor && (
        <div className="ctx-color-row" role="group" aria-label="color">
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
      )}

      {/* Sleep — for active Claude sessions. Placed just above the
          destructive Delete button so the user going down the menu
          finds the reversible action first. */}
      {onSleep && (
        <button
          type="button"
          onClick={() => { onSleep(); onClose(); }}
        >💤 Sleep</button>
      )}
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
        >Delete permanently</button>
      )}
    </div>
  );
}
