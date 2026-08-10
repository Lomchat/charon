'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import type { FsReadResponse } from '@/lib/types/api';
import { fileKind, isMediaName } from './fileIcons';
import { fmtSize } from './sessionAttachments';
import { setTabDirty } from './tabStore';
import { refreshGit } from './gitStore';

// ~200KB and touches `document` at construction — never in the main chunk,
// never on the server. A failed lazy import after a deploy is caught by
// ChunkReloadGuard (§14.57).
const CodeEditor = dynamic(() => import('./CodeEditor'), {
  ssr: false,
  loading: () => <div className="dvm-note">loading editor…</div>,
});

type Props = {
  tabId: string;
  vpsId: string;
  /** Containment root — the tab's group path. */
  root: string;
  /** Path relative to `root`. */
  path: string;
  /** Called on the first edit and on a save: both mean "this is not a preview". */
  onInteract: () => void;
};

type Conflict = { serverSha: string | null };

/**
 * The file pane: read, edit, Ctrl+S.
 *
 * The save is gated on the sha the read returned. That is not belt-and-braces
 * on these boxes — a coding agent may be writing this very file, and an
 * unconditional write would silently discard whichever side was slower. On a
 * mismatch the user gets the choice explicitly (reload / overwrite) instead of
 * one of the two losing quietly.
 *
 * Media and binaries stay read-only: an editor for bytes is a different
 * feature, and pretending otherwise would let someone corrupt a PNG by typing.
 */
export default function FileEditor({ tabId, vpsId, root, path, onInteract }: Props) {
  const [res, setRes] = useState<FsReadResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [dirty, setDirty] = useState(false);
  // `docKey` identifies the buffer the editor was built from; bumping it is
  // what makes CodeMirror take a new document (after a reload or a save).
  const [docKey, setDocKey] = useState(0);

  const name = path.split('/').pop() || path;
  const media = isMediaName(name);
  const kind = fileKind(name, false);
  // Live buffer. A ref, not state: the editor already owns the text, and
  // re-rendering this component on every keystroke is exactly the lag §14.38
  // is about.
  const buf = useRef('');
  const shaRef = useRef<string | null>(null);
  const inlineUrl = api.fsFileUrl(vpsId, root, path, { inline: true });
  const rawUrl = api.fsFileUrl(vpsId, root, path);

  const markDirty = useCallback((v: boolean) => {
    setDirty(v);
    setTabDirty(tabId, v);
  }, [tabId]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setNote(null);
    try {
      const r = await api.readFsFile(vpsId, root, path);
      if (!r.ok) { setErr(r.error ?? 'could not read this file'); setRes(null); return; }
      setRes(r);
      buf.current = r.content ?? '';
      shaRef.current = r.sha256 ?? null;
      markDirty(false);
      setDocKey((k) => k + 1);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [vpsId, root, path, markDirty]);

  useEffect(() => { if (!media) void load(); else setLoading(false); }, [load, media]);
  // Leaving the file behind must clear its badge, or a closed editor keeps a
  // dot on a tab nobody can save.
  useEffect(() => () => setTabDirty(tabId, false), [tabId]);

  const save = useCallback(async (force = false) => {
    if (saving || media) return;
    setSaving(true);
    setNote(null);
    try {
      const r = await api.writeFsFile(vpsId, {
        root, path, content: buf.current,
        ...(force ? {} : { expectedSha256: shaRef.current ?? '' }),
      });
      if (r.ok) {
        shaRef.current = r.sha256 ?? null;
        markDirty(false);
        setConflict(null);
        setNote({ kind: 'ok', text: 'saved' });
        // Saving is a real interaction: the tab stops being a preview, and the
        // repo just got dirtier (or cleaner) so the chip must not wait.
        onInteract();
        refreshGit(vpsId, root);
      } else if (r.reason === 'stale') {
        setConflict({ serverSha: r.sha256 ?? null });
      } else {
        setNote({ kind: 'err', text: r.error ?? 'could not save' });
      }
    } catch (e: unknown) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [vpsId, root, path, saving, media, markDirty, onInteract]);

  // Ctrl+S also works when focus is outside CodeMirror (the header, a button)
  // — the shortcut belongs to the pane, not to the text area.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const onChange = useCallback((next: string) => {
    buf.current = next;
    if (!dirty) { markDirty(true); onInteract(); }
  }, [dirty, markDirty, onInteract]);

  const readOnly = !!res?.tooLarge || !!res?.binary;

  return (
    <div className="file-editor">
      <header className="fe-head">
        <span className="fe-path" title={`${root}/${path}`}>{path}</span>
        {dirty && <span className="fe-dirty" title="unsaved changes">●</span>}
        {res?.size != null && <span className="fe-size">{fmtSize(res.size)}</span>}
        {!media && !readOnly && (
          <button className="fe-save" onClick={() => save()} disabled={saving || !dirty}
                  title="save to the VPS (Ctrl+S)">
            {saving ? 'saving…' : 'save'}
          </button>
        )}
        <a className="fe-dl" href={rawUrl} download={name} title="download">get</a>
      </header>

      {note && <div className={`fe-note ${note.kind}`}>{note.text}</div>}

      {conflict && (
        <div className="fe-conflict">
          <b>This file changed on the VPS since you opened it.</b>
          <span>
            Something else — most likely an agent working in this repo — wrote to
            it. Reloading discards your edits; overwriting discards theirs.
          </span>
          <div className="fe-conflict-actions">
            <button onClick={() => { setConflict(null); void load(); }}>reload from the VPS</button>
            <button className="danger" onClick={() => { setConflict(null); void save(true); }}>
              overwrite with my version
            </button>
            <button onClick={() => setConflict(null)}>keep editing</button>
          </div>
        </div>
      )}

      <div className="fe-body">
        {loading && <div className="dvm-note">loading…</div>}
        {err && <div className="dvm-note err">{err}</div>}

        {media && (
          <div className="fvm-media">
            {kind === 'image' && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={inlineUrl} alt={name} />
            )}
            {kind === 'audio' && <audio src={inlineUrl} controls />}
            {kind === 'video' && <video src={inlineUrl} controls />}
            {kind === 'pdf' && <iframe src={inlineUrl} title={name} />}
          </div>
        )}

        {!media && res?.tooLarge && (
          <div className="dvm-note warn">
            too large to open ({fmtSize(res.size ?? 0)}) — use the download button
          </div>
        )}
        {!media && res && !res.tooLarge && res.binary && (
          <div className="dvm-note">binary file ({fmtSize(res.size ?? 0)}) — no preview for this type</div>
        )}
        {!media && res && !res.binary && !res.tooLarge && res.content != null && (
          <>
            {res.truncated && (
              <div className="dvm-note warn">
                ⚠ only the first part of this file is shown — saving would truncate it, so it is read-only
              </div>
            )}
            <CodeEditor
              doc={res.content}
              docKey={`${vpsId}:${root}:${path}:${docKey}`}
              filename={name}
              readOnly={!!res.truncated}
              onChange={onChange}
              onSave={() => void save()}
            />
          </>
        )}
      </div>
    </div>
  );
}
