'use client';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import TaskModal, { TaskGroup } from './TaskModal';
import { IconAlarm } from './icons';
import { fmtCountdown, fmtMoment } from './taskTime';
import {
  describeSchedule, recurringExpiresAt, scheduledTaskBody, scheduledTaskTitle,
  type ScheduledTask, type ScheduledTasksState,
} from '@/lib/scheduledTasks';

// ── ScheduledTasksBar ────────────────────────────────────────────────────────
// The line beside BgTasksBar for what will WAKE this session later: the CLI's
// CronCreate / ScheduleWakeup / /loop tasks (lib/scheduledTasks.ts), straight
// from the session summary. Click → a modal with each task's next run, its
// schedule and the prompt it will send. Read-only: nothing can cancel a task
// from outside the CLI, so the way to change one is to ask the session.
//
// Memo'd with its own ticker (per 30 s, per second while the modal is open,
// only while there is something to show), so the countdowns never re-render
// the chat (§14.38).

/** States in which the CLI process runs, hence in which its tasks can fire. */
const AWAKE: ReadonlySet<string> = new Set(['starting', 'active', 'thinking', 'background', 'failed']);

/** Soonest first; a task with no known next run goes last. */
function bySoonest(a: ScheduledTask, b: ScheduledTask): number {
  if (a.nextFireAt == null || b.nextFireAt == null) return a.nextFireAt == null ? (b.nextFireAt == null ? 0 : 1) : -1;
  return a.nextFireAt - b.nextFireAt;
}

/** "this task's next run", in words, for the bar and the card's pill. */
function whenLabel(t: ScheduledTask, now: number, paused: boolean): string {
  if (paused) return 'paused';
  if (t.nextFireAt == null) return t.recurring ? 'next run unknown' : 'due';
  return fmtCountdown(t.nextFireAt, now);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function ScheduledTasksBarImpl({ state, sessionStatus }: {
  state: ScheduledTasksState | null | undefined;
  sessionStatus: string;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const tasks = state?.tasks;
  const count = tasks?.length ?? 0;
  const sorted = useMemo(() => [...(tasks ?? [])].sort(bySoonest), [tasks]);

  useEffect(() => {
    if (count === 0) return;
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), open ? 1000 : 30_000);
    return () => clearInterval(iv);
  }, [count, open]);

  const close = useCallback(() => setOpen(false), []);

  if (sorted.length === 0) return null;
  const paused = !AWAKE.has(sessionStatus);
  const next = sorted[0];
  const once = sorted.filter((t) => !t.recurring);
  const recurring = sorted.filter((t) => t.recurring);
  // The cron fields are the VPS's local time; the moments below are this
  // browser's. Say so only when the two differ.
  const tz = state?.tz;
  const otherZone = tz && tz.offsetMin !== -new Date(now).getTimezoneOffset();

  const card = (t: ScheduledTask) => {
    const label = whenLabel(t, now, paused);
    const tone = paused ? 'paused' : t.nextFireAt == null || t.nextFireAt < now - 60_000 ? 'due' : 'scheduled';
    const body = scheduledTaskBody(t);
    return (
      <article key={t.id} className={`tm-card ${tone}`}>
        <div className="tm-card-top">
          <span className={`tm-pill ${tone}`}><i aria-hidden />{label}</span>
          <span className="tm-card-title">{scheduledTaskTitle(t)}</span>
        </div>
        <div className="tm-when">
          {t.nextFireAt != null && (
            <strong title={t.recurring
              ? 'The CLI spreads recurring tasks out: each runs a fixed delay (up to 30 min) after its slot'
              : undefined}>
              {paused ? 'would run ' : ''}{fmtMoment(t.nextFireAt, now)}
            </strong>
          )}
          <span title={`cron: ${t.schedule}`}>
            {describeSchedule(t.schedule, t.recurring)}{otherZone ? ` (VPS time${tz?.name ? `, ${tz.name}` : ''})` : ''}
          </span>
        </div>
        <div className="tm-meta">
          <span className="tm-tag">{t.recurring ? 'recurring' : 'once'}</span>
          <span>created {fmtMoment(t.createdAt, now)}</span>
          {t.recurring && <span>expires ≈ {fmtMoment(recurringExpiresAt(t), now)}</span>}
          <span className="tm-id">{t.id}</span>
        </div>
        {body && <PromptBlock text={body} />}
      </article>
    );
  };

  return (
    <>
      <button
        type="button"
        className={`bgtasks-bar sched${paused ? ' paused' : ''}`}
        onClick={() => setOpen(true)}
        title="click for the scheduled tasks"
      >
        <span className="bgtasks-ico" aria-hidden><IconAlarm /></span>
        <span className="bgtasks-headline">
          {plural(sorted.length, 'scheduled task')}{paused ? ' · paused' : ''}
        </span>
        <span className="bgtasks-snippet">
          {paused ? 'they run again once the session wakes up' : (
            <>
              next: {scheduledTaskTitle(next)}
              {next.nextFireAt != null && ` · ${fmtMoment(next.nextFireAt, now)} (${fmtCountdown(next.nextFireAt, now)})`}
            </>
          )}
        </span>
        <span className="bgtasks-more" aria-hidden>▸ details</span>
      </button>

      {open && (
        <TaskModal
          icon={<IconAlarm />}
          tone="scheduled"
          title="Scheduled tasks"
          subtitle={<>
            {plural(sorted.length, 'prompt')} this session will send itself
            {otherZone && ` · schedules in VPS time${tz?.name ? ` (${tz.name})` : ''}, times below in yours`}
          </>}
          onClose={close}
          foot={<>
            The session set these itself (CronCreate, ScheduleWakeup, /loop). To change or
            cancel one, ask it in the chat.
          </>}
        >
          {paused && (
            <div className="tm-banner">
              This session is paused. Its tasks run only while it is awake: the CLI restores
              them when the session resumes.
            </div>
          )}
          <TaskGroup label="Once" count={once.length}>{once.map(card)}</TaskGroup>
          <TaskGroup label="Recurring" count={recurring.length}>{recurring.map(card)}</TaskGroup>
        </TaskModal>
      )}
    </>
  );
}

/** A prompt, folded past a few lines. */
function PromptBlock({ text }: { text: string }) {
  const long = text.length > 320 || text.split('\n').length > 5;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`tm-prompt${long && !expanded ? ' folded' : ''}`}>
      <div className="tm-prompt-h">prompt it will send</div>
      <div className="tm-prompt-text">{text}</div>
      {long && (
        <button type="button" className="tm-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'show less' : 'show all'}
        </button>
      )}
    </div>
  );
}

const ScheduledTasksBar = memo(ScheduledTasksBarImpl);
export default ScheduledTasksBar;
