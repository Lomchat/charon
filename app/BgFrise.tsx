'use client';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { backgroundWorkText as text, providerText } from '@/lib/providerText';
import { asSessionProvider, providerLabel, sessionCapabilities, type SessionProvider } from '@/lib/sessionCapabilities';
import { bgTaskOwnAgent, codexTerminalProcessId, type BgAgent, type BgTask, type BgTaskStatus } from './bgTasks';
import { fmtDuration, fmtMoment } from './taskTime';
import BgTaskOutput from './BgTaskOutput';
import BgAgentActivity from './BgAgentActivity';
import AgentRunTag, { sharedRun, type AgentRun } from './AgentRunTag';
import { useBgWorkflowAgents } from './useBgWorkflowAgents';
import { useBgSessionAgents, type NativeBgAgent } from './useBgSessionAgents';
import { localTicks, outcomeText, workflowTimeline, type TimelineAgent, type WorkflowTimeline } from './bgWorkflowTimeline';
import { IconBoxArrowUpRight } from './icons';
import type { CharonAgent } from './charonAgents';
import type { SubSessionUsage } from '@/lib/types/api';
import {
  charonFriseStatus, fmtTokens, friseKind, friseStatus, friseWindow, terminalCommand, terminalId,
  type CodexTerminal, type FriseKind, type FriseRange, type FriseStatus,
} from './bgFrise';

// ── BgFrise ──────────────────────────────────────────────────────────────────
// The "Background work" modal body: every command, agent, workflow, Codex
// process and Charon sub-session of the session on ONE clock axis, a lane each
// (a workflow unfolds into one lane per role, a sub-session's own sub-sessions
// sit under it); the selected line's detail underneath.

type Row = { t: BgTask; status: BgTaskStatus };
type Item = {
  key: string; kind: FriseKind; title: string; start: number; end: number | null; st: FriseStatus;
  row?: Row; terminal?: CodexTerminal; charon?: CharonAgent;
};
type WorkflowAgents = { agents: BgAgent[] | null; loading: boolean; error: string };

/** A workflow agent's selection key: its workflow's task id, then its own id. */
const SEP = '\n';
const agentKey = (a: BgAgent, i: number) => a.agentId ?? `${i}:${a.label ?? ''}`;

const ICON: Record<FriseKind, ReactNode> = {
  command: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 4l4 4-4 4M8.5 12.5h5" /></svg>,
  task: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 4l4 4-4 4M8.5 12.5h5" /></svg>,
  agent: <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5l1.6 4.2 4.4.3-3.4 2.8 1.1 4.3L8 10.7 4.3 13.1l1.1-4.3L2 6l4.4-.3z" /></svg>,
  workflow: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="3.5" cy="8" r="1.8" /><circle cx="12.5" cy="3.5" r="1.8" /><circle cx="12.5" cy="12.5" r="1.8" /><path d="M5.2 7.2l5.6-2.8M5.2 8.8l5.6 2.8" /></svg>,
  process: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" /></svg>,
  charon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" /><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" /></svg>,
};
const KIND_LABEL: Record<FriseKind, string> = {
  command: text.command, task: text.task, agent: text.agent, workflow: text.workflow, process: text.process,
  charon: text.charonAgent,
};
const STATUS: Record<FriseStatus, { pill: string; label: string; legend: string }> = {
  running: { pill: 'running', label: 'running', legend: text.wfRunning },
  done: { pill: 'completed', label: 'done', legend: text.wfDone },
  failed: { pill: 'failed', label: 'failed', legend: text.wfFailed },
  negative: { pill: 'failed', label: 'no', legend: text.wfNegative },
  stopped: { pill: 'killed', label: text.stopped, legend: text.stopped },
  timelimit: { pill: 'killed', label: text.timeLimit, legend: text.timeLimit },
  lost: { pill: 'stale', label: text.lost, legend: text.lost },
  unknown: { pill: 'stale', label: text.wfUnknown, legend: text.wfUnknown },
};
const LEGEND_ORDER: FriseStatus[] = ['done', 'running', 'failed', 'negative', 'stopped', 'timelimit', 'lost', 'unknown'];

function Pill({ st }: { st: FriseStatus }) {
  const s = STATUS[st];
  return <span className={`tm-pill ${s.pill}`} title={st === 'timelimit' ? text.timeLimitHint : st === 'lost' ? text.lostHint : undefined}><i aria-hidden />{s.label}</span>;
}
const short = (ms: number) => fmtDuration(Math.max(0, ms), { seconds: ms < 120_000 });
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function taskTitle(t: BgTask) { return t.description || t.workflowName || t.command || t.taskId; }

/** Restores one workflow's saved agents (journal + run folder) and hands them up. */
function WorkflowAgentsLoader({ sessionId, taskId, running, onAgents }: {
  sessionId: string; taskId: string; running: boolean; onAgents: (id: string, value: WorkflowAgents) => void;
}) {
  const saved = useBgWorkflowAgents(sessionId, taskId, running);
  useEffect(() => { onAgents(taskId, saved); }, [saved, taskId, onAgents]);
  return null;
}

type Props = {
  rows: Row[];
  terminals: CodexTerminal[];
  terminalError: string | null;
  /** Finished items older than the hub's history (counted, not listed). */
  olderEnded: number;
  sessionId: string; vpsId: string; cwd: string | null; provider: SessionProvider; nowS: number;
  killing: Record<string, string>; onStop: (taskId: string) => void;
  terminalKilling: Record<string, string>; onStopTerminal: (processId: string) => void;
  runs: ReadonlyMap<string, AgentRun>;
  agentLabels: ReadonlyMap<string, string>;
  initialSelected: string | null;
  /** Sub-sessions under this one, tree order (`useCharonAgents`). */
  charon: CharonAgent[];
  /** What each has used (read while the modal is open). */
  charonUsage?: Record<string, SubSessionUsage>;
  onOpenSession?: (id: string) => void;
  interrupting: Record<string, string>; onInterrupt: (id: string) => void;
};

const CHARON = 'charon:';

function BgFrise(props: Props) {
  const { rows, terminals, terminalError, olderEnded, sessionId, provider, nowS, runs, agentLabels } = props;
  const nowMs = nowS * 1000;

  // Tasks and the Codex process registry merge by process id; a process the
  // registry lists with no task yet starts where this view first saw it.
  const firstSeen = useRef(new Map<string, number>());
  const items = useMemo(() => {
    const byPid = new Map(terminals.map((term) => [terminalId(term), term] as const));
    const out: Item[] = rows.map((row) => {
      const { t, status } = row;
      const pid = codexTerminalProcessId(t.taskId);
      const terminal = pid ? byPid.get(pid) : undefined;
      if (pid) byPid.delete(pid);
      return {
        key: t.taskId, kind: friseKind(t), title: taskTitle(t), row, terminal,
        start: t.startedAt * 1000, end: status === 'running' ? null : (t.endedAt ?? t.startedAt) * 1000, st: friseStatus(t, status),
      };
    });
    for (const [pid, term] of byPid) {
      if (!pid) continue;
      if (!firstSeen.current.has(pid)) firstSeen.current.set(pid, Date.now());
      out.push({ key: `proc:${pid}`, kind: 'process', title: terminalCommand(term), start: firstSeen.current.get(pid)!, end: null, st: 'running', terminal: term });
    }
    for (const a of props.charon) {
      if (a.depth > 0) continue;
      out.push({ key: `${CHARON}${a.id}`, kind: 'charon', title: a.name, start: a.startMs, end: a.endMs, st: charonFriseStatus(a.status), charon: a });
    }
    return out.sort((a, b) => a.start - b.start);
  }, [rows, terminals, props.charon]);
  // A sub-session's own sub-sessions, under its lane (tree order).
  const nested = useMemo(() => {
    const out = new Map<string, CharonAgent[]>();
    let top = '';
    for (const a of props.charon) {
      if (a.depth === 0) { top = a.id; continue; }
      const list = out.get(top);
      if (list) list.push(a); else out.set(top, [a]);
    }
    return out;
  }, [props.charon]);

  const defaultKey = () => {
    const running = items.filter((i) => i.end == null);
    return (running[running.length - 1] ?? [...items].sort((a, b) => (b.end ?? 0) - (a.end ?? 0))[0])?.key ?? null;
  };
  const [selected, setSelected] = useState<string | null>(() => props.initialSelected ?? defaultKey());
  const [range, setRange] = useState<FriseRange>('auto');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const first = props.initialSelected ?? defaultKey();
    return new Set(items.some((i) => i.key === first && i.kind === 'workflow') ? [first!] : []);
  });
  const [nativeOpen, setNativeOpen] = useState(false);
  const toggle = useCallback((key: string) => setExpanded((s) => {
    const next = new Set(s); if (next.has(key)) next.delete(key); else next.add(key); return next;
  }), []);

  // Saved workflow agents: for every unfolded workflow and the selected one.
  const [wf, setWf] = useState<Record<string, WorkflowAgents>>({});
  const onAgents = useCallback((id: string, value: WorkflowAgents) => setWf((w) => (w[id] === value ? w : { ...w, [id]: value })), []);
  const selectedWorkflow = selected?.split(SEP)[0] ?? null;
  const loaders = provider === 'claude'
    ? items.filter((i) => i.kind === 'workflow' && (expanded.has(i.key) || i.key === selectedWorkflow)) : [];
  const agentsOf = (item: Item): BgAgent[] | null => wf[item.key]?.agents ?? item.row?.t.agents ?? null;
  const timelines = new Map<string, WorkflowTimeline | null>();
  const timelineOf = (item: Item) => {
    if (!timelines.has(item.key)) {
      const agents = agentsOf(item);
      timelines.set(item.key, agents && item.row ? workflowTimeline(agents, item.row.t, item.row.status, nowMs) : null);
    }
    return timelines.get(item.key)!;
  };

  // Saved sub-agents the tasks do not name (foreground ones): read on demand.
  const nativeCapable = sessionCapabilities(provider).subagents !== 'none';
  const inventory = useBgSessionAgents(sessionId, provider, nativeOpen);

  // ── layout ──
  const win = friseWindow([...items, ...props.charon.filter((a) => a.depth > 0).map((a) => ({ start: a.startMs, end: a.endMs }))], range, nowMs);
  const { t0, t1 } = win;
  const shown = items.filter((i) => (i.end ?? nowMs) >= t0);
  const hidden = items.length - shown.length;
  const pct = (t: number) => (100 * (Math.min(t1, Math.max(t0, t)) - t0)) / (t1 - t0);
  const x = (t: number) => `${pct(t).toFixed(3)}%`;
  const track = useRef<HTMLDivElement>(null);
  const [trackPx, setTrackPx] = useState(800);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setTrackPx(el.clientWidth || 800));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const ticks = localTicks(t0, t1, Math.max(2, Math.floor(trackPx / 110)));
  // A centred clock label near the end would stick out past the track (and
  // sits under the end label anyway): only its grid line is drawn.
  const tickLabels = ticks.filter((t) => (pct(t) / 100) * trackPx <= trackPx - 56);
  const statuses = new Set<FriseStatus>();
  let hasWaves = false;
  const grid = <>
    {ticks.map((t) => <i key={`g${t}`} className="bgf-grid" style={{ left: x(t) }} />)}
    {win.live && t1 === nowMs && <i className="bgf-now-line" />}
  </>;
  const bar = (key: string, st: FriseStatus, start: number, end: number | null, tip: string, label?: string) => {
    statuses.add(st);
    const stop = end ?? nowMs;
    const wide = ((pct(stop) - pct(start)) / 100) * trackPx >= 52;
    // Never past the track's right edge: a bar narrower than its 6px minimum
    // (one that just started at "now") is pulled left to fit.
    return <button type="button" key={key} className={`bgf-bar ${st}${selected === key ? ' selected' : ''}`}
      style={{ left: `min(${x(start)}, 100% - 6px)`, width: `max(6px, ${x(stop)} - ${x(start)})` }} title={tip} aria-label={tip} aria-pressed={selected === key}
      onClick={(e) => { e.stopPropagation(); setSelected(key); }}>{wide ? label ?? short(stop - start) : ''}</button>;
  };

  const lanesRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const sel = el.querySelector('.bgf-lane.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' }); else el.scrollTop = el.scrollHeight;
  }, []); // once, at opening

  /** A sub-session's lane: its name opens it, its bar selects it. */
  const charonLane = (a: CharonAgent, sub: boolean) => {
    const key = `${CHARON}${a.id}`;
    const st = charonFriseStatus(a.status);
    const tip = [a.name, a.model && [a.model, a.effort].filter(Boolean).join(' '),
      `${clock(a.startMs)} → ${a.endMs == null ? text.wfNow : clock(a.endMs)}`, short((a.endMs ?? nowMs) - a.startMs), STATUS[st].legend].filter(Boolean).join(' · ');
    return <div key={key} className={`bgf-row bgf-lane${sub ? ' bgf-sub bgf-nested' : ''}${selected === key ? ' selected' : ''}`}
      style={sub ? { '--bgf-depth': a.depth - 1 } as CSSProperties : undefined} onClick={() => setSelected(key)}>
      <div className="bgf-name">
        {!sub && <span className="bgf-caret" aria-hidden />}
        <span className="bgf-kind charon" aria-label={text.charonAgent}>{ICON.charon}</span>
        <span className="bgf-title" title={a.handle ? `${a.name} · @${a.handle}` : a.name}>{a.name}{a.waiting && <small className="bgf-needs">needs you</small>}</span>
        <AgentRunTag model={a.model} effort={a.effort} />
        {props.onOpenSession && <button type="button" className="bgf-open" title={text.open} aria-label={`${text.open} ${a.name}`}
          onClick={(e) => { e.stopPropagation(); props.onOpenSession!(a.id); }}><IconBoxArrowUpRight /></button>}
      </div>
      <div className="bgf-track">{grid}{bar(key, st, a.startMs, a.endMs, tip)}</div>
    </div>;
  };

  const lanes: ReactNode[] = [];
  const alerts: ReactNode[] = [];
  if (hidden > 0 || olderEnded > 0) lanes.push(<div key="earlier" className="bgf-row bgf-earlier"><span>
    ↑ {hidden > 0 ? <>{text.earlier(hidden)} · <button type="button" onClick={() => setRange('all')}>{text.showEarlier}</button></> : text.olderNotKept(olderEnded)}
  </span></div>);
  for (const item of shown) {
    const t = item.row?.t;
    const isWf = item.kind === 'workflow';
    const open = isWf && expanded.has(item.key);
    const tl = isWf ? timelineOf(item) : null;
    const agents = isWf ? agentsOf(item) : null;
    const done = tl ? tl.done : agents?.filter((a) => ['done', 'completed'].includes((a.state ?? '').toLowerCase())).length ?? 0;
    const count = agents?.length ? `${done}/${agents.length}` : '';
    const run = item.kind === 'agent' ? runs.get(item.key) : undefined;
    const name = isWf ? t?.workflowName || item.title : item.title;
    const tip = [item.title, run?.model && [run.model, run.effort].filter(Boolean).join(' '),
      `${clock(item.start)} → ${item.end == null ? text.wfNow : clock(item.end)}`, short((item.end ?? nowMs) - item.start), STATUS[item.st].legend].filter(Boolean).join(' · ');
    if (item.charon) {
      lanes.push(charonLane(item.charon, false));
      for (const a of nested.get(item.charon.id) ?? []) lanes.push(charonLane(a, true));
      continue;
    }
    lanes.push(<div key={item.key} className={`bgf-row bgf-lane${selected === item.key ? ' selected' : ''}`} onClick={() => setSelected(item.key)}>
      <div className="bgf-name">
        {isWf
          ? <button type="button" className="bgf-caret" aria-expanded={open} onClick={(e) => { e.stopPropagation(); toggle(item.key); }}>{open ? '▾' : '▸'}</button>
          : <span className="bgf-caret" aria-hidden />}
        <span className={`bgf-kind ${item.kind}`} aria-label={KIND_LABEL[item.kind]}>{ICON[item.kind]}</span>
        <span className="bgf-title" title={item.title}>{name}{count && <small>{count}</small>}</span>
        {run && <AgentRunTag {...run} />}
      </div>
      <div className="bgf-track">{grid}{bar(item.key, item.st, item.start, item.end, tip, isWf && count ? `${count} · ${short((item.end ?? nowMs) - item.start)}` : undefined)}</div>
    </div>);
    if (!open) continue;
    if (tl) {
      if (tl.waves.length) {
        hasWaves = true;
        lanes.push(<div key={`${item.key}:marks`} className="bgf-row bgf-sub bgf-marks"><span /><div className="bgf-track">
          {tl.waves.map((w) => <span key={w.at} className="bgf-wave" style={{ left: x(w.at), maxWidth: `calc(100% - ${x(w.at)})` }} title={`${w.size} ${text.wfWave} · ${clock(w.at)}`}>{w.label}</span>)}
        </div></div>);
      }
      const waveLines = tl.waves.map((w) => <i key={`w${w.at}`} className="bgf-wave-line" style={{ left: x(w.at) }} />);
      for (const lane of tl.lanes) {
        const run = sharedRun(lane.agents.map((a) => a.agent));
        const last = lane.agents[lane.agents.length - 1];
        const laneSel = lane.agents.some((a) => selected === `${item.key}${SEP}${a.id}`);
        lanes.push(<div key={`${item.key}:${lane.role}`} className={`bgf-row bgf-sub bgf-lane${laneSel ? ' selected' : ''}`}
          onClick={() => setSelected(`${item.key}${SEP}${last.id}`)}>
          <div className="bgf-name"><span className="bgf-title" title={lane.role}>{lane.role}{lane.agents.length > 1 && <small>×{lane.agents.length}</small>}</span>
            {run && <AgentRunTag {...run} />}</div>
          <div className="bgf-track">{grid}{waveLines}{lane.agents.map((a) => bar(`${item.key}${SEP}${a.id}`, a.status, a.start, a.status === 'running' ? null : a.end,
            [a.agent.label, a.agent.phaseTitle, a.agent.model && [a.agent.model, a.agent.effort].filter(Boolean).join(' '),
              `${clock(a.start)} → ${a.status === 'running' ? text.wfNow : clock(a.end)}`, short(a.end - a.start), STATUS[a.status].legend, outcomeText(a.agent.outcome)]
              .filter(Boolean).join(' · ')))}</div>
        </div>);
      }
      if (tl.slow) alerts.push(<p key={item.key} className="bgf-alert">{text.wfSlow(tl.slow.agent.agent.label || '', fmtDuration(tl.slow.elapsed, { seconds: false }),
        short(tl.slow.usual), text.wfAgo(fmtDuration(Math.max(0, nowMs - (tl.slow.agent.agent.lastActivityAt ?? nowMs)), { seconds: false })))}</p>);
    } else if (agents?.length) {
      // Live progress without times: the agents, listed, no bars.
      agents.forEach((a, i) => {
        const key = `${item.key}${SEP}${agentKey(a, i)}`;
        lanes.push(<div key={key} className={`bgf-row bgf-sub bgf-lane${selected === key ? ' selected' : ''}`} onClick={() => setSelected(key)}>
          <div className="bgf-name"><span className="bgf-title">{a.label || `agent ${(a.index ?? i) + 1}`}</span><AgentRunTag model={a.model} effort={a.effort} /></div>
          <div className="bgf-track bgf-untimed">{a.state ?? ''} · {text.untimed}</div>
        </div>);
      });
    } else {
      const w = wf[item.key];
      lanes.push(<div key={`${item.key}:none`} className="bgf-row bgf-sub bgf-note"><span />
        <span>{w?.loading ? text.wfReading : w?.error || text.missingProgress}</span></div>);
    }
  }
  if (nativeCapable) {
    lanes.push(<div key="native" className="bgf-row bgf-native"><button type="button" aria-expanded={nativeOpen} onClick={() => setNativeOpen((o) => !o)}>
      {nativeOpen ? '▾' : '▸'} {text.sessionAgents}{nativeOpen && inventory.agents.length > 0 && <span> · {inventory.agents.length}</span>}</button></div>);
    if (nativeOpen) {
      if (inventory.loading) lanes.push(<div key="native:loading" className="bgf-row bgf-sub bgf-note"><span /><span>{text.inventoryLoading}</span></div>);
      else if (inventory.error) lanes.push(<div key="native:error" className="bgf-row bgf-sub bgf-note"><span /><span className="tm-error">{inventory.error}</span></div>);
      else if (!inventory.agents.length) lanes.push(<div key="native:none" className="bgf-row bgf-sub bgf-note"><span /><span>{text.noAgents}</span></div>);
      for (const a of inventory.agents) {
        const key = `native:${a.id}`;
        lanes.push(<div key={key} className={`bgf-row bgf-sub bgf-lane${selected === key ? ' selected' : ''}`} onClick={() => setSelected(key)}>
          <div className="bgf-name"><span className="bgf-title">{nativeName(a, agentLabels)}</span></div>
          <div className="bgf-track bgf-untimed">{text.transcript}</div>
        </div>);
      }
    }
  }

  const legend = LEGEND_ORDER.filter((s) => statuses.has(s));
  return <div className="bgf">
    {loaders.map((i) => <WorkflowAgentsLoader key={i.key} sessionId={sessionId} taskId={i.key} running={i.end == null} onAgents={onAgents} />)}
    <section className="bgf-chart">
      <div className="bgf-tools"><div className="bgf-range" role="group">
        {(['auto', '1h', '6h', 'all'] as const).map((r) => <button type="button" key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{text.ranges[r]}</button>)}
      </div></div>
      <div className="bgf-row bgf-axis"><span /><div className="bgf-track" ref={track}>
        {tickLabels.map((t) => <span key={t} style={{ left: x(t) }}>{clock(t)}</span>)}
        <span className="bgf-axis-end">{win.live && t1 === nowMs ? text.wfNow : clock(t1)}</span>
      </div></div>
      <div className="bgf-lanes" ref={lanesRef}>{!items.length && <p className="bgf-empty">{text.nothing}</p>}{lanes}</div>
      {(legend.length > 0 || hasWaves) && <div className="bgf-legend">
        {legend.map((s) => <span key={s}><i className={`bgf-key ${s}`} />{STATUS[s].legend}</span>)}
        {hasWaves && <span><i className="bgf-key wave" />{text.wfWave}</span>}
      </div>}
      {alerts}
      {terminalError && <div className="tm-error">Process list refresh failed: {terminalError}</div>}
    </section>
    <Detail {...props} items={items} selected={selected} select={setSelected} agentsOf={agentsOf} timelineOf={timelineOf}
      wf={wf} inventory={inventory.agents} nowMs={nowMs} />
  </div>;
}

function nativeName(a: NativeBgAgent, labels: ReadonlyMap<string, string>) {
  return a.name || a.role || labels.get(a.id) || a.id;
}

// ── detail ───────────────────────────────────────────────────────────────────

type DetailProps = Props & {
  items: Item[]; selected: string | null; select: (key: string) => void; nowMs: number;
  agentsOf: (item: Item) => BgAgent[] | null; timelineOf: (item: Item) => WorkflowTimeline | null;
  wf: Record<string, WorkflowAgents>; inventory: NativeBgAgent[];
};

function Head({ st, kind, title, run, actions }: { st: FriseStatus; kind: string; title: string; run?: AgentRun; actions?: ReactNode }) {
  return <div className="bgf-head">
    <Pill st={st} /><span className="bgf-head-kind">{kind}</span><h3 title={title}>{title}</h3>
    {run && <AgentRunTag {...run} />}<span className="bgf-spacer" />{actions}
  </div>;
}

function StopButton({ pending, onStop, hint = text.stopHint }: { pending: boolean; onStop: () => void; hint?: string }) {
  return <button type="button" className="tm-stop" disabled={pending} onClick={onStop} title={hint}>{pending ? text.stopping : text.stop}</button>;
}

function Detail(props: DetailProps) {
  const { items, selected, nowMs } = props;
  if (!selected) return null;
  if (selected.startsWith(CHARON)) {
    const agent = props.charon.find((a) => a.id === selected.slice(CHARON.length));
    return agent ? <CharonDetail {...props} agent={agent} /> : null;
  }
  if (selected.startsWith('native:')) {
    const id = selected.slice('native:'.length);
    const agent = props.inventory.find((a) => a.id === id);
    return <section className="bgf-detail">
      <Head st="unknown" kind={text.sessionAgents} title={agent ? nativeName(agent, props.agentLabels) : id} />
      <BgTaskOutput key={selected} sessionId={props.sessionId} vpsId={props.vpsId} cwd={props.cwd} nativeAgentId={id}
        richNative={props.provider === 'claude'} identity={selected} preview={agent?.preview} running />
    </section>;
  }
  const [key, sub] = selected.split(SEP);
  const item = items.find((i) => i.key === key);
  if (!item) return null;
  if (sub != null) return <WorkflowAgentDetail {...props} item={item} agentId={sub} />;
  if (item.kind === 'workflow') return <WorkflowDetail {...props} item={item} />;
  return <TaskDetail {...props} item={item} nowMs={nowMs} />;
}

function Facts({ item, nowMs, extra }: { item: Item; nowMs: number; extra?: ReactNode }) {
  const t = item.row?.t;
  const running = item.end == null;
  return <div className="bgf-facts">
    {t && <span>{text.wfStartedAt} <b>{fmtMoment(item.start, nowMs)}</b></span>}
    {!running && <span>{text.ended.toLowerCase()} <b>{fmtMoment(item.end!, nowMs)}</b></span>}
    {t && <span>{running ? text.wfRunningFor : text.wfTook} <b>{fmtDuration((item.end ?? nowMs) - item.start)}</b></span>}
    {!!t?.usage?.tokens && <span><b>{t.usage.tokens >= 1000 ? `${(t.usage.tokens / 1000).toFixed(t.usage.tokens >= 10_000 ? 0 : 1)}k` : t.usage.tokens}</b> {text.tokens.toLowerCase()}</span>}
    {extra}
    {t && <span title={t.taskType ? `type: ${t.taskType}` : undefined}>id <code>{t.taskId}</code></span>}
  </div>;
}

function TaskDetail({ item, nowMs, provider, sessionId, vpsId, cwd, killing, onStop, terminalKilling, onStopTerminal, runs }: DetailProps & { item: Item }) {
  const t = item.row?.t;
  const running = item.end == null;
  const pid = item.terminal ? terminalId(item.terminal) : t ? codexTerminalProcessId(t.taskId) : null;
  const run = item.kind === 'agent' ? runs.get(item.key) : undefined;
  let actions: ReactNode = null;
  if (running && t) {
    actions = provider !== 'codex' || pid
      ? <StopButton pending={killing[t.taskId] === 'pending'} onStop={() => onStop(t.taskId)} />
      : <span className="tm-nostop" title={providerText.noPerItemStop(provider)}>no per-item stop</span>;
  } else if (running && pid) {
    actions = <StopButton pending={terminalKilling[pid] === 'pending'} onStop={() => onStopTerminal(pid)} hint="Stop this process. The session keeps running." />;
  }
  const kstate = t ? killing[t.taskId] : pid ? terminalKilling[pid] : undefined;
  const term = item.terminal;
  const cpu = term?.cpu_percent ?? term?.cpuPercent;
  const rss = term?.rss_kb ?? term?.rssKb;
  const ownAgent = t ? bgTaskOwnAgent(t, provider) : null;
  const isCommand = item.kind === 'command' || item.kind === 'process' || item.kind === 'task';
  // The CLI's summary of a command is its description or its command line: not output.
  const preview = t?.summary && t.summary !== t.description && t.summary !== t.command ? t.summary : null;
  return <section className="bgf-detail">
    <Head st={item.st} kind={KIND_LABEL[item.kind]} title={item.title} run={run} actions={actions} />
    <Facts item={item} nowMs={nowMs} />
    {item.st === 'timelimit' && <p className="bgf-note warn">{text.timeLimitHint}</p>}
    {item.st === 'lost' && <p className="bgf-note">{text.lostHint}</p>}
    {kstate && kstate !== 'pending' && <div className="tm-error">Could not stop it: {kstate}</div>}
    {t?.command && t.command !== item.title && <pre className="tm-code bgf-cmdline">{t.command}</pre>}
    {term && <dl className="bgf-proc">
      <div><dt>{text.cpu}</dt><dd>{cpu != null ? `${cpu}%` : '—'}</dd></div>
      <div><dt>{text.memory}</dt><dd>{rss != null ? `${Math.round(rss / 1024)} MB` : '—'}</dd></div>
      <div><dt>{text.pid}</dt><dd>{pid || '—'}</dd></div>
      {term.cwd && <div><dt>{text.folder}</dt><dd>{term.cwd}</dd></div>}
    </dl>}
    {t && (ownAgent
      ? <BgTaskOutput key={`${t.taskId}:${t.startedAt}`} sessionId={sessionId} vpsId={vpsId} cwd={cwd} nativeAgentId={ownAgent} richNative
        identity={`${t.taskId}:${t.startedAt}`} mission={t.description} preview={t.summary} running={running} />
      : <BgTaskOutput key={`${t.taskId}:${t.startedAt}`} sessionId={sessionId} vpsId={vpsId} cwd={cwd} outputFile={t.outputFile}
        plain={isCommand} preview={isCommand ? preview : t.summary} running={running}
        emptyHint={isCommand ? (running ? text.noCommandOutput : text.noCommandOutputEnded) : undefined} />)}
    {t?.outputFile && <div className="tm-path" title={t.outputFile}><span>output</span><code>{t.outputFile}</code></div>}
  </section>;
}

function CharonDetail({ agent, nowMs, charon, charonUsage, onOpenSession, interrupting, onInterrupt }: DetailProps & { agent: CharonAgent }) {
  const used = charonUsage?.[agent.id];
  const st = charonFriseStatus(agent.status);
  const inTurn = agent.status === 'thinking' || agent.status === 'starting';
  const state = interrupting[agent.id];
  const parent = agent.depth > 0 ? charon.find((a) => a.id === agent.parentId) : undefined;
  const actions = <>
    {inTurn && <button type="button" className="tm-stop" disabled={state === 'pending'} onClick={() => onInterrupt(agent.id)}
      title={text.interruptHint}>{state === 'pending' ? text.stopping : text.interrupt}</button>}
    {onOpenSession && <button type="button" className="bgf-open-btn" onClick={() => onOpenSession(agent.id)}>
      <IconBoxArrowUpRight />{text.open}</button>}
  </>;
  return <section className="bgf-detail">
    <Head st={st} kind={`${text.charonAgent} · ${providerLabel(asSessionProvider(agent.kind))}`} title={agent.name}
      run={{ model: agent.model, effort: agent.effort }} actions={actions} />
    <div className="bgf-facts">
      {agent.waiting && <span className="bgf-needs">needs you</span>}
      {agent.handle && <span><b>@{agent.handle}</b></span>}
      {parent && <span>{text.under} <b>{parent.handle ? `@${parent.handle}` : parent.name}</b></span>}
      <span>{text.wfStartedAt} <b>{fmtMoment(agent.startMs, nowMs)}</b></span>
      {agent.endMs != null && <span>{text.ended.toLowerCase()} <b>{fmtMoment(agent.endMs, nowMs)}</b></span>}
      <span>{agent.running ? text.wfRunningFor : text.wfTook} <b>{fmtDuration((agent.endMs ?? nowMs) - agent.startMs)}</b></span>
      {used?.tokens != null && <span><b>{fmtTokens(used.tokens)}</b> {text.tokens.toLowerCase()}</span>}
      {used && used.turns > 0 && <span><b>{used.turns}</b> turn{used.turns === 1 ? '' : 's'}</span>}
      {used?.costUsd != null && <span><b>${used.costUsd.toFixed(2)}</b></span>}
      <span>{agent.status}</span>
    </div>
    {state && state !== 'pending' && <div className="tm-error">{state}</div>}
    <BgAgentActivity key={agent.id} sessionId={agent.id} session={agent.id} runShown running={agent.running} identity={`${CHARON}${agent.id}`} />
  </section>;
}

function WorkflowDetail({ item, nowMs, provider, killing, onStop, agentsOf, timelineOf, wf, select }: DetailProps & { item: Item }) {
  const t = item.row!.t;
  const running = item.end == null;
  const agents = agentsOf(item);
  const tl = timelineOf(item);
  const byId = new Map(tl?.agents.map((a) => [a.id, a]) ?? []);
  const done = tl ? tl.done : agents?.filter((a) => ['done', 'completed'].includes((a.state ?? '').toLowerCase())).length ?? 0;
  const actions = running ? (provider !== 'codex'
    ? <StopButton pending={killing[t.taskId] === 'pending'} onStop={() => onStop(t.taskId)} />
    : <span className="tm-nostop" title={providerText.noPerItemStop(provider)}>no per-item stop</span>) : null;
  const w = wf[item.key];
  return <section className="bgf-detail">
    <Head st={item.st} kind={`${text.workflow} · ${t.workflowName ?? ''}`} title={t.description || t.workflowName || t.taskId} actions={actions} />
    <Facts item={item} nowMs={nowMs} extra={<>
      {agents?.length ? <span><b>{done}/{agents.length}</b> {text.wfAgentsDone}</span> : null}
      {tl?.lastActivityAt != null && <span>{text.wfLastActivity} <b>{text.wfAgo(fmtDuration(Math.max(0, nowMs - tl.lastActivityAt), { seconds: false }))}</b></span>}
    </>} />
    {killing[t.taskId] && killing[t.taskId] !== 'pending' && <div className="tm-error">Could not stop it: {killing[t.taskId]}</div>}
    {tl && tl.phases.length > 1 && <div className="bgf-phases">{tl.phases.map((p) =>
      <div key={p.name} className={`bgf-phase ${p.status}`} style={{ flexGrow: p.size }}><i /><span><b>{p.name || '—'}</b> {p.size}</span></div>)}</div>}
    {!agents?.length
      ? <p className="bgf-note">{w?.loading ? text.wfReading : w?.error || text.missingProgress}</p>
      : <div className="bgf-agents"><table><tbody>{agents.map((a, i) => {
        const id = agentKey(a, i);
        const timed = byId.get(id);
        const st: FriseStatus = timed ? timed.status
          : ['done', 'completed'].includes((a.state ?? '').toLowerCase()) ? 'done' : ['failed', 'error'].includes((a.state ?? '').toLowerCase()) ? 'failed' : running ? 'running' : 'unknown';
        return <tr key={id} onClick={() => select(`${item.key}${SEP}${id}`)}>
          <td><Pill st={st} /></td>
          <td className="bgf-agent-label">{a.label || `agent ${(a.index ?? i) + 1}`}</td>
          <td><AgentRunTag model={a.model} effort={a.effort} /></td>
          <td className="bgf-dim">{timed ? short(timed.end - timed.start) : a.durationMs != null ? short(a.durationMs) : ''}</td>
          <td className="bgf-outcome">{outcomeText(a.outcome) || a.resultPreview || ''}</td>
        </tr>;
      })}</tbody></table></div>}
  </section>;
}

function WorkflowAgentDetail({ item, agentId, nowMs, provider, sessionId, vpsId, cwd, agentsOf, timelineOf }: DetailProps & { item: Item; agentId: string }) {
  const t = item.row!.t;
  const agents = agentsOf(item) ?? [];
  const index = agents.findIndex((a, i) => agentKey(a, i) === agentId);
  const agent = agents[index];
  if (!agent) return <section className="bgf-detail"><p className="bgf-note">{text.wfPickAgent}</p></section>;
  const timed: TimelineAgent | undefined = timelineOf(item)?.agents.find((a) => a.id === agentId);
  const st: FriseStatus = timed?.status ?? (item.end == null ? 'running' : 'unknown');
  const running = st === 'running';
  const label = agent.label || `agent ${(agent.index ?? index) + 1}`;
  return <section className="bgf-detail">
    <Head st={st} kind={`${text.agent} · ${t.workflowName ?? ''}`} title={label} run={{ model: agent.model, effort: agent.effort }}
      actions={running ? <span className="tm-nostop" title={text.parentStop}>{text.noPerAgentStop}</span> : null} />
    <div className="bgf-facts">
      {agent.phaseTitle && <span>{text.phase.toLowerCase()} <b>{agent.phaseTitle}</b></span>}
      {timed && <span>{clock(timed.start)} → <b>{running ? text.wfNow : clock(timed.end)}</b></span>}
      {timed && <span>{running ? text.wfRunningFor : text.wfTook} <b>{short((running ? nowMs : timed.end) - timed.start)}</b></span>}
      {outcomeText(agent.outcome) && <span className="bgf-outcome">{outcomeText(agent.outcome)}</span>}
    </div>
    {provider === 'claude' && agent.agentId
      ? <BgAgentActivity key={`${t.taskId}:${agent.agentId}`} sessionId={sessionId} task={t.taskId} workflowAgent={agent.agentId}
        phase={agent.phaseTitle || undefined} running={running} identity={`${t.taskId}:${t.startedAt}:${agent.agentId}`} />
      : <BgTaskOutput key={`${t.taskId}:${agentId}`} sessionId={sessionId} vpsId={vpsId} cwd={cwd}
        workflowTask={provider === 'claude' && agent.label ? t.taskId : undefined} workflowLabel={agent.label || undefined}
        workflowPhase={agent.phaseTitle || undefined} identity={`${t.taskId}:${t.startedAt}:${agentId}`}
        preview={agent.resultPreview} running={running} />}
  </section>;
}

export default memo(BgFrise);
