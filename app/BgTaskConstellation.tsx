'use client';
import { useState } from 'react';
import { backgroundWorkText as text, providerText } from '@/lib/providerText';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import { codexTerminalProcessId, type BgAgent, type BgTask, type BgTaskStatus } from './bgTasks';
import { fmtDuration } from './taskTime';
import BgTaskOutput from './BgTaskOutput';

export function bgAgentStatus(agent: BgAgent): BgTaskStatus | 'unknown' {
  switch (agent.state?.toLowerCase()) {
    case 'start': case 'running': return 'running';
    case 'done': case 'completed': return 'completed';
    case 'error': case 'failed': return 'failed';
    case 'stopped': case 'killed': return 'killed';
    default: return 'unknown';
  }
}
function label(status: BgTaskStatus | 'unknown') { return status === 'completed' ? 'done' : status === 'killed' ? 'stopped' : status === 'stale' ? 'lost' : status; }
function Pill({ status }: { status: BgTaskStatus | 'unknown' }) { return <span className={`tm-pill ${status}`}><i aria-hidden />{label(status)}</span>; }
function tokens(n: number | null | undefined) { return n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n); }
export default function BgTaskConstellation({ task, status, vpsId, cwd, provider, nowS, killing, onStop }: {
  task: BgTask; status: BgTaskStatus; vpsId: string; cwd: string | null;
  provider: SessionProvider; nowS: number; killing?: string; onStop: (id: string) => void;
}) {
  const [selection, setSelection] = useState<string | null>(null);
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const agents = (task.agents ?? []).map((agent, i) => ({ agent, key: `${agent.index ?? i}:${agent.label ?? ''}` }));
  const selected = agents.find((a) => a.key === selection)?.agent;
  const selectedKey = selected ? selection : null;
  const title = selected ? selected.label || text.agents : task.description || task.workflowName || task.command || task.taskId;
  const selectedStatus = selected ? bgAgentStatus(selected) : status;
  const stoppable = provider !== 'codex' || !!codexTerminalProcessId(task.taskId);
  const countDone = agents.filter(({ agent }) => bgAgentStatus(agent) === 'completed').length;
  function rootNode() {
    return <button type="button" className={`bgc-node bgc-root ${status} ${!selected ? 'selected' : ''}`}
      onClick={() => setSelection(null)} aria-pressed={!selected}>
      <span className="bgc-node-head"><strong>{task.workflowName || task.description || task.taskId}</strong><Pill status={status} /></span>
      <span className="bgc-node-meta">{task.workflowName ? text.workflow : text.task} · {tokens(task.usage?.tokens)} tokens</span>
    </button>;
  }
  return <section className="bgc" aria-label={title}>
    <div className="bgc-toolbar"><strong title={task.description || undefined}>{task.description || task.workflowName || task.taskId}</strong>
      {task.workflowName && <span className="tm-tag workflow">{task.workflowName}</span>}
      <div className="bgc-switch"><button type="button" aria-pressed={view === 'graph'} onClick={() => setView('graph')}>{text.graph}</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>{text.list}</button></div>
    </div>
    <div className="bgc-workspace"><div className="bgc-map">
      <div className="bgc-map-head"><span>{text.agents} · {countDone}/{agents.length} done</span><span>{label(status)}</span></div>
      <div className={`bgc-canvas ${view}`}>
        {rootNode()}
        {agents.length > 0 && <div className="bgc-children">{agents.map(({ agent, key }, i) => <div className={`bgc-branch ${bgAgentStatus(agent)}`} key={key}>
          <button type="button" className={`bgc-node ${bgAgentStatus(agent)} ${selectedKey === key ? 'selected' : ''}`}
            onClick={() => setSelection(key)} aria-pressed={selectedKey === key}>
            <span className="bgc-node-head"><strong>{agent.label || `agent ${(agent.index ?? i) + 1}`}</strong><Pill status={bgAgentStatus(agent)} /></span>
            {agent.phaseTitle && <span className="bgc-node-phase">{agent.phaseTitle}</span>}
            <span className="bgc-node-meta">{agent.model || '—'}<span>{tokens(agent.tokens)} tokens</span></span>
          </button>
        </div>)}</div>}
      </div>
      <div className="bgc-map-foot"><code>{task.taskId}</code><span>{agents.length} {text.agents.toLowerCase()}</span></div>
    </div><aside className="bgc-inspector">
      <div className="bgc-inspector-head"><span>{selected ? text.agents : task.workflowName ? text.workflow : text.task}</span><Pill status={selectedStatus} /></div>
      <div className="bgc-inspector-title"><h3>{title}</h3>{!selected && status === 'running' && (stoppable ?
        <button type="button" className="tm-stop" disabled={killing === 'pending'} onClick={() => onStop(task.taskId)} title={text.stopHint}>{killing === 'pending' ? text.stopping : text.stop}</button>
        : <span className="tm-nostop" title={providerText.noPerItemStop(provider)}>no per-item stop</span>)}</div>
      {selected?.model && <div className="bgc-model">{selected.model}</div>}
      {selected?.phaseTitle && <p className="bgc-phase">{selected.phaseTitle}</p>}
      {selected && <p className="bgc-stop-hint">{text.parentStop}</p>}
      {killing && killing !== 'pending' && !selected && <div className="tm-error">{killing}</div>}
      <dl className="bgc-stats"><div><dt>{text.tokens}</dt><dd>{tokens(selected ? selected.tokens : task.usage?.tokens)}</dd></div><div><dt>{text.elapsed}</dt><dd>{selected ? selected.durationMs == null ? '—' : fmtDuration(selected.durationMs) : fmtDuration(((task.endedAt ?? nowS) - task.startedAt) * 1000)}</dd></div></dl>
      <BgTaskOutput key={`${task.taskId}:${task.startedAt}:${selectedKey ?? 'root'}`} vpsId={vpsId} cwd={cwd}
        outputFile={selected ? null : task.outputFile} preview={selected ? selected.resultPreview : task.summary}
        running={selectedStatus === 'running'} />
      {!selected && task.outputFile && <div className="tm-path" title={task.outputFile}><span>output</span><code>{task.outputFile}</code></div>}
    </aside></div>
  </section>;
}
