'use client';
import { memo, useEffect, useMemo, useState } from 'react';
import type { BgTask, BgTaskStatus } from './bgTasks';

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

const STATUS_META: Record<BgTaskStatus, { glyph: string; label: string; cls: string }> = {
  running: { glyph: '●', label: 'running', cls: 'running' },
  completed: { glyph: '✓', label: 'completed', cls: 'completed' },
  failed: { glyph: '✗', label: 'failed', cls: 'failed' },
  killed: { glyph: '⊘', label: 'killed', cls: 'killed' },
  stale: { glyph: '◌', label: 'unknown (session restarted)', cls: 'stale' },
};

function fmtElapsed(fromS: number, toS: number): string {
  const d = Math.max(0, toS - fromS);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m${String(d % 60).padStart(2, '0')}s`;
  return `${Math.floor(d / 3600)}h${String(Math.floor((d % 3600) / 60)).padStart(2, '0')}m`;
}

function taskTitle(t: BgTask): string {
  return t.description || t.workflowName || t.command || t.taskId;
}

function BgTasksBarImpl({ tasks }: { tasks: BgTask[] }) {
  const [open, setOpen] = useState(false);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));

  const running = useMemo(() => tasks.filter((t) => t.status === 'running'), [tasks]);
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const visible = running.length > 0
    || (tasks.length > 0 && lastEndedAt > 0 && nowS - lastEndedAt < ENDED_GRACE_S);
  if (!visible) return null;

  const headline = running.length > 0
    ? `${running.length} background task${running.length > 1 ? 's' : ''} running`
    : 'background tasks finished';
  const newest = running.length > 0 ? running[running.length - 1] : tasks[0];

  return (
    <>
      <button
        type="button"
        className={`bgtasks-bar${running.length > 0 ? ' active' : ''}`}
        onClick={() => setOpen(true)}
        title="click for background task details"
      >
        <span className={`bgtasks-dot ${running.length > 0 ? 'running' : 'done'}`} aria-hidden />
        <span className="bgtasks-headline">{headline}</span>
        {newest && (
          <span className="bgtasks-snippet">
            {isWorkflow(newest) && <span className="bgtask-badge workflow" aria-hidden>⚙</span>}
            {taskTitle(newest)}
            {newest.agents && newest.agents.length > 0 && ` · ${agentsDone(newest)}/${newest.agents.length} agents`}
            {newest.status === 'running' && ` · ${fmtElapsed(newest.startedAt, nowS)}`}
          </span>
        )}
        <span className="bgtasks-more" aria-hidden>▸ details</span>
      </button>

      {open && (
        <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="claude-modal bgtasks-modal">
            <button className="modal-close" onClick={() => setOpen(false)}>✕</button>
            <h2>background tasks</h2>
            <p className="bgtasks-help">
              Processes this session launched in the background. When one
              finishes, the agent is woken automatically and its report streams
              into the chat — no need to send a message.
            </p>
            <div className="bgtasks-list">
              {tasks.map((t) => {
                const meta = STATUS_META[t.status] ?? STATUS_META.stale;
                const end = t.endedAt ?? nowS;
                return (
                  <div key={t.taskId} className={`bgtask-row ${meta.cls}`}>
                    <div className="bgtask-head">
                      <span className={`bgtask-status ${meta.cls}`} title={meta.label}>{meta.glyph} {meta.label}</span>
                      {isWorkflow(t) && (
                        <span className="bgtask-badge workflow" title={t.workflowName ? `workflow: ${t.workflowName}` : 'Workflow tool run'}>
                          ⚙ workflow{t.workflowName ? ` · ${t.workflowName}` : ''}
                        </span>
                      )}
                      <span className="bgtask-id" title={`task id: ${t.taskId}${t.taskType ? ` · type: ${t.taskType}` : ''}`}>{t.taskId}</span>
                      <span className="bgtask-time">
                        {t.status === 'running'
                          ? `running for ${fmtElapsed(t.startedAt, nowS)}`
                          : `${fmtElapsed(t.startedAt, end)} · ended ${new Date(end * 1000).toLocaleTimeString()}`}
                        {t.usage && (t.usage.tokens ?? 0) > 0 && <span className="bgtask-usage"> · ↑{t.usage.tokens} tok</span>}
                      </span>
                    </div>
                    {t.description && <div className="bgtask-desc">{t.description}</div>}
                    {t.command && <pre className="bgtask-cmd">{t.command}</pre>}
                    {t.summary && <div className="bgtask-summary">{t.summary}</div>}
                    {t.agents && t.agents.length > 0 && (
                      <div className="bgtask-agents">
                        {t.agents.map((a, i) => {
                          const st = AGENT_STATE[(a.state ?? '').toLowerCase()] ?? { glyph: '◦', cls: 'stale' };
                          return (
                            <div key={a.label ?? i} className={`bgagent ${st.cls}`}>
                              <span className={`bgagent-state ${st.cls}`} aria-hidden>{st.glyph}</span>
                              <span className="bgagent-label">{a.label || `agent ${(a.index ?? i) + 1}`}</span>
                              {a.phaseTitle && <span className="bgagent-phase">{a.phaseTitle}</span>}
                              {a.model && <span className="bgagent-model">{a.model}</span>}
                              {typeof a.tokens === 'number' && a.tokens > 0 && <span className="bgagent-tok">↑{a.tokens}</span>}
                              {a.resultPreview && <span className="bgagent-result" title={a.resultPreview}>{a.resultPreview}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {t.outputFile && (
                      <div className="bgtask-output" title="output file on the VPS — ask the agent to read/tail it for live output">
                        ⎿ {t.outputFile}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const BgTasksBar = memo(BgTasksBarImpl);
export default BgTasksBar;
