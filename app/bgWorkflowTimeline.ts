// The workflow FRISE (Gantt): a saved workflow's agents on a wall-clock axis,
// one lane per role. Pure layout — the component only draws it. Times come
// from the hub's reading of the run folder (`workflowTranscript.ts §
// workflowAgentTimes`), outcomes from its result summary.
import type { WorkflowResultSummary } from '@/lib/types/api';
import type { BgAgent, BgTaskStatus } from './bgTasks';

export type TimelineStatus = 'running' | 'done' | 'negative' | 'failed' | 'unknown';
export type TimelineAgent = { agent: BgAgent; id: string; start: number; end: number; status: TimelineStatus; role: string };
export type WorkflowTimeline = {
  t0: number; t1: number;
  lanes: Array<{ role: string; agents: TimelineAgent[] }>;
  /** Agents started together (≤ 5 s apart, 2+): a round of a loop, a fan-out. */
  waves: Array<{ at: number; label: string; size: number }>;
  phases: Array<{ name: string; status: TimelineStatus; size: number }>;
  ticks: number[];
  agents: TimelineAgent[];
  running: TimelineAgent[];
  done: number;
  lastActivityAt: number | null;
  /** A running agent far slower than its lane's earlier runs. */
  slow: { agent: TimelineAgent; elapsed: number; usual: number } | null;
};

const WAVE_GAP_MS = 5_000;
const SLOW_FACTOR = 2;
const SLOW_MIN_MS = 20 * 60_000;
const TICK_STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];

/** One lane per role: a label without its round marks (`r2:judge` → `judge`,
 *  `fix-2` → `fix`), so successive rounds line up. */
export function workflowRole(label: string): string {
  const role = label.replace(/^[a-z]{0,8}\d+[:/]\s*/i, '').replace(/[-_ #]\d+$/, '').trim();
  return role || label;
}

/** A result whose only boolean is false is a "no" (a judge's `deliverable:
 *  false`): the agent did its job and answered no. */
export function negativeOutcome(o?: WorkflowResultSummary | null): boolean {
  return !!o?.flags && o.flags.length === 1 && o.flags[0].value === false;
}

/** The outcome in one line: booleans, list sizes (by their few values), or
 *  the result's own short text. */
export function outcomeText(o?: WorkflowResultSummary | null): string {
  if (!o) return '';
  const parts = [
    ...(o.flags ?? []).map((f) => `${f.key} ${f.value ? '✓' : '✗'}`),
    ...(o.counts ?? []).map((c) => `${c.key} ${c.n}${c.by?.length ? ` (${c.by.map((b) => `${b.value} ${b.n}`).join(', ')})` : ''}`),
  ];
  if (!parts.length && o.text) parts.push(o.text.length > 80 ? `${o.text.slice(0, 79)}…` : o.text);
  return parts.join(' · ');
}

function agentStatus(a: BgAgent, workflowRunning: boolean): TimelineStatus {
  const s = (a.state ?? '').toLowerCase();
  if (s === 'done' || s === 'completed') return negativeOutcome(a.outcome) ? 'negative' : 'done';
  if (s === 'failed' || s === 'error') return 'failed';
  // No result yet: running while the workflow runs, unknown once it ended.
  return workflowRunning ? 'running' : 'unknown';
}

/** Null when no agent carries a start time (live progress only, an older
 *  hub): the caller keeps the plain graph. */
export function workflowTimeline(
  agents: BgAgent[], task: { startedAt: number; endedAt: number | null }, status: BgTaskStatus, nowMs: number,
): WorkflowTimeline | null {
  const running = status === 'running';
  const placed: TimelineAgent[] = agents.flatMap((agent, i) => {
    if (agent.startedAt == null) return [];
    const st = agentStatus(agent, running);
    const end = st === 'running' ? Math.max(nowMs, agent.startedAt) : Math.max(agent.lastActivityAt ?? agent.startedAt, agent.startedAt);
    return [{ agent, id: agent.agentId ?? `${i}:${agent.label ?? ''}`, start: agent.startedAt, end, status: st, role: workflowRole(agent.label || `agent ${i + 1}`) }];
  }).sort((a, b) => a.start - b.start);
  if (!placed.length) return null;

  const t0 = Math.min(task.startedAt * 1000, placed[0].start);
  const last = Math.max(...placed.map((a) => a.end), running ? nowMs : (task.endedAt ?? 0) * 1000);
  const t1 = Math.max(last + (last - t0) * 0.02, t0 + 60_000);

  const lanes: WorkflowTimeline['lanes'] = [];
  for (const a of placed) {
    const lane = lanes.find((l) => l.role === a.role);
    if (lane) lane.agents.push(a); else lanes.push({ role: a.role, agents: [a] });
  }

  const groups: TimelineAgent[][] = [];
  for (const a of placed) {
    const g = groups[groups.length - 1];
    if (g && a.start - g[0].start <= WAVE_GAP_MS) g.push(a); else groups.push([a]);
  }
  const waves = groups.filter((g) => g.length > 1).map((g) => {
    const prefixes = new Set(g.map((a) => /^([^:/\s]{1,12})[:/]/.exec(a.agent.label ?? '')?.[1] ?? ''));
    const [prefix] = [...prefixes];
    return { at: g[0].start, size: g.length, label: prefixes.size === 1 && prefix ? prefix.toUpperCase() : `×${g.length}` };
  });

  const phases: WorkflowTimeline['phases'] = [];
  for (const a of placed) {
    const name = a.agent.phaseTitle || '';
    const p = phases.find((x) => x.name === name);
    if (p) p.size++; else phases.push({ name, status: a.status, size: 1 });
  }
  for (const p of phases) {
    const st = placed.filter((a) => (a.agent.phaseTitle || '') === p.name).map((a) => a.status);
    p.status = st.includes('running') ? 'running' : st.includes('failed') ? 'failed' : st.includes('unknown') ? 'unknown' : 'done';
  }

  const span = t1 - t0;
  const step = (TICK_STEPS_MIN.find((m) => span / (m * 60_000) <= 8) ?? 1440) * 60_000;
  const offset = new Date(t0).getTimezoneOffset() * 60_000;     // ticks on local round times
  const ticks: number[] = [];
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t < t1; t += step) ticks.push(t);

  let slow: WorkflowTimeline['slow'] = null;
  for (const a of placed) {
    if (a.status !== 'running') continue;
    const before = placed.filter((b) => b.role === a.role && b !== a && b.status !== 'running' && b.status !== 'unknown');
    if (!before.length) continue;
    const usual = Math.max(...before.map((b) => b.end - b.start));
    const elapsed = nowMs - a.start;
    if (elapsed > SLOW_MIN_MS && elapsed > SLOW_FACTOR * usual && (!slow || elapsed / usual > slow.elapsed / slow.usual)) {
      slow = { agent: a, elapsed, usual };
    }
  }

  const activity = placed.map((a) => a.agent.lastActivityAt ?? 0).filter(Boolean);
  return {
    t0, t1, lanes, waves, phases, ticks, agents: placed,
    running: placed.filter((a) => a.status === 'running'),
    done: placed.filter((a) => a.status !== 'running' && a.status !== 'unknown').length,
    lastActivityAt: activity.length ? Math.max(...activity) : null,
    slow,
  };
}
