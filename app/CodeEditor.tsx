'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec, RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin, keymap } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { applyDiagnostics, lspExtensions, type LspTarget } from './lspClient';
import type { LspDiagnostic } from '@/lib/types/api';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  SearchQuery, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext,
  search, setSearchQuery,
} from '@codemirror/search';

type Props = {
  /** Initial document. Changing `docKey` is what forces a reload. */
  doc: string;
  docKey: string;
  filename: string;
  readOnly?: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  /** Scroll to a line (1-based). The nonce is what makes the SAME line twice
   *  in a row still move the caret — two clicks on one search hit. */
  reveal?: { line: number; nonce: number } | null;
  /** Where the language server for this file lives, when there is one (§14.89). */
  lsp?: LspTarget | null;
  /** Problems the server reported, rendered as squiggles + gutter marks. */
  diagnostics?: LspDiagnostic[];
  /** Go-to-definition landed somewhere: open it. */
  onOpenLocation?: (path: string, line: number) => void;
};

type Find = {
  open: boolean;
  replaceOpen: boolean;
  search: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
};

const FIND_CLOSED: Find = {
  open: false, replaceOpen: false, search: '', replace: '',
  caseSensitive: false, wholeWord: false, regexp: false,
};

/** Stop counting here. A one-character query in a 2MB log has no useful count,
 *  and walking every match of it on each keystroke is a frozen editor. */
const COUNT_CAP = 5000;

const matchMark = Decoration.mark({ class: 'cm-charon-match' });
const activeMark = Decoration.mark({ class: 'cm-charon-match cm-charon-match-on' });

/**
 * All matches, marked.
 *
 * `@codemirror/search` ships this already — but only while ITS docked panel is
 * open (`searchHighlighter` returns nothing when `panel` is null), and the
 * whole point here is that the panel is ours. Rebuilding it over the visible
 * ranges is a dozen lines and keeps the highlight tied to the query rather
 * than to a piece of UI we replaced.
 */
const matchHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.viewportChanged
        || u.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)))) {
      this.decorations = build(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

function build(view: EditorView): DecorationSet {
  const query = getSearchQuery(view.state);
  if (!query.valid) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection.main;
  // Visible ranges only: a match nobody can see costs nothing to skip, and
  // decorating a whole 40k-line file on every keystroke costs plenty.
  for (const { from, to } of view.visibleRanges) {
    const cursor = query.getCursor(view.state, from, to);
    for (let n = cursor.next(); !n.done; n = cursor.next()) {
      const m = n.value;
      builder.add(m.from, m.to, m.from === sel.from && m.to === sel.to ? activeMark : matchMark);
    }
  }
  return builder.finish();
}

function queryOf(f: Find): SearchQuery {
  return new SearchQuery({
    search: f.search,
    caseSensitive: f.caseSensitive,
    wholeWord: f.wholeWord,
    regexp: f.regexp,
    replace: f.replace,
    // Without this a plain search for `\n` would look for a newline. Regex is
    // the switch that turns escapes on, exactly as it does in VS Code.
    literal: !f.regexp,
  });
}

/**
 * The CodeMirror instance. Mounted only through `next/dynamic(ssr:false)` from
 * FileEditor — it is ~200KB and must stay out of the main chunk, and it touches
 * `document` at construction so it cannot render on the server either.
 *
 * Languages come from `@codemirror/language-data`, whose entries are dynamic
 * imports: opening a `.py` file pulls the Python mode and nothing else, so the
 * cost scales with what you actually open rather than with the list.
 *
 * Find/replace is ours rather than the library's (§14.84): the built-in panel
 * docks at the bottom of the editor and reflows the text under the cursor,
 * where the one everybody has muscle memory for floats over the top-right
 * corner and hides its replace row until asked. The COMMANDS are still the
 * library's — only the surface changed.
 */
export default function CodeEditor({
  doc, docKey, filename, readOnly, onChange, onSave, reveal, lsp, diagnostics, onOpenLocation,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const searchInput = useRef<HTMLInputElement | null>(null);
  const [find, setFind] = useState<Find>(FIND_CLOSED);
  const [count, setCount] = useState({ total: 0, index: 0, capped: false });
  // The keymap is built once, inside an editor that lives across renders — it
  // reads the live state through refs rather than being rebuilt for it.
  const findRef = useRef(find);
  findRef.current = find;
  const cbs = useRef({ onChange, onSave });
  cbs.current = { onChange, onSave };
  // The LSP target is read through a ref: the extensions are installed once
  // (reconfiguring CodeMirror per keystroke is worse than anything they buy)
  // and each of them no-ops while there is no server. §14.89
  const lspRef = useRef<LspTarget | null>(lsp ?? null);
  lspRef.current = lsp ?? null;
  const openLocRef = useRef(onOpenLocation);
  openLocRef.current = onOpenLocation;

  const openFind = useCallback((withReplace: boolean) => {
    const v = view.current;
    const sel = v ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) : '';
    setFind((prev) => ({
      ...prev,
      open: true,
      // Never expose replace on a file that cannot be saved — an editable-
      // looking field over a read-only buffer is a lie the user finds out late.
      replaceOpen: withReplace ? !readOnly : prev.replaceOpen,
      // A selection seeds the query, like every editor since the eighties —
      // but only a single-line one: a 40-line selection is a region, not a term.
      search: sel && !sel.includes('\n') ? sel : prev.search,
    }));
    // The input mounts in this same commit, so the focus has to wait for it.
    setTimeout(() => { searchInput.current?.focus(); searchInput.current?.select(); }, 0);
  }, [readOnly]);

  const closeFind = useCallback(() => {
    setFind((prev) => ({ ...prev, open: false }));
    view.current?.focus();
  }, []);

  const recount = useCallback(() => {
    const v = view.current;
    if (!v) return { total: 0, index: 0, capped: false };
    const query = getSearchQuery(v.state);
    if (!query.valid) {
      const none = { total: 0, index: 0, capped: false };
      setCount(none);
      return none;
    }
    const sel = v.state.selection.main;
    const cursor = query.getCursor(v.state);
    let total = 0;
    let index = 0;
    let capped = false;
    for (let n = cursor.next(); !n.done; n = cursor.next()) {
      total++;
      if (n.value.from === sel.from && n.value.to === sel.to) index = total;
      if (total >= COUNT_CAP) { capped = true; break; }
    }
    const next = { total, index, capped };
    setCount(next);
    return next;
  }, []);

  // The editor is built once and lives across renders, so the handlers it
  // closed over have to be reachable through refs — rebuilding the view to
  // pick up a new callback would throw away the cursor and the undo history.
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;
  const closeFindRef = useRef(closeFind);
  closeFindRef.current = closeFind;
  const recountRef = useRef(recount);
  recountRef.current = recount;

  // Build once per document identity. Rebuilding on every keystroke would
  // lose the cursor, the undo history and the scroll position.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          oneDark,
          // `basicSetup` binds the search KEYMAP but never installs the search
          // STATE — the built-in panel adds it on the fly. Ours is driven from
          // React, so the field has to be there from the start or the very
          // first `setSearchQuery` is a no-op.
          search({ literal: true }),
          matchHighlighter,
          ...lspExtensions({
            target: () => lspRef.current,
            onOpenLocation: (p, line) => openLocRef.current?.(p, line),
          }),
          // Highest precedence: these have to win over the bindings basicSetup
          // already made for Mod-f and Escape, or the docked panel we replaced
          // opens underneath ours.
          Prec.highest(keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { cbs.current.onSave(); return true; } },
            { key: 'Mod-f', preventDefault: true, run: () => { openFindRef.current(false); return true; } },
            { key: 'Mod-h', preventDefault: true, run: () => { openFindRef.current(true); return true; } },
            { key: 'Escape', run: () => { if (!findRef.current.open) return false; closeFindRef.current(); return true; } },
            // `withQuery` everywhere a search command is reached from a key:
            // with an empty find box these fall back to the library's docked
            // panel, which is the thing this widget replaced.
            { key: 'Mod-g', preventDefault: true, run: (ed) => { openFindRef.current(false); return withQuery(ed, findNext); } },
            { key: 'Shift-Mod-g', preventDefault: true, run: (ed) => { openFindRef.current(false); return withQuery(ed, findPrevious); } },
            { key: 'F3', preventDefault: true, run: (ed) => withQuery(ed, findNext) },
            { key: 'Shift-F3', preventDefault: true, run: (ed) => withQuery(ed, findPrevious) },
            indentWithTab,
          ])),
          language.current.of([]),
          editable.current.of(EditorView.editable.of(!readOnly)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbs.current.onChange(u.state.doc.toString());
            // The count is a property of (query, document, caret) — all three
            // move, so it is recomputed from the editor rather than tracked.
            if ((u.docChanged || u.selectionSet) && findRef.current.open) recountRef.current();
          }),
          EditorView.theme({
            // Let the app's panel colour through instead of one-dark's grey.
            '&': { backgroundColor: 'transparent', height: '100%' },
            '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12px', lineHeight: '1.55' },
            '.cm-gutters': {
              backgroundColor: 'transparent',
              borderRight: '1px solid rgba(216,168,90,0.15)',
              color: 'rgba(230,225,210,0.35)',
            },
            '.cm-activeLine': { backgroundColor: 'rgba(138,180,228,0.06)' },
            '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--gold-bright)' },
            '.cm-charon-match': { backgroundColor: 'rgba(138,180,228,0.22)', outline: '1px solid rgba(138,180,228,0.35)' },
            '.cm-charon-match-on': { backgroundColor: 'rgba(216,168,90,0.42)', outline: '1px solid var(--gold-bright)' },
          }, { dark: true }),
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // Language mode, resolved from the filename and loaded on demand.
  useEffect(() => {
    let alive = true;
    const desc = LanguageDescription.matchFilename(languages, filename);
    if (!desc) {
      view.current?.dispatch({ effects: language.current.reconfigure([]) });
      return;
    }
    desc.load().then((support) => {
      if (alive && view.current) {
        view.current.dispatch({ effects: language.current.reconfigure(support) });
      }
    }).catch(() => { /* an unknown mode is plain text, not an error */ });
    return () => { alive = false; };
  }, [filename, docKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!readOnly)) });
  }, [readOnly]);

  // The language server's problems. CodeMirror owns the view, so this is the
  // one place they cross over — and it is keyed on the array identity, so a
  // poll that answered "nothing changed" costs no dispatch. §14.89
  useEffect(() => {
    const v = view.current;
    if (v) applyDiagnostics(v, diagnostics ?? []);
  }, [diagnostics, docKey]);

  // Ctrl+F belongs to the PANE, not to the text area — the same reasoning as
  // Ctrl+S below it. Clicking the header, the save button or the tab and then
  // reaching for find must not hand the browser's own find bar the document.
  // Anything typed into a real field elsewhere (the panel's own search box) is
  // left alone, and so is the editor, which has its own binding.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'f' && k !== 'h') return;
      const el = e.target as HTMLElement | null;
      if (el && host.current?.contains(el)) return;  // the editor handles its own
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (el?.isContentEditable) return;
      e.preventDefault();
      openFindRef.current(k === 'h');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Jump to a line — a search hit, or any other pointer into this file. Runs
  // after the build effect above, which is why the view is there on mount.
  useEffect(() => {
    const v = view.current;
    if (!v || !reveal) return;
    const line = Math.max(1, Math.min(reveal.line, v.state.doc.lines));
    const at = v.state.doc.line(line);
    v.dispatch({
      selection: { anchor: at.from },
      effects: EditorView.scrollIntoView(at.from, { y: 'center' }),
    });
    v.focus();
  }, [reveal, docKey]);

  // The query IS the editor's search state — pushed down on every change so a
  // toggle, a keystroke and a paste all take effect the same way. Closing the
  // widget clears it: leaving twelve highlighted words behind after the user
  // dismissed the search is the behaviour nobody expects.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: setSearchQuery.of(find.open ? queryOf(find) : new SearchQuery({ search: '' })) });
    if (!find.open) return;
    // Land on a match as you type, the way every find bar does. Without it the
    // counter can only say "8 somewhere", the active-match highlight never
    // appears, and the first Enter costs an extra press to get going.
    // Idempotent: once a match is selected `index` is non-zero and this stops,
    // so it can never walk the document on its own.
    const c = recount();
    if (c.total > 0 && c.index === 0 && withQuery(v, findNext)) recount();
  }, [find, docKey, recount]);

  const step = useCallback((back: boolean) => {
    if (withQuery(view.current, back ? findPrevious : findNext)) recount();
  }, [recount]);

  const doReplace = useCallback((all: boolean) => {
    if (readOnly) return;
    if (withQuery(view.current, all ? replaceAll : replaceNext)) recount();
  }, [readOnly, recount]);

  const invalidRegex = find.regexp && find.search.length > 0 && !isValidRegex(find.search);

  return (
    <div className="cm-host">
      <div className="cm-mount" ref={host} />

      {find.open && (
        <div className="cm-find" role="search" onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
        }}>
          {!readOnly && (
            <button className="cmf-expand" title={find.replaceOpen ? 'hide replace' : 'show replace'}
                    aria-label={find.replaceOpen ? 'hide replace' : 'show replace'}
                    aria-expanded={find.replaceOpen}
                    onClick={() => setFind((p) => ({ ...p, replaceOpen: !p.replaceOpen }))}>
              <Chevron open={find.replaceOpen} />
            </button>
          )}

          {/* A two-column grid, not two rows: the find and replace fields have
              different numbers of buttons beside them, and laid out
              independently they end up different widths — which is the detail
              that makes a copy of this widget look like a copy. */}
          <div className="cmf-rows">
            <div className={`cmf-field ${invalidRegex ? 'bad' : ''}`}>
                <input
                  ref={searchInput}
                  value={find.search}
                  placeholder="Find"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="find"
                  onChange={(e) => setFind((p) => ({ ...p, search: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    step(e.shiftKey);
                  }}
                />
                <span className="cmf-flags">
                  <button className={find.caseSensitive ? 'on' : ''} title="Match Case" aria-label="Match Case"
                          aria-pressed={find.caseSensitive}
                          onClick={() => setFind((p) => ({ ...p, caseSensitive: !p.caseSensitive }))}>Aa</button>
                  <button className={find.wholeWord ? 'on' : ''} title="Match Whole Word" aria-label="Match Whole Word"
                          aria-pressed={find.wholeWord}
                          onClick={() => setFind((p) => ({ ...p, wholeWord: !p.wholeWord }))}>ab</button>
                  <button className={find.regexp ? 'on' : ''} title="Use Regular Expression" aria-label="Use Regular Expression"
                          aria-pressed={find.regexp}
                          onClick={() => setFind((p) => ({ ...p, regexp: !p.regexp }))}>.*</button>
              </span>
            </div>

            <div className="cmf-actions">
              <span className="cmf-count" aria-live="polite">
                {invalidRegex ? 'bad pattern'
                  : !find.search ? ''
                  : count.total === 0 ? 'No results'
                  : `${count.index || '?'} of ${count.total}${count.capped ? '+' : ''}`}
              </span>
              <button className="cmf-btn" title="Previous Match (Shift+Enter)" aria-label="previous match"
                      disabled={!count.total} onClick={() => step(true)}><ArrowUp /></button>
              <button className="cmf-btn" title="Next Match (Enter)" aria-label="next match"
                      disabled={!count.total} onClick={() => step(false)}><ArrowDown /></button>
              <button className="cmf-btn" title="Close (Escape)" aria-label="close find"
                      onClick={closeFind}><Cross /></button>
            </div>

            {find.replaceOpen && !readOnly && (
              <>
                <div className="cmf-field">
                  <input
                    value={find.replace}
                    placeholder="Replace"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="replace"
                    onChange={(e) => setFind((p) => ({ ...p, replace: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      doReplace(e.ctrlKey || e.metaKey || e.altKey);
                    }}
                  />
                </div>
                <div className="cmf-actions">
                  <button className="cmf-btn" title="Replace (Enter)" aria-label="replace"
                          disabled={!count.total} onClick={() => doReplace(false)}><ReplaceOne /></button>
                  <button className="cmf-btn" title="Replace All (Ctrl+Enter)" aria-label="replace all"
                          disabled={!count.total} onClick={() => doReplace(true)}><ReplaceAll /></button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function isValidRegex(src: string): boolean {
  try { new RegExp(src); return true; } catch { return false; }
}

/**
 * Run a `@codemirror/search` command, but ONLY with a query it can use.
 *
 * Every one of them (`findNext`, `replaceAll`, …) is wrapped in the library's
 * `searchCommand`, whose fallback for an unusable query is
 * `openSearchPanel(view)` — the docked panel this widget exists to replace.
 * So an empty find box plus any of these calls pops the library's own bar up
 * at the bottom of the editor, next to ours. Guarding here is what keeps that
 * fallback unreachable.
 */
function withQuery(view: EditorView | null, fn: (v: EditorView) => boolean): boolean {
  if (!view || !getSearchQuery(view.state).valid) return false;
  return fn(view);
}

// Local to this chunk on purpose: the widget is inside the lazily-loaded
// editor, and these six glyphs have no second caller to justify shipping them
// in the shared icon module.
type G = { className?: string };
const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden
       style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>
    <path d="M5.7 3.3 10.4 8l-4.7 4.7-1-1L8.4 8 4.7 4.3z" />
  </svg>
);
const ArrowUp = (p: G) => (
  <svg {...p} viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden>
    <path d="M8 3.5 13 9l-1 1-4-4.2L4 10l-1-1z" />
  </svg>
);
const ArrowDown = (p: G) => (
  <svg {...p} viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden>
    <path d="M8 12.5 3 7l1-1 4 4.2L12 6l1 1z" />
  </svg>
);
const Cross = (p: G) => (
  <svg {...p} viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden>
    <path d="M4.3 3.3 8 7l3.7-3.7 1 1L9 8l3.7 3.7-1 1L8 9l-3.7 3.7-1-1L7 8 3.3 4.3z" />
  </svg>
);
const ReplaceOne = (p: G) => (
  <svg {...p} viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden>
    <path d="M3 2h6v1.5H4.5V7H3zM3 9h1.5v3.5H9V14H3z" />
    <path d="M10.5 4.2 13.8 7.5l-3.3 3.3-1-1 1.6-1.6H7v-1.4h4.1L9.5 5.2z" />
  </svg>
);
const ReplaceAll = (p: G) => (
  <svg {...p} viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden>
    <path d="M2 2h5v1.4H3.4V7H2zM2 9h1.4v3.6H7V14H2z" />
    <path d="M9.6 3.2 12.9 6.5 9.6 9.8l-1-1L10.2 7.2H6.2V5.8h4L8.6 4.2z" />
    <path d="M9.6 10.2h4.4v1.4H9.6z" />
  </svg>
);
