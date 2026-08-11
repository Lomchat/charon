'use client';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { linter, lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorView, hoverTooltip, keymap } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { api } from '@/lib/api';
import type { LspDiagnostic } from '@/lib/types/api';

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

/** The first Location in whatever shape the server chose to answer with. */
function firstLocation(result: unknown): { path: string; line: number } | null {
  const pick = (loc: Record<string, unknown> | null | undefined) => {
    if (!loc) return null;
    const uri = String(loc.uri ?? loc.targetUri ?? '');
    const range = (loc.range ?? loc.targetSelectionRange ?? loc.targetRange) as
      { start?: { line?: number } } | undefined;
    if (!uri.startsWith('file://')) return null;
    return { path: decodeURIComponent(uri.slice('file://'.length)), line: (range?.start?.line ?? 0) + 1 };
  };
  if (Array.isArray(result)) {
    for (const x of result) {
      const got = pick(x as Record<string, unknown>);
      if (got) return got;
    }
    return null;
  }
  return pick(result as Record<string, unknown>);
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
export function lspExtensions(opts: {
  target: () => LspTarget | null;
  onOpenLocation?: (path: string, line: number) => void;
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

  const jump = async (view: EditorView, pos: number): Promise<boolean> => {
    const t = opts.target();
    if (!t || !opts.onOpenLocation) return false;
    const result = await req('textDocument/definition', { position: posToLsp(view, pos) });
    const loc = firstLocation(result);
    if (!loc) return false;
    opts.onOpenLocation(loc.path, loc.line);
    return true;
  };

  return [
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
      { key: 'F12', preventDefault: true, run: (view) => { void jump(view, view.state.selection.main.head); return true; } },
      { key: 'Mod-b', preventDefault: true, run: (view) => { void jump(view, view.state.selection.main.head); return true; } },
    ]),

    // Ctrl/Cmd+click is the gesture everyone actually uses.
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        event.preventDefault();
        void jump(view, pos);
        return true;
      },
    }),
  ];
}
