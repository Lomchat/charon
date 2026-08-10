'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { FsReadResponse } from '@/lib/types/api';
import { fileKind, isMediaName } from './fileIcons';
import { fmtSize } from './sessionAttachments';

type Props = {
  vpsId: string;
  root: string;
  path: string;
  name: string;
  /** Known from the tree listing — media skips the JSON read, so without this
      the header would have no size to show for exactly the files where the
      size matters most. */
  size?: number;
  onClose: () => void;
};

/**
 * Read-only viewer for one file out of the explorer.
 *
 * Two transports on purpose. Text comes back through the JSON RPC, because the
 * viewer needs `truncated` / `tooLarge` alongside the content — a viewer that
 * shows the first 2MB of a 40MB log without saying so is worse than one that
 * refuses. Media (image / audio / video / pdf) is pointed straight at the byte
 * route as an element `src`, so the browser streams and decodes it instead of
 * us base64-ing megabytes through React state.
 *
 * The byte route serves user content, so it is locked down the way the
 * attachment preview is (extension-keyed content-type, nosniff, CSP sandbox —
 * §14.73). Anything outside that allow-list stays a download.
 */
export default function FileViewerModal({ vpsId, root, path, name, size, onClose }: Props) {
  const [res, setRes] = useState<FsReadResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const kind = fileKind(name, false);
  const media = isMediaName(name);
  const inlineUrl = api.fsFileUrl(vpsId, root, path, { inline: true });
  const rawUrl = api.fsFileUrl(vpsId, root, path);

  useEffect(() => {
    let alive = true;
    // Media never goes through the JSON read — the element fetches the bytes
    // itself. Reading it here would double the transfer for nothing.
    if (media) { setLoading(false); return () => { alive = false; }; }
    setLoading(true);
    setErr(null);
    api.readFsFile(vpsId, root, path)
      .then((r) => { if (!alive) return; if (r.ok) setRes(r); else setErr(r.error ?? 'could not read this file'); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [vpsId, root, path, media]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Line numbers as ONE text node beside the content, not a node per line:
  // a 20k-line file would otherwise mean 20k DOM elements to scroll.
  const gutter = useMemo(() => {
    if (!res?.content || res.binary) return null;
    const n = res.content.split('\n').length;
    return Array.from({ length: n }, (_, i) => i + 1).join('\n');
  }, [res]);

  return (
    <div className="split-diff-modal-backdrop" onClick={onClose}>
      <div className="split-diff-modal fvm" onClick={(e) => e.stopPropagation()}>
        <header className="sdm-head">
          <span className="sdm-path" title={`${root}/${path}`}>{path}</span>
          {(res?.size ?? size) != null && <span className="fvm-size">{fmtSize(res?.size ?? size ?? 0)}</span>}
          <a className="fvm-dl" href={rawUrl} download={name} title="download this file">get</a>
          <button className="sdm-close" onClick={onClose} title="close (Esc)">✕</button>
        </header>
        <div className="sdm-body fvm-body">
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
              too large to display ({fmtSize(res.size ?? 0)}) — use the download button
            </div>
          )}

          {!media && res && !res.tooLarge && res.binary && (
            <div className="dvm-note">
              binary file ({fmtSize(res.size ?? 0)}) — no preview for this type
            </div>
          )}

          {!media && res && !res.binary && res.content != null && (
            <>
              {res.truncated && <div className="dvm-note warn">⚠ showing the first part of this file only</div>}
              <div className="fvm-text">
                <pre className="fvm-gutter" aria-hidden>{gutter}</pre>
                <pre className="fvm-code">{res.content}</pre>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
