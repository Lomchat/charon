'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cellInRange, normalizeCellRange, parseCsv, rangeToTsv, spreadsheetColumn,
  type Cell, type CellRange,
} from './csvTable';

type Props = { text: string; filename: string };

const ROW_HEIGHT = 28;
const OVERSCAN = 8;

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('clipboard unavailable');
}

export default function CsvViewer({ text, filename }: Props) {
  const table = useMemo(() => parseCsv(text, filename.toLowerCase().endsWith('.tsv') ? '\t' : undefined), [text, filename]);
  const [range, setRange] = useState<CellRange | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 500 });
  const [copied, setCopied] = useState<'ok' | 'error' | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const stop = () => { draggingRef.current = false; };
    document.addEventListener('mouseup', stop);
    return () => document.removeEventListener('mouseup', stop);
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  useEffect(() => {
    setRange(null);
    setCopied(null);
    scrollerRef.current?.scrollTo({ top: 0, left: 0 });
  }, [text, filename]);

  const select = useCallback((cell: Cell, extend: boolean, drag = false) => {
    setCopied(null);
    setRange((current) => extend && current
      ? { anchor: current.anchor, focus: cell }
      : drag && current
        ? { anchor: current.anchor, focus: cell }
        : { anchor: cell, focus: cell });
  }, []);

  const copy = useCallback(async () => {
    if (!range) return;
    try {
      await writeClipboard(rangeToTsv(table.rows, range));
      setCopied('ok');
      window.setTimeout(() => setCopied((state) => state === 'ok' ? null : state), 1200);
    } catch {
      setCopied('error');
    }
  }, [range, table.rows]);

  const ensureVisible = useCallback((cell: Cell) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = (cell.row + 1) * ROW_HEIGHT;
    if (top < scroller.scrollTop + ROW_HEIGHT) scroller.scrollTop = Math.max(0, top - ROW_HEIGHT);
    else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight;
    }
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && range) {
      event.preventDefault();
      void copy();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && table.rows.length && table.columns) {
      event.preventDefault();
      setRange({ anchor: { row: 0, col: 0 }, focus: { row: table.rows.length - 1, col: table.columns - 1 } });
      return;
    }
    if (!range || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? [-1, 0]
      : event.key === 'ArrowDown' ? [1, 0]
        : event.key === 'ArrowLeft' ? [0, -1] : [0, 1];
    const next = {
      row: Math.max(0, Math.min(table.rows.length - 1, range.focus.row + delta[0])),
      col: Math.max(0, Math.min(table.columns - 1, range.focus.col + delta[1])),
    };
    select(next, event.shiftKey);
    ensureVisible(next);
  }, [copy, ensureVisible, range, select, table.columns, table.rows.length]);

  if (!table.rows.length || !table.columns) {
    return <div className="csv-empty">This CSV is empty.</div>;
  }

  const normalized = range ? normalizeCellRange(range) : null;
  const start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - 1 - OVERSCAN);
  const end = Math.min(table.rows.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = table.rows.slice(start, end);
  const delimiter = table.delimiter === '\t' ? 'tab' : table.delimiter === ';' ? 'semicolon' : table.delimiter === '|' ? 'pipe' : 'comma';
  const selectionLabel = normalized
    ? `${spreadsheetColumn(normalized.left)}${normalized.top + 1}:${spreadsheetColumn(normalized.right)}${normalized.bottom + 1}`
    : 'No selection';

  return (
    <section className="csv-viewer">
      <div className="csv-toolbar">
        <span>{table.rows.length.toLocaleString()} rows × {table.columns.toLocaleString()} columns</span>
        <span className="csv-delimiter">{delimiter} separated</span>
        {table.truncated && <span className="csv-truncated">preview limited</span>}
        <span className="csv-spacer" />
        <span className="csv-selection">{selectionLabel}</span>
        <button type="button" onClick={() => void copy()} disabled={!range}>
          {copied === 'ok' ? 'Copied' : copied === 'error' ? 'Copy failed' : 'Copy selection'}
        </button>
      </div>
      <div
        ref={scrollerRef}
        className="csv-grid-scroll"
        role="grid"
        aria-rowcount={table.rows.length}
        aria-colcount={table.columns}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
        onFocus={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
      >
        <div className="csv-grid-canvas" style={{ height: (table.rows.length + 1) * ROW_HEIGHT, width: 48 + table.columns * 180 }}>
          <div className="csv-grid-head" role="row">
            <button
              type="button"
              className="csv-corner"
              title="select all"
              onMouseDown={(event) => {
                event.preventDefault();
                setRange({ anchor: { row: 0, col: 0 }, focus: { row: table.rows.length - 1, col: table.columns - 1 } });
                scrollerRef.current?.focus();
              }}
            />
            {Array.from({ length: table.columns }, (_, col) => (
              <button
                type="button"
                key={col}
                role="columnheader"
                className={normalized && col >= normalized.left && col <= normalized.right ? 'selected' : ''}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setRange({ anchor: { row: 0, col }, focus: { row: table.rows.length - 1, col } });
                  scrollerRef.current?.focus();
                }}
              >{spreadsheetColumn(col)}</button>
            ))}
          </div>
          {visibleRows.map((row, offset) => {
            const rowIndex = start + offset;
            return (
              <div className={`csv-grid-row${rowIndex % 2 ? ' even' : ''}`} role="row" key={rowIndex} style={{ top: (rowIndex + 1) * ROW_HEIGHT }}>
                <button
                  type="button"
                  role="rowheader"
                  className={normalized && rowIndex >= normalized.top && rowIndex <= normalized.bottom ? 'selected' : ''}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setRange({ anchor: { row: rowIndex, col: 0 }, focus: { row: rowIndex, col: table.columns - 1 } });
                    scrollerRef.current?.focus();
                  }}
                >{rowIndex + 1}</button>
                {Array.from({ length: table.columns }, (_, col) => {
                  const value = row[col] ?? '';
                  const selected = cellInRange(rowIndex, col, range);
                  const anchor = range?.focus.row === rowIndex && range.focus.col === col;
                  return (
                    <div
                      role="gridcell"
                      aria-selected={selected}
                      key={col}
                      className={`csv-cell${selected ? ' selected' : ''}${anchor ? ' focus' : ''}`}
                      title={value}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        draggingRef.current = true;
                        select({ row: rowIndex, col }, event.shiftKey);
                        scrollerRef.current?.focus();
                      }}
                      onMouseEnter={() => {
                        if (draggingRef.current) select({ row: rowIndex, col }, false, true);
                      }}
                    >{value}</div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="csv-hint">Drag or Shift-click to select · arrows move · Shift+arrows extends · Ctrl/Cmd+C copies for Sheets/Excel</div>
    </section>
  );
}
