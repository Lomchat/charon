'use client';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { sessionApi } from '@/lib/api';
import { createLatestGate } from './sync/revResource';
import TaskModal from './TaskModal';
import BgFrise from './BgFrise';
import { bgTaskOwnAgent, bgWorkItems, CODEX_TERMINAL_TASK_PREFIX, effectiveBgStatus } from './bgTasks';
import { useBgAgentRuns } from './AgentRunTag';
import { isWorkflowTask, terminalCommand, terminalId, type CodexTerminal } from './bgFrise';
import type { BgTask } from './bgTasks';
import type { SessionProvider } from '@/lib/sessionCapabilities';

// ── BgTasksBar ───────────────────────────────────────────────────────────────
// Slim status line above the chat input: shows the session's BACKGROUND tasks
// (Bash run_in_background / background subagents) — how many are running and
// what the freshest one is doing. Click → the modal: ONE frise of every
// command, agent, workflow and process (`BgFrise`), the selected one's detail
// underneath.
//
// Rendering rules:
//   - visible while ≥1 task is running, plus a grace window after the last
//     one ends (so a "✓ finished" state is glanceable without opening the
//     modal — the spontaneous turn usually narrates it anyway);
//   - memo'd and self-contained (own 1s ticker only while running) so it
//     never contributes to the typing/streaming hot path (§14.38).

const ENDED_GRACE_S = 600; // keep the bar 10min after the last task ended
// A stop the CLI never answers must not leave the button disabled for good.
const STOP_RETRY_MS = 20_000;

function fmtElapsed(fromS: number, toS: number): string {
  const d = Math.max(0, toS - fromS);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m${String(d % 60).padStart(2, '0')}s`;
  return `${Math.floor(d / 3600)}h${String(Math.floor((d % 3600) / 60)).padStart(2, '0')}m`;
}

function taskTitle(t: BgTask): string {
  return t.description || t.workflowName || t.command || t.taskId;
}

function agentsDone(t: BgTask): number {
  return (t.agents ?? []).filter((a) => (a.state ?? '').toLowerCase() === 'done').length;
}

function BgTasksBarImpl({ tasks, olderEnded = 0, sessionId, provider, sessionStatus, vpsId, cwd }: {
  tasks: BgTask[];
  /** Finished items older than the hub's history (counted, not listed). */
  olderEnded?: number;
  sessionId: string;
  vpsId: string;
  cwd: string | null;
  provider: SessionProvider;
  sessionStatus: string;
}) {
  const [open, setOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
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
      setTimeout(() => setKilling((k) => {
        if (k[taskId] !== 'pending') return k;
        const next = { ...k }; delete next[taskId]; return next;
      }), STOP_RETRY_MS);
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
      const response = await fetch(`/api/sessions/${sessionId}/background-terminals`, {
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
      const response = await fetch(`/api/sessions/${sessionId}/background-terminals`, {
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
  // A sub-agent's own commands are steps of their owner, not items (`bgWorkItems`).
  const view = useMemo(
    () => bgWorkItems(tasks.map((t) => ({ t, status: effectiveBgStatus(t, nowS) }))),
    [tasks, nowS],
  );
  // A Codex process the live registry lists is counted once: by the registry.
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
  const ended = useMemo(() => taskView.filter((v) => v.status !== 'running'), [taskView]);
  const lastEndedAt = useMemo(
    () => view.reduce((m, { t }) => Math.max(m, t.endedAt ?? 0), 0),
    [view],
  );

  // 1s ticker for the elapsed display — armed only while something runs
  // (or the modal is open on a running list). Self-contained state: ticking
  // re-renders THIS memo'd component only, never the chat.
  useEffect(() => {
    if (running.length === 0 && !open) return;
    const iv = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(iv);
  }, [running.length, open]);

  const defaultTask = running[running.length - 1] ?? ended[0]?.t;
  // What each background agent runs on (model + effort), read while open.
  const agentIds = useMemo(() => view.flatMap(({ t }) => { const id = bgTaskOwnAgent(t, provider); return id ? [id] : []; }).slice(-50),
    [view, provider]);
  const agentRuns = useBgAgentRuns(sessionId, agentIds, open);
  // Session sub-agents are listed by native id; a `local_agent` task id IS it.
  const agentLabels = useMemo(() => new Map(tasks.flatMap((t) => t.description ? [[t.taskId, t.description] as const] : [])), [tasks]);

  const close = useCallback(() => setOpen(false), []);

  const runningCount = running.length + terminals.length;
  // An open modal never vanishes under its reader when the grace runs out.
  const visible = open || runningCount > 0
    || (view.length > 0 && lastEndedAt > 0 && nowS - lastEndedAt < ENDED_GRACE_S);
  if (!visible) return null;

  // Phone: "bg" (app.css swaps the two words at the 820px breakpoint).
  const headline = <>
    {runningCount > 0 && `${runningCount} `}
    <span className="bg-long">background work</span><span className="bg-short">bg</span>
    {runningCount > 0 ? ' running' : ' finished'}
  </>;
  const newest = running.length > 0 ? running[running.length - 1]
    : terminals.length > 0 ? undefined : ended[0]?.t;
  const newestTerminal = terminals[terminals.length - 1];

  return (
    <>
      <button
        type="button"
        className={`bgtasks-bar${runningCount > 0 ? ' active' : ''}`}
        // Pin the task shown at opening: a later launch must not swap it out.
        onClick={() => { setSelectedTaskId(defaultTask?.taskId ?? null); setOpen(true); }}
        title="click for background task details"
      >
        <span className={`bgtasks-dot ${runningCount > 0 ? 'running' : 'done'}`} aria-hidden />
        <span className="bgtasks-headline">{headline}</span>
        {newest && (
          <span className="bgtasks-snippet">
            {isWorkflowTask(newest) && <span className="bgtask-badge workflow" aria-hidden>⚙</span>}
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
            {ended.length + olderEnded > 0 && ` · ${ended.length + olderEnded} finished`}
            {' · stopping one leaves the session running'}
          </>}
          onClose={close}
        >
          <BgFrise rows={view} terminals={terminals} terminalError={terminalError} olderEnded={olderEnded}
            sessionId={sessionId} vpsId={vpsId} cwd={cwd} provider={provider} nowS={nowS}
            killing={killing} onStop={kill} terminalKilling={terminalKilling} onStopTerminal={killTerminal}
            runs={agentRuns} agentLabels={agentLabels} initialSelected={selectedTaskId} />
        </TaskModal>
      )}
    </>
  );
}

const BgTasksBar = memo(BgTasksBarImpl);
export default BgTasksBar;
