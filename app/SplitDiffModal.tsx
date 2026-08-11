'use client';
import { useEffect, useMemo } from 'react';
import SplitDiffView from './SplitDiffView';
import { countChanges, rowsFromContents } from './diffRows';

type Props = {
  filePath: string;
  before: string | null;
  after: string | null;
  onClose: () => void;
};

/**
 * The session-edit reader: what an agent changed in one file, old | new.
 *
 * The rows and the renderer are shared with the git reader (`diffRows.ts` +
 * `SplitDiffView`, §14.86) — one split view, two sources.
 */
export default function SplitDiffModal({ filePath, before, after, onClose }: Props) {
  const rows = useMemo(() => rowsFromContents(before ?? '', after ?? ''), [before, after]);
  const stats = useMemo(() => countChanges(rows), [rows]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="split-diff-modal-backdrop" onClick={onClose}>
      <div className="split-diff-modal" onClick={(e) => e.stopPropagation()}>
        <header className="sdm-head">
          <span className="sdm-path">{filePath}</span>
          <span className="sdm-stats">
            <span className="add">+{stats.add}</span>
            <span className="del">−{stats.del}</span>
          </span>
          <button className="sdm-close" onClick={onClose} title="close (Esc)">✕</button>
        </header>
        <div className="sdm-body">
          <SplitDiffView
            rows={rows}
            resetKey={filePath}
            leftLabel={`before${before == null ? ' (new file)' : ''}`}
            rightLabel={`after${after == null ? ' (deleted)' : ''}`}
          />
        </div>
      </div>
    </div>
  );
}
