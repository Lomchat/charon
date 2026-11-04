'use client';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { backgroundWorkText as text } from '@/lib/providerText';
import { fromBase64, cutToLineStart } from './byteText';
import BgAgentActivity from './BgAgentActivity';
import { backgroundOutputPath, backgroundOutputText, subagentOutputText, prettyOutputJson } from './backgroundOutput';

const TAIL_BYTES = 128 * 1024;

/** Mounted only for the inspected node. One bounded read at a time, through
 * the existing agent channel; no file polling while reading earlier output. */
function LegacyBgTaskOutput({ vpsId, cwd, outputFile, preview, running, sessionId, nativeAgentId, workflowTask, workflowLabel, workflowPhase }: {
  sessionId: string; nativeAgentId?: string; workflowTask?: string; workflowLabel?: string; workflowPhase?: string;
  vpsId: string; cwd: string | null; outputFile?: string | null; preview?: string | null; running: boolean;
}) {
  const [fileText, setFileText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!outputFile || !!nativeAgentId);
  const [following, setFollowing] = useState(true);
  const follow = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!outputFile && !nativeAgentId) return;
    const at = outputFile ? backgroundOutputPath(outputFile, cwd) : null;
    if (!at && !nativeAgentId) { setLoading(false); setError(text.unavailablePath); return; }
    let disposed = false, busy = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (disposed || busy) return;
      clearTimeout(timer);
      if (document.visibilityState !== 'visible' || !follow.current) {
        timer = setTimeout(poll, 3000); return;
      }
      busy = true;
      try {
        let next: string;
        if (nativeAgentId) {
          const response = await fetch(`/api/sessions/${sessionId}/subagents?agent=${encodeURIComponent(nativeAgentId)}`, { signal: controller.signal });
          const result = await response.json();
          if (!response.ok || result.ok === false) throw new Error(result.error || text.outputError);
          next = subagentOutputText(Array.isArray(result.messages) ? result.messages : []);
        } else {
          const result = await api.fsReadRange(vpsId, at!.root, at!.path, -TAIL_BYTES, TAIL_BYTES);
          if (!result.ok || result.data == null) throw new Error(result.error || text.outputError);
          const bytes = fromBase64(result.data);
          const window = (result.offset ?? 0) > 0 ? cutToLineStart(bytes).bytes : bytes;
          next = backgroundOutputText(new TextDecoder().decode(window));
        }
        if (disposed) return;
        // A request finishing while the reader scrolls must not replace it.
        if (follow.current) setFileText(next);
        setError('');
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : text.outputError);
      } finally {
        busy = false;
        if (!disposed) { setLoading(false); if (running || nativeAgentId) timer = setTimeout(poll, nativeAgentId ? 5000 : 3000); }
      }
    };
    wake.current = () => void poll();
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); wake.current = null; };
  }, [vpsId, cwd, outputFile, running, sessionId, nativeAgentId]);
  const content = fileText || prettyOutputJson(preview || '');
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
    <header><span>{text.output}</span><span>{nativeAgentId ? text.transcript : outputFile ? text.fileOutput : preview ? text.preview : text.sourceUnavailable}</span></header>
    {error && <div className="tm-error">{text.outputError}: {error}</div>}
    <div className="bgc-output-scroll" ref={scroll} tabIndex={0} role="region" aria-label={text.output}
      onScroll={() => { const el = scroll.current!; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 32; setFollowing(follow.current); }}>
      <pre>{content || (loading ? text.loading : !nativeAgentId && !outputFile && !preview ? text.noTaskOutput : text.waiting)}</pre>
    </div>
    <footer><span>{following ? text.tailHint : text.reading}</span>
      {!following && <button type="button" onClick={() => {
        follow.current = true; setFollowing(true);
        if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
        wake.current?.();
      }}>{text.latestAction}</button>}
    </footer>
    {nativeAgentId && <p className="bgc-output-hint">{text.nativeHint}</p>}
    {!nativeAgentId && !outputFile && preview && <p className="bgc-output-hint">{text.previewHint}</p>}
  </section>;
}
type Props = Parameters<typeof LegacyBgTaskOutput>[0] & { richNative?: boolean; identity?: string; mission?: string | null };
function BgTaskOutput(props: Props) {
  if (props.workflowTask || (props.richNative && props.nativeAgentId)) return <BgAgentActivity
    sessionId={props.sessionId} task={props.workflowTask} label={props.workflowLabel} phase={props.workflowPhase}
    nativeAgent={props.richNative ? props.nativeAgentId : undefined} running={props.running}
    identity={props.identity || props.workflowTask || props.nativeAgentId || ''} preview={props.preview} mission={props.mission} />;
  return <LegacyBgTaskOutput {...props} />;
}
export default memo(BgTaskOutput);
