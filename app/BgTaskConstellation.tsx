'use client';
import { useState } from 'react';
import { backgroundWorkText as text, providerText } from '@/lib/providerText';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import { bgTaskOwnAgent, codexTerminalProcessId, isBgCommandTask, type BgAgent, type BgTask, type BgTaskStatus } from './bgTasks';
import { fmtDuration, fmtMoment } from './taskTime';
import BgTaskOutput from './BgTaskOutput';
import { useBgWorkflowAgents } from './useBgWorkflowAgents';
import { useBgSessionAgents } from './useBgSessionAgents';
import BgWorkflowView from './BgWorkflowView';

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
type Props = {
  sessionId: string; agentLabels?: ReadonlyMap<string, string>;
  task: BgTask; status: BgTaskStatus; vpsId: string; cwd: string | null;
  provider: SessionProvider; nowS: number; killing?: string; onStop: (id: string) => void;
};

/** A shell command: one thing, no graph. Its title (the launcher's
 *  description, else the command itself), its command line when it differs,
 *  its times, and its output under them. */
function BgCommandView({ task, status, vpsId, cwd, provider, nowS, killing, onStop, sessionId }: Props) {
  const title = task.description || task.command || task.taskId;
  const stoppable = provider !== 'codex' || !!codexTerminalProcessId(task.taskId);
  // The CLI's summary of a command is its description or its command line: not output.
  const preview = task.summary && task.summary !== task.description && task.summary !== task.command ? task.summary : null;
  const end = task.endedAt ?? nowS;
  return <section className="bgc bgc-cmd" aria-label={title}>
    <header className="bgc-cmd-head">
      <div className="bgc-cmd-name"><span>{text.backgroundCommand}</span><h3>{title}</h3></div>
      <div className="bgc-cmd-actions"><Pill status={status} />{status === 'running' && (stoppable
        ? <button type="button" className="tm-stop" disabled={killing === 'pending'} onClick={() => onStop(task.taskId)} title={text.stopHint}>{killing === 'pending' ? text.stopping : text.stop}</button>
        : <span className="tm-nostop" title={providerText.noPerItemStop(provider)}>no per-item stop</span>)}</div>
    </header>
    {task.command && task.command !== title && <pre className="tm-code bgc-cmd-line">{task.command}</pre>}
    {killing && killing !== 'pending' && <div className="tm-error">{killing}</div>}
    <dl className="bgc-cmd-stats">
      <div><dt>{status === 'running' ? text.elapsed : text.took}</dt><dd>{fmtDuration((end - task.startedAt) * 1000)}</dd></div>
      <div><dt>{text.started}</dt><dd>{fmtMoment(task.startedAt * 1000, nowS * 1000)}</dd></div>
      {task.endedAt != null && <div><dt>{text.ended}</dt><dd>{fmtMoment(task.endedAt * 1000, nowS * 1000)}</dd></div>}
      <div><dt>{text.taskId}</dt><dd><code>{task.taskId}</code></dd></div>
    </dl>
    <BgTaskOutput key={`${task.taskId}:${task.startedAt}`} sessionId={sessionId} vpsId={vpsId} cwd={cwd} outputFile={task.outputFile}
      emptyHint={status === 'running' ? text.noCommandOutput : text.noCommandOutputEnded} preview={preview} plain running={status === 'running'} />
    {task.outputFile && <div className="tm-path" title={task.outputFile}><span>output</span><code>{task.outputFile}</code></div>}
  </section>;
}

export default function BgTaskConstellation(props: Props) {
  if (isBgCommandTask(props.task)) return <BgCommandView {...props} />;
  // A saved Claude workflow run is a frise; without timed agents, the graph.
  if (props.provider === 'claude' && props.task.workflowName) return <BgWorkflowView {...props} fallback={<BgTaskGraph {...props} />} />;
  return <BgTaskGraph {...props} />;
}

function BgTaskGraph({ task, status, vpsId, cwd, provider, nowS, killing, onStop, sessionId, agentLabels }: Props) {
  const [selection, setSelection] = useState<string | null>(null);
  const [nativeSelection, setNativeSelection] = useState<string | null>(null);
  // A background agent task IS a native sub-agent: the root reads its transcript.
  const ownAgent = bgTaskOwnAgent(task, provider);
  const inventory = useBgSessionAgents(sessionId, provider);
  const agentName = (a: { id: string; name?: string | null; role?: string | null }) => a.name || a.role || agentLabels?.get(a.id) || a.id;
  const nativeAgent = inventory.agents.find((a) => a.id === nativeSelection);
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const saved = useBgWorkflowAgents(sessionId, provider === 'claude' && task.agents == null && !!task.workflowName ? task.taskId : undefined, status === 'running');
  const taskAgents = task.agents ?? saved.agents;
  const agents = (taskAgents ?? []).map((agent, i) => ({ agent, key: `${agent.index ?? i}:${agent.label ?? ''}` }));
  const selected = agents.find((a) => a.key === selection)?.agent;
  const selectedKey = selected ? selection : null;
  const inspectingChild = !!nativeAgent || !!selected;
  const title = nativeAgent ? agentName(nativeAgent) : selected ? selected.label || text.agents : task.description || task.workflowName || task.command || task.taskId;
  const selectedStatus = nativeAgent ? 'unknown' : selected ? bgAgentStatus(selected) : status;
  const stoppable = provider !== 'codex' || !!codexTerminalProcessId(task.taskId);
  const countDone = agents.filter(({ agent }) => bgAgentStatus(agent) === 'completed').length;
  function rootNode() {
    return <button type="button" className={`bgc-node bgc-root ${status} ${!selected && !nativeAgent ? 'selected' : ''}`}
      onClick={() => { setSelection(null); setNativeSelection(null); }} aria-pressed={!selected && !nativeAgent}>
      <span className="bgc-node-head"><strong>{task.workflowName || task.description || task.taskId}</strong><Pill status={status} /></span>
      <span className="bgc-node-meta">{`${task.workflowName ? text.workflow : ownAgent ? text.backgroundAgent : text.task} · ${tokens(task.usage?.tokens)} tokens`}</span>
    </button>;
  }
  return <section className="bgc" aria-label={title}>
    <div className="bgc-toolbar"><strong title={task.description || undefined}>{task.description || task.workflowName || task.taskId}</strong>
      {task.workflowName && <span className="tm-tag workflow">{task.workflowName}</span>}
      <div className="bgc-switch"><button type="button" aria-pressed={view === 'graph'} onClick={() => setView('graph')}>{text.graph}</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>{text.list}</button></div>
    </div>
    <div className="bgc-workspace"><div className="bgc-map">
      <div className="bgc-map-head"><span>{ownAgent ? text.backgroundAgent : `${text.agents} · ${taskAgents == null ? text.detailsUnknown : `${countDone}/${agents.length} done`}`}</span><span>{label(status)}</span></div>
      <div className={`bgc-canvas ${view}`}>
        {rootNode()}
        {taskAgents == null && task.workflowName && <p className="bgc-missing-progress">{saved.error || (saved.loading ? text.inventoryLoading : text.missingProgress)}</p>}
        {agents.length > 0 && <div className="bgc-children">{agents.map(({ agent, key }, i) => <div className={`bgc-branch ${bgAgentStatus(agent)}`} key={key}>
          <button type="button" className={`bgc-node ${bgAgentStatus(agent)} ${selectedKey === key ? 'selected' : ''}`}
            onClick={() => { setSelection(key); setNativeSelection(null); }} aria-pressed={selectedKey === key}>
            <span className="bgc-node-head"><strong>{agent.label || `agent ${(agent.index ?? i) + 1}`}</strong><Pill status={bgAgentStatus(agent)} /></span>
            {agent.phaseTitle && <span className="bgc-node-phase">{agent.phaseTitle}</span>}
            <span className="bgc-node-meta">{agent.model || '—'}<span>{tokens(agent.tokens)} tokens</span></span>
          </button>
        </div>)}</div>}
        {inventory.enabled && <details className="bgc-native-agents">
          <summary>{text.sessionAgents} {inventory.agents.length > 0 && <span>· {inventory.agents.length}</span>}</summary>
          <p>{text.inventoryHint}</p>
          {inventory.loading && <p>{text.inventoryLoading}</p>}
          {inventory.error && <p className="tm-error">{inventory.error}</p>}
          {!inventory.loading && !inventory.error && !inventory.agents.length && <p>{text.noAgents}</p>}
          <div>{inventory.agents.map((agent) => <button type="button" key={agent.id}
            className={`bgc-node ${nativeSelection === agent.id ? 'selected' : ''}`}
            aria-pressed={nativeSelection === agent.id} onClick={() => { setNativeSelection(agent.id); setSelection(null); }}>
            <span className="bgc-node-head"><strong>{agentName(agent)}</strong></span>
            <span className="bgc-node-meta">{text.transcript}</span>
          </button>)}</div>
        </details>}
      </div>
      <div className="bgc-map-foot"><code>{task.taskId}</code><span>{ownAgent ? task.taskType : taskAgents == null ? text.detailsUnknown : `${agents.length} ${text.agents.toLowerCase()}`}</span></div>
    </div><aside className="bgc-inspector">
      <div className="bgc-inspector-head"><span>{nativeAgent ? text.sessionAgents : selected ? text.agents : task.workflowName ? text.workflow : ownAgent ? text.backgroundAgent : text.task}</span><Pill status={selectedStatus} /></div>
      <div className="bgc-inspector-title"><h3>{title}</h3>{!inspectingChild && status === 'running' && (stoppable ?
        <button type="button" className="tm-stop" disabled={killing === 'pending'} onClick={() => onStop(task.taskId)} title={text.stopHint}>{killing === 'pending' ? text.stopping : text.stop}</button>
        : <span className="tm-nostop" title={providerText.noPerItemStop(provider)}>no per-item stop</span>)}</div>
      {provider !== 'claude' && selected?.model && <div className="bgc-model">{selected.model}</div>}
      {provider !== 'claude' && selected?.phaseTitle && <p className="bgc-phase">{selected.phaseTitle}</p>}
      {selected && <p className="bgc-stop-hint">{text.parentStop}</p>}
      {killing && killing !== 'pending' && !inspectingChild && <div className="tm-error">{killing}</div>}
      <dl className="bgc-stats"><div><dt>{text.tokens}</dt><dd>{tokens(nativeAgent ? null : selected ? selected.tokens : task.usage?.tokens)}</dd></div><div><dt>{text.elapsed}</dt><dd>{nativeAgent ? '—' : selected ? selected.durationMs == null ? '—' : fmtDuration(selected.durationMs) : fmtDuration(((task.endedAt ?? nowS) - task.startedAt) * 1000)}</dd></div></dl>
      <BgTaskOutput key={`${task.taskId}:${task.startedAt}:${nativeAgent?.id ?? selectedKey ?? 'root'}`} sessionId={sessionId} nativeAgentId={nativeAgent?.id ?? (selected ? undefined : ownAgent ?? undefined)} richNative={provider === 'claude'} identity={`${task.taskId}:${task.startedAt}`} mission={nativeAgent ? null : task.description}
        workflowTask={selected && provider === 'claude' && selected.label ? task.taskId : undefined}
        workflowLabel={selected?.label || undefined} workflowPhase={selected?.phaseTitle || undefined} vpsId={vpsId} cwd={cwd}
        outputFile={inspectingChild ? null : task.outputFile} preview={nativeAgent ? nativeAgent.preview : selected ? selected.resultPreview : task.summary}
        running={!!nativeAgent || selectedStatus === 'running' || (selectedStatus === 'unknown' && status === 'running')} />
      {!inspectingChild && task.outputFile && <div className="tm-path" title={task.outputFile}><span>output</span><code>{task.outputFile}</code></div>}
    </aside></div>
  </section>;
}
