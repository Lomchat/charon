'use client';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { backgroundWorkText as text } from '@/lib/providerText';
import { summarizeAgentActivity, type AgentActivity, type AgentToolActivity } from '@/lib/subagentActivity';
import { prettyOutputJson } from './backgroundOutput';
import { useWorkflowOutput } from './useWorkflowOutput';

function time(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}
const ResultBlock = memo(function ResultBlock({ content }: { content: string }) { return <pre>{prettyOutputJson(content)}</pre>; });
function actionName(name?: string) { return (text.toolActions as Record<string, string>)[name || ''] || name || text.toolResult; }
function ToolCard({ call, expanded, toggle }: { call: AgentToolActivity; expanded: boolean; toggle: () => void }) {
  const state = call.result ? call.result.error ? 'failed' : 'completed' : 'unknown';
  const duration = call.at && call.result?.at ? Date.parse(call.result.at) - Date.parse(call.at) : null;
  return <details className={`bga-event ${state}`} open={expanded} onToggle={e => { if (e.currentTarget.open !== expanded) toggle(); }}>
    <summary>
      <span className="bga-event-icon" aria-hidden>{state === 'completed' ? '✓' : state === 'failed' ? '!' : '·'}</span>
      <span className="bga-event-label"><strong>{actionName(call.name)}</strong><code>{call.target || call.file || text.noToolTarget}</code></span>
      <time title={call.at || undefined}>{time(call.at)}</time>
    </summary>
    {expanded && <div className="bga-event-detail">
      <p className="bga-event-status">{call.result ? call.result.error ? text.toolFailed : text.toolSucceeded : text.resultNotLoaded}
        {duration != null && duration >= 0 && <span> · {Math.round(duration / 100) / 10}s {text.toResult}</span>}</p>
      {call.detail && <><h5>{['Bash', 'Monitor'].includes(call.name || '') ? text.command : text.arguments}</h5><pre>{call.detail}</pre></>}
      {call.result && <><h5>{text.toolResult}</h5><pre>{prettyOutputJson(call.result.content || text.emptyToolResult)}</pre></>}
    </div>}
  </details>;
}

/** Public actions and conclusions are two independent, always-visible readers. */
function BgAgentActivity({ sessionId, task, label, phase, nativeAgent, workflowAgent, running, identity, preview, mission }: {
  sessionId: string; task?: string; label?: string; phase?: string; nativeAgent?: string; running: boolean;
  /** With `task`: that workflow's node by native id (repeated labels are fine). */
  workflowAgent?: string;
  identity: string; preview?: string | null; mission?: string | null;
}) {
  const data = useWorkflowOutput(sessionId, nativeAgent ? { agent: nativeAgent, activity: '1' }
    : workflowAgent ? { task, agent: workflowAgent } : { task, label, phase }, running, identity);
  const view = data.view;
  const activity = useRef<HTMLDivElement>(null), output = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(() => ({ activity: view.activitySnapshot || data.entries, output: view.outputSnapshot || data.entries }));
  const [following, setFollowing] = useState({ activity: view.followActivity, output: view.followOutput });
  const [expanded, setExpanded] = useState(() => new Set(view.expanded));
  const anchor = useRef<{ activity?: { height: number; top: number }; output?: { height: number; top: number } }>({});
  const previous = useRef({ before: data.before, linked: data.linked });
  const olderBusy = useRef(false);
  const prefilled = useRef(0);
  const summary = useMemo(() => summarizeAgentActivity(data.entries), [data.entries]);
  const visible = useMemo(() => summarizeAgentActivity(shown.activity), [shown.activity]);
  const visibleOutput = useMemo(() => shown.output.filter(e => e.kind === 'text' || e.kind === 'result'), [shown.output]);
  const activityIds = useMemo(() => new Set(shown.activity.map(e => e.id)), [shown.activity]);
  const outputIds = useMemo(() => new Set(shown.output.map(e => e.id)), [shown.output]);
  const unreadActivity = data.entries.filter(e => (e.kind === 'tool' || e.kind === 'tool_result') && !activityIds.has(e.id)).length;
  const unreadOutput = summary.output.filter(e => !outputIds.has(e.id)).length;
  const timeline = useMemo(() => [...visible.calls, ...visible.orphanResults].sort((a,b) => parseInt(a.id) - parseInt(b.id)), [visible]);
  const loadEarlier = async () => {
    if (olderBusy.current || data.readingEarlier || data.before == null) return;
    olderBusy.current = true;
    try { await data.loadEarlier(); } finally { olderBusy.current = false; }
  };
  useLayoutEffect(() => {
    const older = previous.current.linked && previous.current.before != null && (data.before == null || data.before < previous.current.before);
    previous.current = { before: data.before, linked: data.linked };
    if (older) {
      for (const [name, ref] of [['activity', activity], ['output', output]] as const) {
        const el = ref.current;
        if (el) anchor.current[name] = { height: el.scrollHeight, top: el.scrollTop };
      }
    }
    if (!data.linked) return;
    setShown(s => ({ activity: older || view.followActivity ? data.entries : s.activity, output: older || view.followOutput ? data.entries : s.output }));
  }, [data.entries, data.before, data.linked, view]);
  useLayoutEffect(() => {
    view.activitySnapshot = shown.activity; view.outputSnapshot = shown.output;
    for (const [name, ref] of [['activity', activity], ['output', output]] as const) {
      const el = ref.current;
      if (!el) continue;
      const follow = name === 'activity' ? view.followActivity : view.followOutput;
      const savedTop = name === 'activity' ? view.activityTop : view.outputTop;
      const mark = anchor.current[name];
      el.scrollTop = mark ? mark.top + el.scrollHeight - mark.height : follow ? el.scrollHeight : savedTop;
      delete anchor.current[name];
    }
  }, [shown, view]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (view.followActivity && activity.current) activity.current.scrollTop = activity.current.scrollHeight;
      if (view.followOutput && output.current) output.current.scrollTop = output.current.scrollHeight;
    });
    if (activity.current) observer.observe(activity.current);
    if (output.current) observer.observe(output.current);
    return () => observer.disconnect();
  }, [view]);
  useEffect(() => {
    const el = activity.current;
    // Fill a short initial timeline automatically. Bound this prefetch so a
    // text-only agent does not trigger a scan of its entire history.
    if (!el || data.before == null || data.readingEarlier || prefilled.current >= 3
      || !visible.calls.length || el.scrollHeight > el.clientHeight + 8) return;
    const timer = setTimeout(() => { prefilled.current++; void loadEarlier(); }, 100);
    return () => clearTimeout(timer);
  }, [shown.activity, data.before, data.readingEarlier, visible.calls.length]);
  const scroll = (name: 'activity' | 'output') => {
    const el = (name === 'activity' ? activity : output).current!;
    const follow = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
    if (name === 'activity') { view.activityTop = el.scrollTop; view.followActivity = follow; }
    else { view.outputTop = el.scrollTop; view.followOutput = follow; }
    setFollowing(s => s[name] === follow ? s : { ...s, [name]: follow });
    if (follow) setShown(s => s[name] === data.entries ? s : { ...s, [name]: data.entries });
    if (!follow && el.scrollTop < 80 && data.before != null) void loadEarlier();
  };
  const latest = (name: 'activity' | 'output') => {
    if (name === 'activity') view.followActivity = true; else view.followOutput = true;
    setFollowing(s => ({ ...s, [name]: true })); setShown(s => ({ ...s, [name]: data.entries }));
    const el = (name === 'activity' ? activity : output).current;
    if (el) el.scrollTop = el.scrollHeight;
    void data.refresh();
  };
  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id);
    view.expanded = [...next]; return next;
  });
  const earlier = <button type="button" className="bgc-output-earlier" disabled={data.readingEarlier} onClick={() => void loadEarlier()}>{data.readingEarlier ? text.loading : text.earlierActivity}</button>;
  const missionText = data.info.mission || mission;
  return <section className="bga" aria-label={text.agentDetails}>
    <div className="bga-overview">
      {missionText && <details open={view.missionOpen} onToggle={e => { view.missionOpen = e.currentTarget.open; }}>
        <summary><strong>{data.info.mission ? text.mission : text.workflowMission}</strong><span>{missionText}</span></summary>
        <pre>{missionText}{data.info.missionTruncated ? `\n${text.missionExcerpt}` : ''}</pre>
      </details>}
      <div className="bga-facts">
        {(summary.model || data.info.model) && <span><small>{text.model}</small>{summary.model || data.info.model}</span>}
        {(data.info.phase || phase) && <span><small>{text.phase}</small>{data.info.phase || phase}</span>}
        <span><small>{text.lastActivity}</small><time title={summary.last || undefined}>{time(summary.last)}</time></span>
      </div>
      <details className="bga-files" open={view.filesOpen} onToggle={e => { view.filesOpen = e.currentTarget.open; }}>
        <summary>{summary.calls.length} {summary.calls.length === 1 ? text.action : text.actions} · {summary.files.length} {summary.files.length === 1 ? text.file : text.files} · {summary.errors} {summary.errors === 1 ? text.error : text.errors}<small>{data.before == null ? text.loadedHistory : text.partialHistory}</small></summary>
        <ul>{summary.files.map(file => <li key={file.path}><code>{file.path}</code><span>{file.written ? text.fileModified : file.read ? text.fileRead : text.filePending}</span></li>)}</ul>
        {!summary.files.length && <p>{text.noFiles}</p>}
      </details>
    </div>
    {data.error && <div className="tm-error">{data.error} <button type="button" onClick={() => void data.refresh()}>{text.retry}</button></div>}
    {data.notice && <p className="bgc-output-hint" role="status">{data.notice}</p>}
    <section className="bga-pane bga-activity">
      <header><strong>{text.activity}</strong><span>{data.loading ? text.loading : data.linked ? text.savedActivity : text.preview}</span></header>
      <div className="bga-scroll" ref={activity} onScroll={() => scroll('activity')} tabIndex={0} role="region" aria-label={text.activity}>
        {data.before != null && earlier}
        {timeline.map(e => e.kind === 'tool' ? <ToolCard key={e.id} call={e} expanded={expanded.has(e.id)} toggle={() => toggle(e.id)} /> :
          <details className="bga-event" key={e.id} open={expanded.has(e.id)} onToggle={event => { if(event.currentTarget.open !== expanded.has(e.id)) toggle(e.id); }}>
            <summary><span className="bga-event-label"><strong>{text.earlierToolResult}</strong><span>{e.error ? text.toolFailed : text.toolSucceeded}</span></span><time>{time(e.at)}</time></summary>
            {expanded.has(e.id) && <pre>{prettyOutputJson(e.content || text.emptyToolResult)}</pre>}
          </details>)}
        {!visible.calls.length && !visible.orphanResults.length && <p className="bga-empty">{data.loading ? text.loading : text.noActivity}</p>}
      </div>
      <footer><span>{following.activity ? text.followingActivity : text.reading}</span>
        {(!following.activity || unreadActivity > 0) && <button type="button" onClick={() => latest('activity')}>{unreadActivity ? `${unreadActivity} ${text.newActivities}` : text.latestAction}</button>}
      </footer>
    </section>
    <section className="bga-pane bga-result">
      <header><strong>{text.outputResult}</strong><span>{text.jsonFormatted}</span></header>
      <div className="bga-scroll bga-result-scroll" ref={output} onScroll={() => scroll('output')} tabIndex={0} role="region" aria-label={text.outputResult}>
        {data.before != null && earlier}
        {visibleOutput.map(event => <ResultBlock key={event.id} content={event.content || ''} />)}
        {!visibleOutput.length && <pre className="bga-empty">{!data.linked && preview ? prettyOutputJson(preview) : data.loading ? text.loading : text.noWrittenOutput}</pre>}
      </div>
      <footer><span>{following.output ? text.tailHint : text.reading}</span>
        {(!following.output || unreadOutput > 0) && <button type="button" onClick={() => latest('output')}>{unreadOutput ? `${unreadOutput} ${text.newOutputs}` : text.latestAction}</button>}
      </footer>
      {!data.linked && preview && <p className="bgc-output-hint">{text.previewHint}</p>}
    </section>
  </section>;
}
export default memo(BgAgentActivity);
