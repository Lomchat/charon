'use client';
import { memo, useCallback, useEffect, useState } from 'react';
import TaskModal from './TaskModal';
import { IconBullseye } from './icons';
import { fmtMoment } from './taskTime';
import { api } from '@/lib/api';
import { providerText } from '@/lib/providerText';
import { GOAL_STATUS_LABEL, goalIsLive, shownGoal, type SessionGoal } from '@/lib/sessionGoal';
import type { SessionProvider } from '@/lib/sessionCapabilities';

// ── GoalBar ──────────────────────────────────────────────────────────────────
// The line beside BgTasksBar / ScheduledTasksBar for what the session keeps
// working toward (CLAUDE.md §14.119), straight from the session summary.
// Click → its details (the evaluator's last verdict, tokens, time) and the
// actions: clear, close once reached. Setting one is the provider's `/goal`.

/** The pill tone a status reads as (shared `.tm-pill` palette). */
function tone(g: SessionGoal): 'running' | 'completed' | 'failed' | 'due' {
  if (g.status === 'active') return 'running';
  if (g.status === 'met') return 'completed';
  if (g.status === 'failed') return 'failed';
  return 'due';
}

function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function duration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

/** What the goal has cost so far, in one line. */
function progress(g: SessionGoal): string {
  const parts: string[] = [];
  if (g.iterations) parts.push(`${g.iterations} check${g.iterations === 1 ? '' : 's'}`);
  if (g.tokensUsed != null) parts.push(g.tokenBudget ? `${tokens(g.tokensUsed)} / ${tokens(g.tokenBudget)} tokens` : `${tokens(g.tokensUsed)} tokens`);
  else if (g.tokenBudget) parts.push(`budget ${tokens(g.tokenBudget)} tokens`);
  if (g.timeUsedS) parts.push(duration(g.timeUsedS));
  return parts.join(' · ');
}

function GoalBarImpl({ goal: raw, sessionId, provider }: {
  goal: SessionGoal | null | undefined; sessionId: string; provider: SessionProvider;
}) {
  const goal = shownGoal(raw);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (open) setNow(Date.now()); }, [open]);
  const close = useCallback(() => { setOpen(false); setError(null); }, []);

  if (!goal) return null;
  const live = goalIsLive(goal);
  const t = tone(goal);
  const line = progress(goal);

  async function act(run: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await run(); close(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update the goal.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" className={`bgtasks-bar goal ${t}`} onClick={() => setOpen(true)} title="click for the goal">
        <span className="bgtasks-ico" aria-hidden><IconBullseye /></span>
        <span className="bgtasks-headline">goal · {GOAL_STATUS_LABEL[goal.status]}</span>
        <span className="bgtasks-snippet">{goal.objective}{line ? ` · ${line}` : ''}</span>
        <span className="bgtasks-more" aria-hidden>▸ details</span>
      </button>

      {open && (
        <TaskModal icon={<IconBullseye />} tone="goal" title="Goal"
          subtitle={live ? 'What this session keeps working toward' : goal.status === 'met' ? 'Reached' : 'Stopped'}
          onClose={close}
          foot={providerText.goalWhere(provider)}>
          <article className={`tm-card ${t === 'running' ? 'running' : t === 'completed' ? 'completed' : t === 'failed' ? 'failed' : 'due'}`}>
            <div className="tm-card-top">
              <span className={`tm-pill ${t}`}><i aria-hidden />{GOAL_STATUS_LABEL[goal.status]}</span>
              <span className="tm-card-title goal-objective">{goal.objective}</span>
            </div>
            <div className="tm-meta">
              {goal.setAt != null && <span>set {fmtMoment(goal.setAt, now)}</span>}
              {goal.updatedAt != null && goal.updatedAt !== goal.setAt && <span>last check {fmtMoment(goal.updatedAt, now)}</span>}
              {line && <span>{line}</span>}
            </div>
            {goal.reason && <div className="goal-reason">
              <h5>{goal.status === 'met' ? 'Why it is reached' : goal.status === 'failed' ? 'Why it cannot be' : 'Last check'}</h5>
              <p>{goal.reason}</p>
            </div>}
          </article>
          {error && <p className="goal-error" role="alert">{error}</p>}
          <div className="goal-actions">
            {live
              ? <button type="button" disabled={busy} onClick={() => void act(() => api.setSessionGoal(sessionId, null))}>Clear goal</button>
              : <button type="button" disabled={busy} onClick={() => void act(() => api.dismissSessionGoal(sessionId))}>Close</button>}
          </div>
        </TaskModal>
      )}
    </>
  );
}

const GoalBar = memo(GoalBarImpl);
export default GoalBar;
