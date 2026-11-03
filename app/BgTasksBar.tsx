'use client';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { sessionApi } from '@/lib/api';
import { createLatestGate } from './sync/revResource';
import TaskModal, { TaskGroup } from './TaskModal';
import BgTaskConstellation from './BgTaskConstellation';
import { backgroundWorkText } from '@/lib/providerText';
import { fmtDuration, fmtMoment } from './taskTime';
import { CODEX_TERMINAL_TASK_PREFIX, codexTerminalProcessId, effectiveBgStatus } from './bgTasks';
import type { BgTask, BgTaskStatus } from './bgTasks';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import { providerText } from '@/lib/providerText';

type CodexTerminal = {
  process_id?: string; processId?: string;
  command?: string | string[]; cwd?: string;
  cpu_percent?: number | null; cpuPercent?: number | null;
  rss_kb?: number | null; rssKb?: number | null;
};

function terminalId(term: CodexTerminal): string {
  return String(term.process_id ?? term.processId ?? '');
}

function terminalCommand(term: CodexTerminal): string {
  if (Array.isArray(term.command)) return term.command.join(' ');
  return typeof term.command === 'string' && term.command ? term.command : terminalId(term);
}

// Per-sub-agent state glyphs for a Workflow run's fan-out (bg_task_progress).
const AGENT_STATE: Record<string, { glyph: string; cls: string }> = {
  start: { glyph: '◐', cls: 'running' },
  running: { glyph: '◐', cls: 'running' },
  done: { glyph: '✓', cls: 'completed' },
  error: { glyph: '✗', cls: 'failed' },
  failed: { glyph: '✗', cls: 'failed' },
};

function agentsDone(t: BgTask): number {
  return (t.agents ?? []).filter((a) => (a.state ?? '').toLowerCase() === 'done').length;
}
function isWorkflow(t: BgTask): boolean {
  return t.taskType === 'local_workflow' || !!t.workflowName;
}

// ── BgTasksBar ───────────────────────────────────────────────────────────────
// Slim status line above the chat input: shows the session's BACKGROUND tasks
// (Bash run_in_background / background subagents) — how many are running and
// what the freshest one is doing. Click → modal with the full registry
// (command, status, elapsed, output file, completion summary).
//
// Rendering rules:
//   - visible while ≥1 task is running, plus a grace window after the last
//     one ends (so a "✓ finished" state is glanceable without opening the
//     modal — the spontaneous turn usually narrates it anyway);
//   - memo'd and self-contained (own 1s ticker only while running) so it
//     never contributes to the typing/streaming hot path (§14.38).

const ENDED_GRACE_S = 600; // keep the bar 10min after the last task ended

const STATUS_META: Record<BgTaskStatus, { label: string; cls: string; hint?: string }> = {
  running: { label: 'running', cls: 'running' },
  completed: { label: 'done', cls: 'completed' },
  failed: { label: 'failed', cls: 'failed' },
  killed: { label: 'stopped', cls: 'killed' },
  stale: { label: 'lost', cls: 'stale', hint: 'The session restarted while this ran: its outcome is unknown.' },
};

function fmtElapsed(fromS: number, toS: number): string {
  const d = Math.max(0, toS - fromS);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m${String(d % 60).padStart(2, '0')}s`;
  return `${Math.floor(d / 3600)}h${String(Math.floor((d % 3600) / 60)).padStart(2, '0')}m`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k tokens` : `${n} tokens`;
}

function taskTitle(t: BgTask): string {
  return t.description || t.workflowName || t.command || t.taskId;
}

function BgTasksBarImpl({ tasks, sessionId, provider, sessionStatus, vpsId, cwd }: {
  tasks: BgTask[];
  sessionId: string;
  vpsId: string;
  cwd: string | null;
  provider: SessionProvider;
  sessionStatus: string;
}) {
  const [open, setOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(20);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  // taskId → in-flight/failed kill. Pessimistic (§14.18): the row keeps saying
  // "running" until the CLI's own terminal event arrives, because only the CLI
  // knows whether the task actually died.
  const [killing, setKilling] = useState<Record<string, 'pending' | string>>({});
  const [terminals, setTerminals] = useState<CodexTerminal[]>([]);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalKilling, setTerminalKilling] = useState<Record<string, 'pending' | string>>({});

  const kill = useCallback(async (taskId: string) => {
    setKilling((k) => ({ ...k, [taskId]: 'pending' }));
    try {
      await sessionApi.stopBackgroundTask(sessionId, taskId);
    } catch (e: any) {
      setKilling((k) => ({ ...k, [taskId]: e?.message ?? 'failed' }));
    }
  }, [sessionId]);

  // Latest-STARTED request wins (R3 F13): the poll, a kill's refresh and an
  // effect re-run overlap; an older answer must never overwrite a newer one.
  const [terminalsGate] = useState(createLatestGate);
  const refreshTerminals = useCallback(async () => {
    if (provider !== 'codex') return;
    const n = terminalsGate.next();
    try {
      const response = await fetch(`/api/claude/sessions/${sessionId}/background-terminals`, {
        cache: 'no-store',
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      if (!terminalsGate.isLatest(n)) return;
      setTerminals(Array.isArray(data.terminals) ? data.terminals : []);
      setTerminalError(null);
    } catch (error: any) {
      if (!terminalsGate.isLatest(n)) return;
      // Preserve the last good registry on a transient VPS failure. A stale
      // process row is safer than making running work disappear on one poll.
      setTerminalError(error?.message ?? 'background process lookup failed');
    }
  }, [provider, sessionId, terminalsGate]);

  const killTerminal = useCallback(async (processId: string) => {
    setTerminalKilling((current) => ({ ...current, [processId]: 'pending' }));
    try {
      const response = await fetch(`/api/claude/sessions/${sessionId}/background-terminals`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ processId }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      setTerminalKilling((current) => {
        const next = { ...current }; delete next[processId]; return next;
      });
      await refreshTerminals();
    } catch (error: any) {
      setTerminalKilling((current) => ({
        ...current, [processId]: error?.message ?? 'failed',
      }));
    }
  }, [refreshTerminals, sessionId]);

  useEffect(() => {
    if (provider !== 'codex' || !['starting', 'active', 'thinking', 'background'].includes(sessionStatus)) {
      setTerminals([]); setTerminalError(null); return;
    }
    void refreshTerminals();
    const delay = open || sessionStatus === 'thinking' ? 3_000 : 12_000;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshTerminals();
    }, delay);
    return () => clearInterval(timer);
  }, [open, provider, refreshTerminals, sessionStatus]);

  // Age-capped view of the registry: a task running past the cap is `stale`,
  // not live work (`effectiveBgStatus`). Recomputed off the 1s ticker, so a
  // task that ages out while the bar is open stops claiming to be running.
  const view = useMemo(
    () => tasks.map((t) => ({ t, status: effectiveBgStatus(t, nowS) })),
    [tasks, nowS],
  );
  const terminalTaskIds = useMemo(
    () => new Set(terminals.map((term) => `${CODEX_TERMINAL_TASK_PREFIX}${terminalId(term)}`)),
    [terminals],
  );
  const taskView = useMemo(
    () => view.filter(({ t }) => !terminalTaskIds.has(t.taskId)),
    [terminalTaskIds, view],
  );
  const running = useMemo(
    () => taskView.filter((v) => v.status === 'running').map((v) => v.t),
    [taskView],
  );
  // The modal's two groups: what still runs (oldest first), what ended
  // (newest first) — the order `bgTasksToArray` already gives.
  const runningRows = useMemo(() => taskView.filter((v) => v.status === 'running'), [taskView]);
  const ended = useMemo(() => taskView.filter((v) => v.status !== 'running'), [taskView]);
  const lastEndedAt = useMemo(
    () => tasks.reduce((m, t) => Math.max(m, t.endedAt ?? 0), 0),
    [tasks],
  );

  // 1s ticker for the elapsed display — armed only while something runs
  // (or the modal is open on a running list). Self-contained state: ticking
  // re-renders THIS memo'd component only, never the chat.
  useEffect(() => {
    if (running.length === 0 && !open) return;
    const iv = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(iv);
  }, [running.length, open]);

  const selectedTask = taskView.find(({ t }) => t.taskId === selectedTaskId)
    ?? runningRows[runningRows.length - 1] ?? ended[0];

  const close = useCallback(() => setOpen(false), []);

  const runningCount = running.length + terminals.length;
  const visible = runningCount > 0
    || (tasks.length > 0 && lastEndedAt > 0 && nowS - lastEndedAt < ENDED_GRACE_S);
  if (!visible) return null;

  const headline = runningCount > 0
    ? `${runningCount} background work item${runningCount > 1 ? 's' : ''} running`
    : 'background work finished';
  const newest = running.length > 0 ? running[running.length - 1]
    : terminals.length > 0 ? undefined : tasks[0];
  const newestTerminal = terminals[terminals.length - 1];

  function renderTask({ t, status }: { t: BgTask; status: BgTaskStatus }) {
    const meta = STATUS_META[status] ?? STATUS_META.stale;
    const end = t.endedAt ?? nowS;
    const kstate = killing[t.taskId];
    // A Codex row is stoppable only when it IS a background terminal (its
    // task id carries the process id): the provider has no per-item stop for
    // a sub-agent spawn, so offering ⊘ there could only produce an error toast.
    const stoppable = provider !== 'codex' || !!codexTerminalProcessId(t.taskId);
    const title = taskTitle(t);
    const tokens = t.usage?.tokens ?? 0;
    return (
      <article key={t.taskId} className={`tm-card ${meta.cls}`}>
        <div className="tm-card-top">
          <span className={`tm-pill ${meta.cls}`} title={meta.hint}><i aria-hidden />{meta.label}</span>
          <button type="button" className="tm-card-title bgc-inspect-task" onClick={() => setSelectedTaskId(t.taskId)} title={backgroundWorkText.inspect}>{title}</button>
          {status === 'running' && (stoppable ? (
            // Kills the TASK, not the session. The row stays "running" until
            // the CLI's own terminal event lands (§14.18).
            <button
              type="button"
              className="tm-stop"
              disabled={kstate === 'pending'}
              onClick={() => kill(t.taskId)}
              title="Stop this task. The session keeps running."
            >
              {kstate === 'pending' ? 'stopping…' : 'Stop'}
            </button>
          ) : (
            <span className="tm-nostop" title={providerText.noPerItemStop(provider)}>no per-item stop</span>
          ))}
        </div>
        <div className="tm-meta">
          {isWorkflow(t) && (
            <span className="tm-tag workflow" title="Workflow tool run">workflow{t.workflowName ? ` · ${t.workflowName}` : ''}</span>
          )}
          <span>{status === 'running'
            ? `running for ${fmtDuration((nowS - t.startedAt) * 1000)}`
            : `took ${fmtDuration((end - t.startedAt) * 1000)}`}</span>
          <span>{status === 'running'
            ? `started ${fmtMoment(t.startedAt * 1000, nowS * 1000)}`
            : `ended ${fmtMoment(end * 1000, nowS * 1000)}`}</span>
          {tokens > 0 && <span>{fmtTokens(tokens)}</span>}
          <span className="tm-id" title={t.taskType ? `type: ${t.taskType}` : undefined}>{t.taskId}</span>
        </div>
        {meta.hint && <div className="tm-note muted">{meta.hint}</div>}
        {kstate && kstate !== 'pending' && <div className="tm-error">Could not stop it: {kstate}</div>}
        {t.command && t.command !== title && <pre className="tm-code">{t.command}</pre>}
        {t.summary && <div className="tm-note">{t.summary}</div>}
        {t.agents && t.agents.length > 0 && (
          <div className="tm-agents">
            <div className="tm-agents-h">
              sub-agents · {agentsDone(t)}/{t.agents.length} done
            </div>
            {t.agents.map((a, i) => {
              const st = AGENT_STATE[(a.state ?? '').toLowerCase()] ?? { glyph: '◦', cls: 'stale' };
              return (
                <div key={a.label ?? i} className={`tm-agent ${st.cls}`}>
                  <span className={`tm-agent-state ${st.cls}`} aria-hidden>{st.glyph}</span>
                  <span className="tm-agent-label">{a.label || `agent ${(a.index ?? i) + 1}`}</span>
                  {a.phaseTitle && <span className="tm-agent-dim">{a.phaseTitle}</span>}
                  {a.model && <span className="tm-agent-dim">{a.model}</span>}
                  {typeof a.tokens === 'number' && a.tokens > 0 && <span className="tm-agent-dim">{fmtTokens(a.tokens)}</span>}
                  {a.resultPreview && <span className="tm-agent-result" title={a.resultPreview}>{a.resultPreview}</span>}
                </div>
              );
            })}
          </div>
        )}
        {t.outputFile && (
          <div className="tm-path" title="Output file on the VPS: ask the session to read it for the live output">
            <span>output</span><code>{t.outputFile}</code>
          </div>
        )}
      </article>
    );
  }

  function renderTerminal(term: CodexTerminal, i: number) {
    const processId = terminalId(term);
    const cpu = term.cpu_percent ?? term.cpuPercent;
    const rss = term.rss_kb ?? term.rssKb;
    const kstate = terminalKilling[processId];
    return (
      <article key={processId || `terminal-${i}`} className="tm-card running">
        <div className="tm-card-top">
          <span className="tm-pill running"><i aria-hidden />running</span>
          <span className="tm-card-title mono">{terminalCommand(term)}</span>
          {!!processId && (
            <button type="button" className="tm-stop" disabled={kstate === 'pending'}
              onClick={() => void killTerminal(processId)} title="Stop this process. The session keeps running.">
              {kstate === 'pending' ? 'stopping…' : 'Stop'}
            </button>
          )}
        </div>
        <div className="tm-meta">
          <span className="tm-tag">process</span>
          {cpu != null && <span>{cpu}% CPU</span>}
          {rss != null && <span>{Math.round(rss / 1024)} MB</span>}
          <span className="tm-id">{processId || 'unknown pid'}</span>
        </div>
        {term.cwd && <div className="tm-path"><span>in</span><code>{term.cwd}</code></div>}
        {kstate && kstate !== 'pending' && <div className="tm-error">Could not stop it: {kstate}</div>}
      </article>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`bgtasks-bar${runningCount > 0 ? ' active' : ''}`}
        onClick={() => setOpen(true)}
        title="click for background task details"
      >
        <span className={`bgtasks-dot ${runningCount > 0 ? 'running' : 'done'}`} aria-hidden />
        <span className="bgtasks-headline">{headline}</span>
        {newest && (
          <span className="bgtasks-snippet">
            {isWorkflow(newest) && <span className="bgtask-badge workflow" aria-hidden>⚙</span>}
            {taskTitle(newest)}
            {newest.agents && newest.agents.length > 0 && ` · ${agentsDone(newest)}/${newest.agents.length} agents`}
            {running.length > 0 && ` · ${fmtElapsed(newest.startedAt, nowS)}`}
          </span>
        )}
        {!newest && newestTerminal && (
          <span className="bgtasks-snippet">
            <span className="bgtask-badge workflow" aria-hidden>⌘</span>
            {terminalCommand(newestTerminal)}
          </span>
        )}
        <span className="bgtasks-more" aria-hidden>▸ details</span>
      </button>

      {open && (
        <TaskModal
          icon={<span className={`bgtasks-dot ${runningCount > 0 ? 'running' : 'done'}`} />}
          tone="work"
          wide
          title="Background work"
          subtitle={<>
            {runningCount > 0 ? `${runningCount} running` : 'Nothing running'}
            {ended.length > 0 && ` · ${ended.length} finished`}
            {' · stopping one leaves the session running'}
          </>}
          onClose={close}
        >
          {selectedTask && <>
            <div className="bgc-task-picker">
              <label htmlFor="bgc-task-select">{backgroundWorkText.task}</label>
              <select id="bgc-task-select" value={selectedTask.t.taskId} onChange={(e) => setSelectedTaskId(e.target.value)}>
                {runningRows.length > 0 && <optgroup label={backgroundWorkText.running}>{runningRows.map(({ t }) => <option key={t.taskId} value={t.taskId}>{taskTitle(t)}</option>)}</optgroup>}
                {ended.length > 0 && <optgroup label={backgroundWorkText.finished}>{ended.slice(0, historyLimit).map(({ t }) => <option key={t.taskId} value={t.taskId}>{taskTitle(t)}</option>)}</optgroup>}
              </select>
            </div>
            <BgTaskConstellation key={`${selectedTask.t.taskId}:${selectedTask.t.startedAt}`} task={selectedTask.t} status={selectedTask.status}
              vpsId={vpsId} cwd={cwd} provider={provider} nowS={nowS} killing={killing[selectedTask.t.taskId]} onStop={kill} />
          </>}
          <TaskGroup label="Processes" count={terminals.length}>{terminals.map(renderTerminal)}</TaskGroup>
          {terminalError && <div className="tm-error">Process list refresh failed: {terminalError}</div>}
          {ended.length > 0 && <section className="bgc-history">
            <button type="button" className="bgc-history-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>
              {historyOpen ? '⌄' : '›'} {backgroundWorkText.finished} <span>{ended.length}</span>
            </button>
            {historyOpen && <div className="tm-cards">{ended.slice(0, historyLimit).map(renderTask)}
              {ended.length > historyLimit && <button type="button" className="bgc-more" onClick={() => setHistoryLimit((n) => n + 20)}>{backgroundWorkText.showMore}</button>}
            </div>}
          </section>}
          {runningRows.length + terminals.length + ended.length === 0 && (
            <p className="tm-empty">Nothing in the background right now.</p>
          )}
        </TaskModal>
      )}
    </>
  );
}

const BgTasksBar = memo(BgTasksBarImpl);
export default BgTasksBar;
