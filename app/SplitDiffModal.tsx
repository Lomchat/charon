'use client';
import { useEffect, useMemo } from 'react';
import { diffLines } from 'diff';

type Props = {
  filePath: string;
  before: string | null;
  after: string | null;
  onClose: () => void;
};

// Split-screen old | new view, VSCode-style. Line-by-line alignment:
// - Unchanged lines: shown on both sides
// - Added lines: empty on the left, green on the right
// - Deleted lines: red on the left, empty on the right
// - Modifications: usually deleted then added (line-level diff)
export default function SplitDiffModal({ filePath, before, after, onClose }: Props) {
  const rows = useMemo(() => computeAlignedRows(before ?? '', after ?? ''), [before, after]);
  const stats = useMemo(() => {
    let add = 0, del = 0;
    for (const r of rows) {
      if (r.kind === 'add') add++;
      else if (r.kind === 'del') del++;
    }
    return { add, del };
  }, [rows]);

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
        <div className="sdm-cols-head">
          <span className="left">before{before == null ? ' (new file)' : ''}</span>
          <span className="right">after{after == null ? ' (deleted)' : ''}</span>
        </div>
        <div className="sdm-body">
          <table className="sdm-table">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={`row-${r.kind}`}>
                  <td className="ln ln-left">{r.leftLine ?? ''}</td>
                  <td className={`code left ${r.kind === 'del' ? 'del' : ''}`}>
                    {r.kind === 'del' || r.kind === 'eq' || r.kind === 'mod' ? (
                      <>
                        <span className="marker">{r.kind === 'del' ? '-' : r.kind === 'mod' ? '~' : ' '}</span>
                        <span className="text">{r.leftText ?? ''}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="ln ln-right">{r.rightLine ?? ''}</td>
                  <td className={`code right ${r.kind === 'add' ? 'add' : ''}`}>
                    {r.kind === 'add' || r.kind === 'eq' || r.kind === 'mod' ? (
                      <>
                        <span className="marker">{r.kind === 'add' ? '+' : r.kind === 'mod' ? '~' : ' '}</span>
                        <span className="text">{r.rightText ?? ''}</span>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

type Row = {
  kind: 'eq' | 'add' | 'del' | 'mod';
  leftLine?: number;
  rightLine?: number;
  leftText?: string;
  rightText?: string;
};

// Aligns the two files into lines via diffLines. When a removed block is
// immediately followed by an added block of the same size, we pair them
// as "mod" (modification) — visually more readable.
function computeAlignedRows(before: string, after: string): Row[] {
  const parts = diffLines(before, after);
  const rows: Row[] = [];
  let leftN = 1, rightN = 1;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lines = splitLines(p.value);

    if (!p.added && !p.removed) {
      for (const ln of lines) {
        rows.push({ kind: 'eq', leftLine: leftN++, rightLine: rightN++, leftText: ln, rightText: ln });
      }
      continue;
    }

    if (p.removed) {
      // Pair with a potential "added" that follows
      const next = parts[i + 1];
      if (next?.added) {
        const addedLines = splitLines(next.value);
        const maxLen = Math.max(lines.length, addedLines.length);
        for (let k = 0; k < maxLen; k++) {
          if (k < lines.length && k < addedLines.length) {
            rows.push({
              kind: 'mod',
              leftLine: leftN++, rightLine: rightN++,
              leftText: lines[k], rightText: addedLines[k],
            });
          } else if (k < lines.length) {
            rows.push({ kind: 'del', leftLine: leftN++, leftText: lines[k] });
          } else {
            rows.push({ kind: 'add', rightLine: rightN++, rightText: addedLines[k] });
          }
        }
        i++; // consumed
        continue;
      }
      for (const ln of lines) {
        rows.push({ kind: 'del', leftLine: leftN++, leftText: ln });
      }
      continue;
    }

    if (p.added) {
      for (const ln of lines) {
        rows.push({ kind: 'add', rightLine: rightN++, rightText: ln });
      }
    }
  }
  return rows;
}

function splitLines(s: string): string[] {
  // Split while correctly preserving trailing empty lines. For a visual
  // diff, we want each line separately, without the trailing \n.
  if (s === '') return [];
  const noTrailingNL = s.endsWith('\n') ? s.slice(0, -1) : s;
  return noTrailingNL.split('\n');
}
