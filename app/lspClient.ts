'use client';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { linter, lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { Decoration, EditorView, hoverTooltip, keymap } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { api } from '@/lib/api';
import type { LspDiagnostic, LspLocation } from '@/lib/types/api';

/**
 * CodeMirror ⇄ language server, over the hub (§14.89).
 *
 * The server itself runs on the VPS next to the code; this is only the client
 * half — position mapping, the four features worth the round trip, and the
 * rule that none of them may ever block typing.
 *
 * Everything here is best-effort by construction: a failed request returns
 * nothing rather than an error, because a language server that is slow, dead
 * or absent must degrade to "an editor without squiggles", never to a broken
 * editor.
 */
export type LspTarget = {
  vpsId: string;
  /** Project root — what the server was started on. */
  root: string;
  /** Absolute path of the open file. */
  path: string;
};

// ── position mapping ───────────────────────────────────────────────────────
// LSP counts lines from 0 and characters in UTF-16 code units. A JS string is
// UTF-16, so `pos - line.from` is already the right unit; only the line base
// differs.
export function posToLsp(view: EditorView, pos: number): { line: number; character: number } {
  const line = view.state.doc.lineAt(pos);
  return { line: line.number - 1, character: pos - line.from };
}

export function lspToPos(view: EditorView, p: { line: number; character: number }): number {
  const doc = view.state.doc;
  const lineNo = Math.max(1, Math.min(doc.lines, (p.line ?? 0) + 1));
  const line = doc.line(lineNo);
  return Math.min(line.to, line.from + Math.max(0, p.character ?? 0));
}

const SEVERITY: Record<number, Diagnostic['severity']> = {
  1: 'error', 2: 'warning', 3: 'info', 4: 'hint',
};

/** LSP diagnostics → CodeMirror diagnostics, clamped to the current document. */
export function toCmDiagnostics(view: EditorView, list: LspDiagnostic[]): Diagnostic[] {
  const max = view.state.doc.length;
  const out: Diagnostic[] = [];
  for (const d of list) {
    if (!d?.range) continue;
    const from = Math.min(max, lspToPos(view, d.range.start));
    let to = Math.min(max, lspToPos(view, d.range.end));
    // A zero-width diagnostic renders as nothing at all; widen it by one so
    // "unexpected end of file" is still visible.
    if (to <= from) to = Math.min(max, from + 1);
    out.push({
      from, to,
      severity: SEVERITY[d.severity ?? 1] ?? 'error',
      message: d.source ? `${d.message}  (${d.source})` : d.message,
    });
  }
  return out;
}

/** Push a fresh set of diagnostics into a live editor. */
export function applyDiagnostics(view: EditorView, list: LspDiagnostic[]): void {
  view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view, list)));
}

// ── hover / definition / completion ────────────────────────────────────────
function hoverText(result: unknown): string | null {
  const c = (result as { contents?: unknown } | null)?.contents;
  if (!c) return null;
  const one = (x: unknown): string => {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object' && 'value' in x) return String((x as { value: unknown }).value ?? '');
    return '';
  };
  const text = Array.isArray(c) ? c.map(one).filter(Boolean).join('\n\n') : one(c);
  return text.trim() || null;
}

/**
 * EVERY Location in whatever shape the server chose to answer with.
 *
 * All of them, not the first: a symbol with three definitions (an overload, an
 * interface and its implementation) is exactly when jumping blind is wrong —
 * the caller shows a picker instead. Servers answer as a Location, a
 * Location[], or a LocationLink[] with different field names; all three are
 * normalised here.
 */
export function parseLocations(result: unknown): LspLocation[] {
  const pick = (loc: Record<string, unknown> | null | undefined): LspLocation | null => {
    if (!loc) return null;
    const uri = String(loc.uri ?? loc.targetUri ?? '');
    const range = (loc.range ?? loc.targetSelectionRange ?? loc.targetRange) as
      { start?: { line?: number; character?: number } } | undefined;
    if (!uri.startsWith('file://')) return null;
    return {
      path: decodeURIComponent(uri.slice('file://'.length)),
      line: (range?.start?.line ?? 0) + 1,
      character: range?.start?.character ?? 0,
      // Attached agent-side: reading the line there is microseconds, from here
      // it would be a round trip per result (§14.90).
      preview: typeof loc.preview === 'string' ? loc.preview : undefined,
    };
  };
  const items = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  const seen = new Set<string>();
  for (const x of items) {
    const got = pick(x as Record<string, unknown>);
    // The same line twice (a server listing a declaration and its definition
    // at the same spot) is one entry as far as a chooser is concerned.
    if (got && !seen.has(`${got.path}:${got.line}`)) { seen.add(`${got.path}:${got.line}`); out.push(got); }
  }
  return out;
}

/** The word under a position, found locally — no round trip to draw a link. */
export function wordRangeAt(view: EditorView, pos: number): { from: number; to: number } | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  let i = pos - line.from;
  const isWord = (c: string) => /[\w$]/.test(c);
  if (i > 0 && !isWord(text[i] ?? '') && isWord(text[i - 1] ?? '')) i--;
  if (!isWord(text[i] ?? '')) return null;
  let from = i;
  let to = i;
  while (from > 0 && isWord(text[from - 1])) from--;
  while (to < text.length && isWord(text[to])) to++;
  return { from: line.from + from, to: line.from + to };
}

const KIND_LABEL: Record<number, string> = {
  1: 'text', 2: 'method', 3: 'function', 4: 'constructor', 5: 'field', 6: 'variable',
  7: 'class', 8: 'interface', 9: 'module', 10: 'property', 11: 'unit', 12: 'value',
  13: 'enum', 14: 'keyword', 15: 'snippet', 16: 'color', 17: 'file', 18: 'reference',
  21: 'constant', 22: 'struct', 23: 'event', 25: 'type',
};

/**
 * Every LSP-backed editor extension, or none.
 *
 * `enabled` is read through a ref by the caller: the extensions are installed
 * once (a CodeMirror reconfiguration per keystroke would be worse than any of
 * this) and each one no-ops while there is no server.
 */
/** A ctrl/cmd-held pointer over a symbol: underline it and make it a link. */
const linkMark = Decoration.mark({ class: 'cm-lsp-link' });
const setLinkRange = StateEffect.define<{ from: number; to: number } | null>();
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setLinkRange)) {
        value = e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    // Any edit invalidates the highlight: the token under the pointer moved.
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Every LSP-backed editor extension, or none.
 *
 * The target is read through a getter: the extensions are installed once (a
 * CodeMirror reconfiguration per keystroke would be worse than anything they
 * buy) and each one no-ops while there is no server.
 */
export function lspExtensions(opts: {
  target: () => LspTarget | null;
  /** One place: go there. Several: the caller shows a picker. */
  onLocations?: (locations: LspLocation[], title: string) => void;
  /** F2 — the caller asks for a new name and applies the WorkspaceEdit. */
  onRename?: (pos: { line: number; character: number }, word: string) => void;
  /** Ctrl+Shift+O — the caller shows the symbol list. */
  onSymbols?: (result: unknown) => void;
}): Extension[] {
  const req = async (method: string, extra: Record<string, unknown>) => {
    const t = opts.target();
    if (!t) return null;
    try {
      const r = await api.lspRequest(t.vpsId, { root: t.root, path: t.path, method, ...extra });
      return r.ok ? r.result : null;
    } catch {
      return null;                    // an editor without squiggles, never a broken one
    }
  };

  /** Definition (or references), handed to the caller as a LIST. */
  const locate = async (view: EditorView, pos: number, method: string, title: string) => {
    if (!opts.onLocations) return false;
    const result = await req(method, { position: posToLsp(view, pos) });
    const locs = parseLocations(result);
    if (locs.length === 0) return false;
    opts.onLocations(locs, title);
    return true;
  };

  const wordAt = (view: EditorView, pos: number) => {
    const r = wordRangeAt(view, pos);
    return r ? view.state.sliceDoc(r.from, r.to) : '';
  };

  return [
    linkField,
    // The lint state has to exist for `setDiagnostics` to have somewhere to
    // go. The source itself never produces anything — the diagnostics come
    // from the server, pushed in from React.
    linter(() => [], { delay: 1e9 }),
    lintGutter(),

    hoverTooltip(async (view, pos) => {
      const result = await req('textDocument/hover', { position: posToLsp(view, pos) });
      const text = hoverText(result);
      if (!text) return null;
      return {
        pos,
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'cm-lsp-hover';
          // Markdown fences are the common wrapper; the content is a type
          // signature, so plain text in a <pre> is the honest rendering.
          dom.textContent = text.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();
          return { dom };
        },
      };
    }, { hideOnChange: true }),

    autocompletion({
      override: [async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        const t = opts.target();
        if (!t) return null;
        const word = ctx.matchBefore(/[\w$.]+/);
        // Only on an explicit request or after a real prefix: asking the
        // server on every keystroke in whitespace is a lot of ssh round trips
        // for nothing.
        if (!ctx.explicit && (!word || word.from === word.to)) return null;
        // `ctx.view` is optional in the CompletionContext type (a source can be
        // called without one); without a view there is no position to ask about.
        if (!ctx.view) return null;
        const result = await req('textDocument/completion', { position: posToLsp(ctx.view, ctx.pos) });
        const items = (Array.isArray(result) ? result : (result as { items?: unknown[] } | null)?.items) ?? [];
        if (!Array.isArray(items) || items.length === 0) return null;
        return {
          from: word ? word.from : ctx.pos,
          options: items.slice(0, 200).map((raw) => {
            const it = raw as Record<string, unknown>;
            const label = String(it.label ?? '');
            return {
              label,
              type: KIND_LABEL[Number(it.kind)] ?? undefined,
              detail: typeof it.detail === 'string' ? it.detail.slice(0, 80) : undefined,
              apply: typeof it.insertText === 'string' && !it.textEdit ? it.insertText : label,
            };
          }),
          validFor: /^[\w$]*$/,
        };
      }],
    }),

    keymap.of([
      { key: 'F12', preventDefault: true, run: (v) => { void locate(v, v.state.selection.main.head, 'textDocument/definition', 'Definition'); return true; } },
      { key: 'Mod-b', preventDefault: true, run: (v) => { void locate(v, v.state.selection.main.head, 'textDocument/definition', 'Definition'); return true; } },
      { key: 'Shift-F12', preventDefault: true, run: (v) => { void locate(v, v.state.selection.main.head, 'textDocument/references', 'References'); return true; } },
      { key: 'Mod-Shift-b', preventDefault: true, run: (v) => { void locate(v, v.state.selection.main.head, 'textDocument/references', 'References'); return true; } },
      {
        key: 'F2',
        preventDefault: true,
        run: (v) => {
          if (!opts.onRename) return false;
          const head = v.state.selection.main.head;
          const word = wordAt(v, head);
          if (!word) return false;
          opts.onRename(posToLsp(v, head), word);
          return true;
        },
      },
      {
        key: 'Mod-Shift-o',
        preventDefault: true,
        run: (v) => {
          if (!opts.onSymbols) return false;
          void req('textDocument/documentSymbol', {}).then((r) => opts.onSymbols?.(r));
          return true;
        },
      },
    ]),

    /**
     * The ctrl/cmd-hover affordance: underline the token and turn the caret
     * into a pointer, so a clickable symbol LOOKS clickable. The range is
     * computed locally — asking the server on every mouse move to draw a line
     * would be one round trip per pixel.
     */
    EditorView.domEventHandlers({
      mousemove(event, view) {
        const held = event.metaKey || event.ctrlKey;
        const cur = view.state.field(linkField, false);
        if (!held || !opts.target()) {
          if (cur && cur.size) view.dispatch({ effects: setLinkRange.of(null) });
          return false;
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const range = pos == null ? null : wordRangeAt(view, pos);
        // Only dispatch when the range actually moved, or a mousemove storm
        // becomes a transaction storm.
        let same = false;
        if (cur) cur.between(range?.from ?? -1, range?.to ?? -1, () => { same = true; });
        if (range && same) return false;
        view.dispatch({ effects: setLinkRange.of(range) });
        return false;
      },
      mouseleave(_event, view) {
        view.dispatch({ effects: setLinkRange.of(null) });
        return false;
      },
      keyup(_event, view) {
        const cur = view.state.field(linkField, false);
        if (cur && cur.size) view.dispatch({ effects: setLinkRange.of(null) });
        return false;
      },
      mousedown(event, view) {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        event.preventDefault();
        view.dispatch({ effects: setLinkRange.of(null) });
        // Shift widens it to "everywhere this is used", the way it does in
        // every editor that has both.
        void locate(view, pos, event.shiftKey ? 'textDocument/references' : 'textDocument/definition',
          event.shiftKey ? 'References' : 'Definition');
        return true;
      },
    }),
  ];
}

/** Ask the server to rename a symbol; returns the WorkspaceEdit's changes. */
export async function requestRename(
  t: LspTarget, position: { line: number; character: number }, newName: string,
): Promise<{ ok: boolean; changes?: Record<string, unknown[]>; error?: string }> {
  try {
    const r = await api.lspRequest(t.vpsId, {
      root: t.root, path: t.path, method: 'textDocument/rename',
      position, extra: { newName },
    });
    if (!r.ok) return { ok: false, error: r.error };
    const we = (r.result ?? {}) as Record<string, unknown>;
    // A WorkspaceEdit is `changes` (uri → edits) or `documentChanges`
    // (a list of {textDocument, edits}). Servers pick one; we take both.
    let changes = (we.changes ?? null) as Record<string, unknown[]> | null;
    if (!changes && Array.isArray(we.documentChanges)) {
      changes = {};
      for (const dc of we.documentChanges as Record<string, unknown>[]) {
        const uri = String((dc.textDocument as Record<string, unknown> | undefined)?.uri ?? '');
        if (uri && Array.isArray(dc.edits)) changes[uri] = dc.edits as unknown[];
      }
    }
    if (!changes || Object.keys(changes).length === 0) {
      return { ok: false, error: 'the server refused to rename this symbol' };
    }
    return { ok: true, changes };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Ask the server to format the whole document; returns the edits. */
export async function requestFormat(
  t: LspTarget, indentSize = 2,
): Promise<{ ok: boolean; edits?: unknown[]; error?: string }> {
  try {
    const r = await api.lspRequest(t.vpsId, {
      root: t.root, path: t.path, method: 'textDocument/formatting',
      extra: { options: { tabSize: indentSize, insertSpaces: true } },
    });
    if (!r.ok) return { ok: false, error: r.error };
    const edits = Array.isArray(r.result) ? r.result : [];
    return { ok: true, edits };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Flatten a DocumentSymbol tree (or a flat SymbolInformation list). */
export type FlatSymbol = { name: string; detail?: string; kind: number; line: number; depth: number };
export function flattenSymbols(result: unknown, depth = 0): FlatSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: FlatSymbol[] = [];
  for (const raw of result) {
    const s = raw as Record<string, unknown>;
    const range = (s.selectionRange ?? s.range
      ?? (s.location as Record<string, unknown> | undefined)?.range) as
      { start?: { line?: number } } | undefined;
    out.push({
      name: String(s.name ?? ''),
      detail: typeof s.detail === 'string' ? s.detail : undefined,
      kind: Number(s.kind) || 0,
      line: (range?.start?.line ?? 0) + 1,
      depth,
    });
    if (Array.isArray(s.children)) out.push(...flattenSymbols(s.children, depth + 1));
  }
  return out;
}

export const SYMBOL_KIND: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method',
  7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface',
  12: 'function', 13: 'variable', 14: 'constant', 15: 'string', 16: 'number',
  17: 'boolean', 18: 'array', 19: 'object', 20: 'key', 21: 'null',
  22: 'enum member', 23: 'struct', 24: 'event', 25: 'operator', 26: 'type',
};
