'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { changeBlocks, type DiffRow } from './diffRows';

type Props = {
  rows: DiffRow[];
  /** Column captions — "before"/"after" for an edit, "HEAD"/"working tree" for git. */
  leftLabel?: string;
  rightLabel?: string;
  /** Reset the scroll and the change cursor when this changes (a new file). */
  resetKey?: string;
};

/**
 * The split diff, shared by the session edit reader and the git reader
 * (§14.86). Old on the left, new on the right, and a small ▲/▼ between them
 * that steps from one change to the next.
 *
 * The stepper sits BETWEEN the panes rather than in the header because that is
 * where your eyes already are when you are reading a diff, and it is the one
 * control you use repeatedly. It counts BLOCKS, not lines: stepping through a
 * forty-line replacement one line at a time is not navigation.
 */
export default function SplitDiffView({ rows, leftLabel = 'before', rightLabel = 'after', resetKey }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const blocks = useMemo(() => changeBlocks(rows), [rows]);
  const [cursor, setCursor] = useState(0);

  // A new file starts at the top: keeping the offset lands the reader in the
  // middle of an unrelated patch.
  useEffect(() => {
    setCursor(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  const goto = useCallback((i: number) => {
    if (blocks.length === 0) return;
    const clamped = Math.max(0, Math.min(blocks.length - 1, i));
    setCursor(clamped);
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row="${blocks[clamped]}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [blocks]);

  // Alt+arrows step through changes. Plain arrows are left alone: in the git
  // reader they move between FILES, and the two must not fight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      goto(cursor + (e.key === 'ArrowDown' ? 1 : -1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [goto, cursor]);

  // Keep the counter honest while the user scrolls by hand, or "2/7" would
  // claim you are somewhere you scrolled away from ten seconds ago.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || blocks.length === 0) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const mid = box.scrollTop + box.clientHeight / 2;
        let best = 0;
        for (let i = 0; i < blocks.length; i++) {
          const el = box.querySelector<HTMLElement>(`[data-row="${blocks[i]}"]`);
          if (!el) continue;
          if (el.offsetTop <= mid) best = i; else break;
        }
        setCursor(best);
      });
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => { box.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [blocks]);

  return (
    <div className="sdv-wrap">
      <div className="sdm-cols-head">
        <span className="left">{leftLabel}</span>
        <span className="right">{rightLabel}</span>
      </div>
      <div className="sdv-scroll" ref={scrollRef}>
        <table className="sdm-table">
          <tbody>
            {rows.map((r, i) => (
              r.kind === 'gap' ? (
                <tr key={i} data-row={i} className="row-gap">
                  <td className="ln ln-left" />
                  <td className="code left gap" colSpan={3}>
                    <span className="text">
                      ⋯{r.skipped ? ` ${r.skipped} unchanged line${r.skipped > 1 ? 's' : ''}` : ''}
                    </span>
                  </td>
                </tr>
              ) : (
                <tr key={i} data-row={i} className={`row-${r.kind}`}>
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
              )
            ))}
          </tbody>
        </table>
      </div>

      {blocks.length > 0 && (
        <div className="sdv-nav" aria-label="jump between changes">
          <button
            className="sdv-navbtn"
            onClick={() => goto(cursor - 1)}
            disabled={cursor <= 0}
            title="previous change (Alt+↑)"
          >▲</button>
          <span className="sdv-navpos" title={`${blocks.length} change block${blocks.length > 1 ? 's' : ''}`}>
            {cursor + 1}/{blocks.length}
          </span>
          <button
            className="sdv-navbtn"
            onClick={() => goto(cursor + 1)}
            disabled={cursor >= blocks.length - 1}
            title="next change (Alt+↓)"
          >▼</button>
        </div>
      )}
    </div>
  );
}
