'use client';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { backgroundWorkText as text } from '@/lib/providerText';
import { fromBase64, cutToLineStart } from './byteText';
import { useWorkflowOutput } from './useWorkflowOutput';
import { backgroundOutputPath, backgroundOutputText, subagentOutputText, prettyOutputJson } from './backgroundOutput';

const TAIL_BYTES = 128 * 1024;

/** Mounted only for the inspected node. One bounded read at a time, through
 * the existing agent channel; no file polling while reading earlier output. */
function BgTaskOutput({ vpsId, cwd, outputFile, preview, running, sessionId, nativeAgentId, workflowTask, workflowLabel, workflowPhase }: {
  sessionId: string; nativeAgentId?: string; workflowTask?: string; workflowLabel?: string; workflowPhase?: string;
  vpsId: string; cwd: string | null; outputFile?: string | null; preview?: string | null; running: boolean;
}) {
  const [fileText, setFileText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!outputFile || !!nativeAgentId);
  const [following, setFollowing] = useState(true);
  const follow = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const workflow = useWorkflowOutput(sessionId, workflowTask, workflowLabel, workflowPhase, running, follow);
  const loadEarlier = async () => {
    const el = scroll.current;
    if (!el || workflow.readingEarlier || !workflow.hasMore) return;
    follow.current = false; setFollowing(false);
    anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    await workflow.loadEarlier();
  };
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
          const response = await fetch(`/api/claude/sessions/${sessionId}/subagents?agent=${encodeURIComponent(nativeAgentId)}`, { signal: controller.signal });
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
  const content = workflowTask ? (workflow.linked ? workflow.content : prettyOutputJson(preview || '')) : fileText || prettyOutputJson(preview || '');
  const outputError = workflowTask ? workflow.error : error;
  const isLoading = workflowTask ? workflow.loading : loading;
  useLayoutEffect(() => {
    if (anchor.current && scroll.current) {
      scroll.current.scrollTop = anchor.current.top + scroll.current.scrollHeight - anchor.current.height;
      anchor.current = null;
    } else if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [content, workflow.hasMore]);
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { if (follow.current) el.scrollTop = el.scrollHeight; });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <section className="bgc-output" aria-label={text.output}>
    <header><span>{text.output}</span><span>{(nativeAgentId || workflow.linked) ? text.transcript : outputFile ? text.fileOutput : preview ? text.preview : text.sourceUnavailable}</span></header>
    {outputError && <div className="tm-error">{text.outputError}: {outputError}</div>}
    <div className="bgc-output-scroll" ref={scroll} tabIndex={0} role="region" aria-label={text.output}
      onScroll={() => { const el = scroll.current!; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 32; setFollowing(follow.current);
        if (el.scrollTop < 48 && !follow.current && workflow.hasMore && !workflow.readingEarlier) void loadEarlier();
      }}>
      {workflow.hasMore && <button className="bgc-output-earlier" type="button" disabled={workflow.readingEarlier} onClick={() => void loadEarlier()}>{workflow.readingEarlier ? text.loading : text.earlierOutput}</button>}
      <pre>{content || (isLoading ? text.loading : !nativeAgentId && !outputFile && !preview ? text.noTaskOutput : text.waiting)}</pre>
    </div>
    <footer><span>{following ? text.tailHint : text.reading}</span>
      {!following && <button type="button" onClick={() => {
        anchor.current = null; follow.current = true; setFollowing(true);
        if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
        if (workflowTask) void workflow.latest(); else wake.current?.();
      }}>{text.latestAction}</button>}
    </footer>
    {nativeAgentId && <p className="bgc-output-hint">{text.nativeHint}</p>}
    {!nativeAgentId && !outputFile && !workflow.linked && preview && <p className="bgc-output-hint">{text.previewHint}</p>}
  </section>;
}
export default memo(BgTaskOutput);
