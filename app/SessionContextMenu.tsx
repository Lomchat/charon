'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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

  // Reposition the menu to keep it inside the viewport: if it would
  // overflow at the bottom, flip it upward (anchor its bottom edge to
  // the click Y); same idea horizontally on the right edge.
  // First render is hidden; useLayoutEffect measures + commits the
  // final position before the browser paints → no flicker.
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8; // breathing room from viewport edges

    let left = x;
    let top = y;
    if (top + rect.height > vh - margin) {
      // Not enough room below: flip upward (anchor bottom to click Y).
      top = Math.max(margin, y - rect.height);
    }
    if (left + rect.width > vw - margin) {
      left = Math.max(margin, vw - margin - rect.width);
    }
    setPos({ left, top });
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className="session-ctx-menu"
      style={{
        left: pos ? pos.left : x,
        top: pos ? pos.top : y,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="menu"
    >
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
