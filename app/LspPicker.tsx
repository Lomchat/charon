'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LspLocation } from '@/lib/types/api';
import { SYMBOL_KIND, type FlatSymbol } from './lspClient';

/**
 * The chooser the editor puts up when there is more than one answer (§14.90).
 *
 * Two shapes, one component, because the interaction is identical: a filtered
 * list you walk with the arrows and take with Enter.
 *
 *   * LOCATIONS — "go to definition" that found three, or "find all
 *     references". Each row is `file:line` plus **the source line**, which is
 *     the whole reason a picker beats jumping blind: a list of file names is
 *     not something anyone can choose from.
 *   * SYMBOLS — go-to-symbol in this file, indented by nesting.
 *
 * Portaled to <body>: the editor lives inside panes that are `transform`ed on
 * narrow screens, and a transform is the containing block for `position:
 * fixed` (§14.80).
 */
type Props =
  | {
      kind: 'locations';
      title: string;
      items: LspLocation[];
      /** Path the editor is showing, so "this file" can be said instead of it. */
      currentPath: string;
      onPick: (item: LspLocation) => void;
      onClose: () => void;
    }
  | {
      kind: 'symbols';
      title: string;
      items: FlatSymbol[];
      currentPath?: string;
      onPick: (item: FlatSymbol) => void;
      onClose: () => void;
    };

export default function LspPicker(props: Props) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (props.kind === 'symbols') {
      const all = props.items;
      return (needle ? all.filter((s) => s.name.toLowerCase().includes(needle)) : all)
        .map((s) => ({ key: `${s.name}:${s.line}`, item: s as FlatSymbol | LspLocation }));
    }
    const all = props.items;
    return (needle
      ? all.filter((l) => `${l.path} ${l.preview ?? ''}`.toLowerCase().includes(needle))
      : all
    ).map((l) => ({ key: `${l.path}:${l.line}`, item: l as FlatSymbol | LspLocation }));
  }, [props, q]);

  useEffect(() => { setI(0); }, [q]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  // Keep the cursor visible while walking the list with the keyboard.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('li.on')?.scrollIntoView({ block: 'nearest' });
  }, [i]);

  const take = (n: number) => {
    const row = rows[n];
    if (!row) return;
    if (props.kind === 'symbols') props.onPick(row.item as FlatSymbol);
    else props.onPick(row.item as LspLocation);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); props.onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => Math.min(rows.length - 1, n + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => Math.max(0, n - 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); take(i); }
  };

  const rel = (p: string) => {
    const cur = props.currentPath ?? '';
    if (p === cur) return 'this file';
    // Show the tail: the head is the same project for every row and eats the
    // width the interesting part needs.
    return p.length > 54 ? '…' + p.slice(-53) : p;
  };

  return createPortal(
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="claude-modal lsp-picker" role="dialog" aria-modal="true" aria-label={props.title}
        onKeyDown={onKey}>
        <div className="lp-head">
          <span className="lp-title">{props.title}</span>
          <span className="lp-count">{rows.length}</span>
        </div>
        <input
          ref={inputRef}
          className="bm-search"
          placeholder={props.kind === 'symbols' ? 'filter symbols…' : 'filter results…'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoCapitalize="off" autoCorrect="off" spellCheck={false}
        />
        {rows.length === 0 ? (
          <div className="tp-empty">nothing matches « {q} »</div>
        ) : (
          <ul className="lp-list" ref={listRef}>
            {rows.map((row, n) => {
              if (props.kind === 'symbols') {
                const s = row.item as FlatSymbol;
                return (
                  <li key={row.key + n} className={n === i ? 'on' : ''}>
                    <button className="lp-row" onMouseEnter={() => setI(n)} onClick={() => take(n)}>
                      <span className="lp-kind">{SYMBOL_KIND[s.kind] ?? ''}</span>
                      <span className="lp-name" style={{ paddingLeft: s.depth * 12 }}>{s.name}</span>
                      {s.detail && <span className="lp-detail">{s.detail}</span>}
                      <span className="gt-spacer" />
                      <span className="lp-line">{s.line}</span>
                    </button>
                  </li>
                );
              }
              const l = row.item as LspLocation;
              return (
                <li key={row.key + n} className={n === i ? 'on' : ''}>
                  <button className="lp-row" onMouseEnter={() => setI(n)} onClick={() => take(n)} title={`${l.path}:${l.line}`}>
                    <span className="lp-where">{rel(l.path)}<span className="lp-line">:{l.line}</span></span>
                    {l.preview && <span className="lp-preview">{l.preview}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="lp-foot">↑↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>,
    document.body,
  );
}
