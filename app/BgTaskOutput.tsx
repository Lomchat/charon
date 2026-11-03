'use client';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { backgroundWorkText as text } from '@/lib/providerText';
import { fromBase64, cutToLineStart } from './byteText';
import { backgroundOutputPath, backgroundOutputText } from './backgroundOutput';

const TAIL_BYTES = 128 * 1024;

/** Mounted only for the inspected node. One bounded read at a time, through
 * the existing agent channel; no file polling while reading earlier output. */
function BgTaskOutput({ vpsId, cwd, outputFile, preview, running }: {
  vpsId: string; cwd: string | null; outputFile?: string | null; preview?: string | null; running: boolean;
}) {
  const [fileText, setFileText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!outputFile);
  const [following, setFollowing] = useState(true);
  const follow = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!outputFile) return;
    const at = backgroundOutputPath(outputFile, cwd);
    if (!at) { setLoading(false); setError(text.unavailablePath); return; }
    let disposed = false, busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (disposed || busy) return;
      clearTimeout(timer);
      if (document.visibilityState !== 'visible' || !follow.current) {
        timer = setTimeout(poll, 3000); return;
      }
      busy = true;
      try {
        const result = await api.fsReadRange(vpsId, at.root, at.path, -TAIL_BYTES, TAIL_BYTES);
        if (disposed) return;
        if (!result.ok || result.data == null) throw new Error(result.error || text.outputError);
        const bytes = fromBase64(result.data);
        const window = (result.offset ?? 0) > 0 ? cutToLineStart(bytes).bytes : bytes;
        // Do not replace the viewport if the user scrolled up during the read.
        if (follow.current) setFileText(backgroundOutputText(new TextDecoder().decode(window)));
        setError('');
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : text.outputError);
      } finally {
        busy = false;
        if (!disposed) { setLoading(false); if (running) timer = setTimeout(poll, 3000); }
      }
    };
    wake.current = () => void poll();
    void poll();
    return () => { disposed = true; clearTimeout(timer); wake.current = null; };
  }, [vpsId, cwd, outputFile, running]);
  const content = fileText || preview || '';
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [content]);
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { if (follow.current) el.scrollTop = el.scrollHeight; });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <section className="bgc-output" aria-label={text.output}>
    <header><span>{text.output}</span><span>{outputFile ? text.fileOutput : text.preview}</span></header>
    {error && <div className="tm-error">{text.outputError}: {error}</div>}
    <div className="bgc-output-scroll" ref={scroll} tabIndex={0} role="region" aria-label={text.output}
      onScroll={() => { const el = scroll.current!; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 32; setFollowing(follow.current); }}>
      <pre>{content || (loading ? text.loading : text.waiting)}</pre>
    </div>
    <footer><span>{following ? text.tailHint : text.reading}</span>
      {!following && <button type="button" onClick={() => {
        follow.current = true; setFollowing(true);
        if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
        wake.current?.();
      }}>{text.latestAction}</button>}
    </footer>
    {!outputFile && <p className="bgc-output-hint">{text.previewHint}</p>}
  </section>;
}
export default memo(BgTaskOutput);
