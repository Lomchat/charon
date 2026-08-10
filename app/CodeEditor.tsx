'use client';
import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';

type Props = {
  /** Initial document. Changing `docKey` is what forces a reload. */
  doc: string;
  docKey: string;
  filename: string;
  readOnly?: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
};

/**
 * The CodeMirror instance. Mounted only through `next/dynamic(ssr:false)` from
 * FileEditor — it is ~200KB and must stay out of the main chunk, and it touches
 * `document` at construction so it cannot render on the server either.
 *
 * Languages come from `@codemirror/language-data`, whose entries are dynamic
 * imports: opening a `.py` file pulls the Python mode and nothing else, so the
 * cost scales with what you actually open rather than with the list.
 */
export default function CodeEditor({ doc, docKey, filename, readOnly, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const editable = useRef(new Compartment());
  // The callbacks are re-created on every parent render; the listener closes
  // over a ref so the editor never has to be torn down to pick up a new one.
  const cbs = useRef({ onChange, onSave });
  cbs.current = { onChange, onSave };

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
          // Ctrl/Cmd+S must reach us and NOT the browser's save-page dialog.
          // High precedence so it wins over anything basicSetup binds.
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { cbs.current.onSave(); return true; } },
            indentWithTab,
          ]),
          language.current.of([]),
          editable.current.of(EditorView.editable.of(!readOnly)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbs.current.onChange(u.state.doc.toString());
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

  return <div className="cm-host" ref={host} />;
}
