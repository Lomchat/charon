// The session's background work as ONE frise: every command, agent, workflow
// and Codex process on a shared clock axis. Pure layout — `BgFrise.tsx` draws.
import { codexTerminalProcessId, isBgCommandTask, type BgTask, type BgTaskStatus } from './bgTasks';
import type { TimelineStatus } from './bgWorkflowTimeline';

/** A Codex background terminal as the live registry reports it. */
export type CodexTerminal = {
  process_id?: string; processId?: string;
  command?: string | string[]; cwd?: string;
  cpu_percent?: number | null; cpuPercent?: number | null;
  rss_kb?: number | null; rssKb?: number | null;
};
export function terminalId(term: CodexTerminal): string {
  return String(term.process_id ?? term.processId ?? '');
}
export function terminalCommand(term: CodexTerminal): string {
  if (Array.isArray(term.command)) return term.command.join(' ');
  return typeof term.command === 'string' && term.command ? term.command : terminalId(term);
}

export type FriseKind = 'command' | 'agent' | 'workflow' | 'process' | 'task' | 'charon';
export function isWorkflowTask(t: Pick<BgTask, 'taskType' | 'workflowName'>): boolean {
  return t.taskType === 'local_workflow' || !!t.workflowName;
}
export function friseKind(t: Pick<BgTask, 'taskType' | 'workflowName' | 'taskId'>): FriseKind {
  if (isWorkflowTask(t)) return 'workflow';
  if (codexTerminalProcessId(t.taskId)) return 'process';
  if (isBgCommandTask(t)) return 'command';
  if (['local_agent', 'in_process_teammate', 'codex_subagent', 'codex_collab'].includes(t.taskType ?? '')) return 'agent';
  return 'task';
}

/** One colour vocabulary for tasks and workflow agents (a superset of the
 *  workflow timeline's own statuses). */
export type FriseStatus = TimelineStatus | 'stopped' | 'timelimit' | 'lost';
export function friseStatus(t: Pick<BgTask, 'stopCause'>, status: BgTaskStatus): FriseStatus {
  switch (status) {
    case 'running': return 'running';
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'killed': return t.stopCause === 'time_limit' ? 'timelimit' : 'stopped';
    default: return 'lost';
  }
}
/** A Charon sub-session's lane: its live status (§14.91). */
export function charonFriseStatus(status: string): FriseStatus {
  switch (status) {
    case 'thinking': case 'starting': case 'background': return 'running';
    case 'active': return 'done';
    case 'failed': case 'error': return 'failed';
    case 'sleeping': return 'stopped';
    default: return 'unknown';
  }
}
/** 12.4M, 830k, 512. */
export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
export type FriseRange = 'auto' | '1h' | '6h' | 'all';
export type FriseSpan = { start: number; end: number | null };
const HOUR = 3_600_000;
/** Auto keeps what runs, what ended in the last half hour of activity, and
 *  the three latest items unless they are hours older (a lone recent item
 *  must not be squashed by a window reaching back days). */
const AUTO_RECENT_MS = 30 * 60_000;
const AUTO_LATEST_MAX_MS = 6 * HOUR;

/** The visible clock window. Ends at now while something runs (or for a
 *  fixed range), else at the last end: a finished session's frise stops
 *  where its work stopped. */
export function friseWindow(spans: FriseSpan[], range: FriseRange, nowMs: number): { t0: number; t1: number; live: boolean } {
  if (!spans.length) return { t0: nowMs - HOUR, t1: nowMs, live: true };
  const running = spans.some((s) => s.end == null);
  const lastEnd = Math.max(...spans.map((s) => s.end ?? nowMs));
  const live = running || range !== 'auto';
  const t1 = live ? nowMs : lastEnd;
  let t0: number;
  if (range === '1h') t0 = nowMs - HOUR;
  else if (range === '6h') t0 = nowMs - 6 * HOUR;
  else if (range === 'all') t0 = Math.min(...spans.map((s) => s.start));
  else {
    const recent = spans.filter((s) => s.end == null || s.end >= t1 - AUTO_RECENT_MS).map((s) => s.start);
    const latest = [...spans].sort((a, b) => b.start - a.start).slice(0, 3).map((s) => s.start)
      .filter((start) => start >= t1 - AUTO_LATEST_MAX_MS);
    t0 = Math.min(...recent, ...latest, t1 - 60_000);
  }
  const span = Math.max(t1 - t0, 60_000);
  return { t0: t1 - span * 1.03, t1, live };
}
