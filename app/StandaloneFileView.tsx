'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fmtSize } from './sessionAttachments';
import { IconDownload, IconFullscreen, IconFullscreenExit } from './icons';
import CsvViewer from './CsvViewer';
import { BytesView, LogViewer, TextView } from './FileViewers';
import { viewerFor } from './fileViews';
import { MarkdownMarginsToggle } from './markdownMargins';

/** Same cadence as the pane's change probe (FileEditor). */
const POLL_MS = 10_000;

type Props = {
  vpsId: string;
  root: string;
  /** Relative to `root`. */
  path: string;
};

/**
 * One file, full window, in a browser tab of its own (`/view`) — the pane's
 * viewer without the hub around it. HTML never lands here: the page redirects
 * it to its live view (§14.110). Read-only but for a workbook's own save;
 * follows the file on the VPS like the pane does (a recompiled PDF reloads).
 */
export default function StandaloneFileView({ vpsId, root, path }: Props) {
  const name = path.split('/').pop() || path;
  const spec = viewerFor(name);
  const bytesKind = spec?.source === 'bytes' ? spec.kind : null;
  const textKind = spec?.source === 'text' ? spec.kind : null;
  const tabular = !spec && /\.(csv|tsv)$/i.test(name);
  // The log view reads ranges itself; every other text view needs the text.
  const needsText = tabular || (!!textKind && textKind !== 'log');

  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [size, setSize] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const [dirty, setDirty] = useState(false);
  const versionRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.readFsFile(vpsId, root, path);
      if (!r.ok) { setErr(r.error ?? 'could not read this file'); return; }
      setSize(r.size ?? null);
      if (r.version) versionRef.current = r.version;
      if (r.binary) { setErr('this file is binary — it has no rendered view'); return; }
      if (r.tooLarge || r.content == null) { setErr('too large to render here — use Download'); return; }
      setErr(null);
      setTruncated(!!r.truncated);
      setText(r.content);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [vpsId, root, path]);
  useEffect(() => { if (needsText) void load(); }, [needsText, load]);

  // Follow the file on the VPS: bytes viewers fetch again on `rev`, text is
  // read again; the log view follows on its own. Only while visible.
  useEffect(() => {
    let busy = false;
    let alive = true;
    const probe = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const s = await api.statFsFile(vpsId, root, path);
        if (!alive || !s.ok) return;
        if (s.exists === false) { setNote('this file was deleted on the VPS'); return; }
        if (s.size != null && !needsText) setSize(s.size);
        if (!s.version) return;
        if (versionRef.current == null) { versionRef.current = s.version; return; }
        if (s.version === versionRef.current) return;
        versionRef.current = s.version;
        setNote('reloaded — the file changed on the VPS');
        if (bytesKind) setRev((n) => n + 1);
        else if (needsText) await load();
      } catch {
        // Advisory, like the pane's probe: offline is not an error here.
      } finally {
        busy = false;
      }
    };
    void probe();
    const timer = window.setInterval(() => { void probe(); }, POLL_MS);
    const wake = () => { if (document.visibilityState === 'visible') void probe(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [vpsId, root, path, bytesKind, needsText, load]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  // A workbook with unsaved cells (the one viewer that edits) asks first.
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  // The browser's own full screen, on top of the full window. iOS has none
  // for a page: the button is not offered there.
  const [canFull, setCanFull] = useState(false);
  const [full, setFull] = useState(false);
  useEffect(() => {
    setCanFull(!!document.fullscreenEnabled);
    const sync = () => setFull(!!document.fullscreenElement);
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  const inlineUrl = api.fsFileUrl(vpsId, root, path, { inline: true });
  const rawUrl = api.fsFileUrl(vpsId, root, path);
  const mediaSrc = rev ? `${inlineUrl}&v=${rev}` : inlineUrl;
  const abs = `${root.replace(/\/+$/, '')}/${path}`;

  return (
    <div className="sfv file-editor">
      <header className="fe-head">
        <span className="fe-title">
          <span className="fe-path" title={abs}>{path}</span>
        </span>
        {dirty && <span className="fe-dirty" title="unsaved changes">●</span>}
        {note && <span className="sfv-note">{note}</span>}
        {size != null && <span className="fe-size">{fmtSize(size)}</span>}
        {textKind === 'markdown' && text != null && !err && <MarkdownMarginsToggle />}
        {canFull && (
          <button type="button" className="fe-open" onClick={toggleFull}
                  title={full ? 'Leave full screen (Esc)' : 'Full screen: the document and nothing else'}>
            {full ? <IconFullscreenExit /> : <IconFullscreen />} {full ? 'Exit full screen' : 'Full screen'}
          </button>
        )}
        <a className="fe-dl" href={rawUrl} download={name} title={`download ${name}`}>
          <IconDownload /> Download
        </a>
      </header>
      <div className="fe-body">
        {err && <div className="dvm-note err">{err}</div>}
        {bytesKind && (
          <BytesView
            kind={bytesKind}
            props={{ vpsId, root, path, name, url: rawUrl, rev, active: true, onDirtyChange: setDirty }}
            mediaSrc={mediaSrc}
          />
        )}
        {textKind === 'log' && <LogViewer vpsId={vpsId} root={root} path={path} follow active />}
        {needsText && text != null && !err && (
          <>
            {truncated && <div className="dvm-note warn">⚠ only the first part of this file is shown</div>}
            {tabular
              ? <CsvViewer text={text} filename={name} storageKey={`${vpsId}:${root}:${path}`} />
              : textKind && <TextView kind={textKind} props={{ vpsId, root, path, name, text, active: true }} />}
          </>
        )}
        {needsText && text == null && !err && <div className="dvm-note">loading…</div>}
      </div>
    </div>
  );
}
