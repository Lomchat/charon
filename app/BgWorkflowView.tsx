'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { backgroundWorkText as text, providerText } from '@/lib/providerText';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import BgAgentActivity from './BgAgentActivity';
import { codexTerminalProcessId, type BgTask, type BgTaskStatus } from './bgTasks';
import { fmtDuration } from './taskTime';
import { useBgWorkflowAgents } from './useBgWorkflowAgents';
import { outcomeText, workflowTimeline, type TimelineAgent, type TimelineStatus } from './bgWorkflowTimeline';

type Props = {
  sessionId: string; task: BgTask; status: BgTaskStatus; vpsId: string; cwd: string | null;
  provider: SessionProvider; nowS: number; killing?: string; onStop: (id: string) => void;
  /** Drawn when the run has no timed agents (live progress only, older hub). */
  fallback: ReactNode;
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const short = (ms: number) => fmtDuration(ms, { seconds: ms < 120_000 });
const STATUS_LABEL: Record<TimelineStatus, string> = {
  running: text.wfRunning, done: text.wfDone, negative: text.wfNegative, failed: text.wfFailed, unknown: text.wfUnknown,
};

/** A saved workflow as a frise: one lane per role on a wall-clock axis, its
 *  parallel starts marked, the inspected agent's activity underneath. */
export default function BgWorkflowView({ sessionId, task, status, provider, nowS, killing, onStop, fallback }: Props) {
  const saved = useBgWorkflowAgents(sessionId, task.taskId, status === 'running');
  const [picked, setPicked] = useState<string | null>(null);
  // Re-laid out every 10 s, not every tick: a running bar grows by pixels per minute.
  const bucket = Math.floor(nowS / 10) * 10_000;
  const tl = useMemo(() => saved.agents ? workflowTimeline(saved.agents, task, status, bucket) : null,
    [saved.agents, task, status, bucket]);
  if (!tl) return saved.loading ? <section className="bgc bgw"><p className="bgw-loading">{text.wfReading}</p></section> : <>{fallback}</>;

  const nowMs = nowS * 1000;
  const selected = tl.agents.find((a) => a.id === picked)
    ?? tl.running[tl.running.length - 1] ?? tl.agents[tl.agents.length - 1];
  const x = (t: number) => `${(100 * (t - tl.t0) / (tl.t1 - tl.t0)).toFixed(3)}%`;
  const stoppable = provider !== 'codex' || !!codexTerminalProcessId(task.taskId);
  const elapsed = ((task.endedAt ?? nowS) - task.startedAt) * 1000;
  const guides = <>
    {tl.ticks.map((t) => <i key={`t${t}`} className="bgw-grid" style={{ left: x(t) }} />)}
    {tl.waves.map((w) => <i key={`w${w.at}`} className="bgw-wave-line" style={{ left: x(w.at) }} />)}
    {status === 'running' && <i className="bgw-now-line" style={{ left: x(nowMs) }} />}
  </>;
  const bar = (a: TimelineAgent) => {
    const tip = [a.agent.label, a.agent.phaseTitle, `${clock(a.start)} → ${a.status === 'running' ? text.wfNow : clock(a.end)}`,
      short(a.end - a.start), STATUS_LABEL[a.status], outcomeText(a.agent.outcome)].filter(Boolean).join(' · ');
    const wide = (a.end - a.start) / (tl.t1 - tl.t0) > 0.06;
    return <button type="button" key={a.id} className={`bgw-bar ${a.status}${a.id === selected?.id ? ' selected' : ''}`}
      style={{ left: x(a.start), width: `calc(${x(a.end)} - ${x(a.start)})` }} title={tip} aria-label={tip}
      aria-pressed={a.id === selected?.id} onClick={() => setPicked(a.id)}>{wide ? short(a.end - a.start) : ''}</button>;
  };

  return <section className="bgc bgw" aria-label={task.description || task.workflowName || task.taskId}>
    <header className="bgw-head">
      <div className="bgw-kind">{text.workflow} <b>{task.workflowName}</b></div>
      <h3 className="bgw-desc">{task.description || task.workflowName}</h3>
      <div className="bgw-act">
        <span className={`tm-pill ${status}`}><i aria-hidden />{status === 'completed' ? 'done' : status === 'killed' ? 'stopped' : status === 'stale' ? 'lost' : status}</span>
        {status === 'running' && (stoppable
          ? <button type="button" className="tm-stop" disabled={killing === 'pending'} onClick={() => onStop(task.taskId)} title={text.stopHint}>{killing === 'pending' ? text.stopping : text.stop}</button>
          : <span className="tm-nostop" title={providerText.noPerItemStop(provider)}>no per-item stop</span>)}
      </div>
      <div className="bgw-facts">
        <span>{text.wfStartedAt} <b>{clock(task.startedAt * 1000)}</b></span>
        <span>{status === 'running' ? text.wfRunningFor : text.wfTook} <b>{fmtDuration(elapsed, { seconds: false })}</b></span>
        <span><b>{tl.done}/{tl.agents.length}</b> {text.wfAgentsDone}</span>
        {tl.lastActivityAt != null && <span>{text.wfLastActivity} <b>{text.wfAgo(fmtDuration(Math.max(0, nowMs - tl.lastActivityAt), { seconds: false }))}</b></span>}
      </div>
      {killing && killing !== 'pending' && <div className="tm-error">{killing}</div>}
      {tl.phases.length > 1 && <div className="bgw-phases">{tl.phases.map((p) =>
        <div key={p.name} className={`bgw-phase ${p.status}`} style={{ flexGrow: p.size }}><i /><span><b>{p.name || '—'}</b> {p.size}</span></div>)}</div>}
    </header>

    <div className="bgw-chart">
      <div className="bgw-row bgw-marks"><span /><div className="bgw-track">
        {tl.waves.map((w) => <span key={w.at} className="bgw-wave" style={{ left: x(w.at) }} title={`${w.size} ${text.wfWave} · ${clock(w.at)}`}>{w.label}</span>)}
        {status === 'running' && <span className="bgw-now" style={{ left: x(nowMs) }}>{text.wfNow}</span>}
      </div></div>
      <div className="bgw-row bgw-axis"><span /><div className="bgw-track">
        {tl.ticks.map((t) => <span key={t} style={{ left: x(t) }}>{clock(t)}</span>)}
      </div></div>
      <div className="bgw-lanes">{tl.lanes.map((l) => <div key={l.role} className="bgw-row bgw-lane">
        <span className="bgw-lname" title={l.role}>{l.role}{l.agents.length > 1 && <small>×{l.agents.length}</small>}</span>
        <div className="bgw-track">{guides}{l.agents.map(bar)}</div>
      </div>)}</div>
      <div className="bgw-legend">{(['done', 'negative', 'failed', 'running'] as const)
        .filter((s) => s === 'done' || tl.agents.some((a) => a.status === s))
        .map((s) => <span key={s}><i className={`bgw-key ${s}`} />{STATUS_LABEL[s]}</span>)}
        {tl.waves.length > 0 && <span><i className="bgw-key wave" />{text.wfWave}</span>}</div>
      {tl.slow && <p className="bgw-alert">{text.wfSlow(tl.slow.agent.agent.label || '', fmtDuration(tl.slow.elapsed, { seconds: false }),
        short(tl.slow.usual), text.wfAgo(fmtDuration(Math.max(0, nowMs - (tl.slow.agent.agent.lastActivityAt ?? nowMs)), { seconds: false })))}</p>}
    </div>

    {selected ? <div className="bgw-detail">
      <div className="bgw-sel">
        <span className={`tm-pill ${selected.status === 'negative' ? 'failed' : selected.status === 'unknown' ? 'stale' : selected.status === 'done' ? 'completed' : selected.status}`}><i aria-hidden />{STATUS_LABEL[selected.status]}</span>
        <strong>{selected.agent.label}</strong>
        <span>{[selected.agent.phaseTitle, `${clock(selected.start)} → ${selected.status === 'running' ? text.wfNow : clock(selected.end)}`, short(selected.end - selected.start)].filter(Boolean).join(' · ')}</span>
        {outcomeText(selected.agent.outcome) && <span className="bgw-outcome">{outcomeText(selected.agent.outcome)}</span>}
      </div>
      {provider === 'claude' && selected.agent.agentId
        ? <BgAgentActivity key={selected.id} sessionId={sessionId} task={task.taskId} workflowAgent={selected.agent.agentId}
          phase={selected.agent.phaseTitle || undefined} running={selected.status === 'running'}
          identity={`${task.taskId}:${task.startedAt}:${selected.id}`} />
        : <p className="bgw-loading">{text.wfPickAgent}</p>}
    </div> : <p className="bgw-loading">{text.wfPickAgent}</p>}
  </section>;
}
