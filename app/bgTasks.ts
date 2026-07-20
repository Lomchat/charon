// Per-session BACKGROUND TASK registry (Bash run_in_background / background
// subagents launched by the Claude CLI on the VPS).
//
// Source of truth: the agent's `bg_task` events (agent >= 0.13.0), normalized
// from the SDK's first-class TaskStartedMessage / TaskUpdatedMessage /
// TaskNotificationMessage. They are persisted as role='event' rows
// ({type:'bg_task'}) so the registry can be rebuilt from history
// (sessionRebuild) and patched live from the SSE (useClaudeSessionStream) —
// the SAME reducer below serves both paths, mirroring the toolCalls pairing
// pattern (CLAUDE.md §14.39: change the live path ⇒ change the rebuild path;
// here they share the code instead).
//
// The launching `tool_use` (Bash, input.run_in_background) is correlated via
// tool_use_id to recover the actual COMMAND string (TaskStartedMessage only
// carries a human description). The tool_use arrives just before the
// 'started' event in stream order, so candidates are registered by the time
// they're consumed.

export type BgTaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'stale';

export type BgTask = {
  taskId: string;
  // Human description from the CLI (TaskStartedMessage.description).
  description: string | null;
  // The launched shell command (from the Bash tool_use input) — null for
  // non-bash tasks (background subagents) or if the launch wasn't observed.
  command: string | null;
  toolUseId: string | null;
  taskType: string | null; // e.g. 'local_bash', 'local_workflow', agent tasks…
  status: BgTaskStatus;
  startedAt: number; // epoch seconds
  endedAt: number | null;
  outputFile: string | null;
  // Completion summary from the notification ("Background command "…"
  // completed (exit code 0)").
  summary: string | null;
  // Workflow-tool runs (taskType 'local_workflow'): the script name.
  workflowName: string | null;
  // Live progress from TRANSIENT bg_task_progress (not persisted → null after a
  // refetch). `agents` = a Workflow run's per-sub-agent fan-out (§14.54).
  usage: BgTaskUsage | null;
  lastToolName: string | null;
  agents: BgAgent[] | null;
};

// One sub-agent inside a running Workflow-tool task.
export type BgAgent = {
  index: number | null;
  label: string | null;
  state: string | null; // 'start' | 'done' | …
  model: string | null;
  phaseTitle: string | null;
  tokens: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  resultPreview: string | null;
};

export type BgTaskUsage = { tokens: number | null; toolUses: number | null; durationMs: number | null };

// Wire/persisted shape (WorkerEvent 'bg_task' / role='event' row payload).
export type BgTaskEventLike = {
  kind: 'started' | 'updated' | 'finished';
  taskId: string;
  description?: string;
  toolUseId?: string;
  taskType?: string;
  status?: string;
  outputFile?: string;
  summary?: string;
  workflowName?: string;
};

// Transient bg_task_progress payload (broadcast-only; never persisted).
export type BgTaskProgressEventLike = {
  taskId: string;
  description?: string;
  lastToolName?: string;
  workflowName?: string;
  usage?: { tokens?: number | null; tool_uses?: number | null; duration_ms?: number | null };
  agents?: Array<{
    index?: number | null; label?: string | null; state?: string | null;
    model?: string | null; phaseTitle?: string | null; tokens?: number | null;
    toolCalls?: number | null; durationMs?: number | null; resultPreview?: string | null;
  }>;
  phases?: Array<{ index?: number | null; title?: string | null }>;
};

// Launch candidates: Bash tool_use with run_in_background, keyed by the SDK
// tool_use id, consumed by the matching 'started' event.
export type BgLaunchCandidate = { command: string | null; description: string | null };

function normStatus(raw: string | undefined, fallback: BgTaskStatus): BgTaskStatus {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('kill') || s.includes('cancel') || s.includes('abort')) return 'killed';
  if (s.includes('fail') || s.includes('error') || s.includes('timeout')) return 'failed';
  if (s.includes('complet') || s.includes('success') || s.includes('done')) return 'completed';
  if (s.includes('run') || s.includes('start') || s.includes('pending')) return 'running';
  return fallback;
}

const TERMINAL: ReadonlySet<BgTaskStatus> = new Set(['completed', 'failed', 'killed']);

/** Apply one bg_task event to the registry (mutates `map`). Returns true if
 *  anything changed — callers use it to decide whether to refresh state. */
export function applyBgTaskEvent(
  map: Map<string, BgTask>,
  ev: BgTaskEventLike,
  at: number,
  launchCandidates?: Map<string, BgLaunchCandidate>,
): boolean {
  if (!ev || !ev.taskId) return false;
  let t = map.get(ev.taskId);
  if (!t) {
    // 'updated'/'finished' for a task whose 'started' we never saw (history
    // truncated by pagination) still materializes an entry — better a
    // command-less row than a silent drop.
    t = {
      taskId: ev.taskId,
      description: ev.description ?? null,
      command: null,
      toolUseId: ev.toolUseId ?? null,
      taskType: ev.taskType ?? null,
      status: 'running',
      startedAt: at,
      endedAt: null,
      outputFile: ev.outputFile ?? null,
      summary: null,
      workflowName: ev.workflowName ?? null,
      usage: null,
      lastToolName: null,
      agents: null,
    };
    map.set(ev.taskId, t);
  }
  if (ev.description) t.description = ev.description;
  if (ev.toolUseId) t.toolUseId = ev.toolUseId;
  if (ev.taskType) t.taskType = ev.taskType;
  if (ev.workflowName) t.workflowName = ev.workflowName;
  if (ev.outputFile) t.outputFile = ev.outputFile;
  if (ev.summary) t.summary = ev.summary;
  if (t.toolUseId && !t.command && launchCandidates) {
    const cand = launchCandidates.get(t.toolUseId);
    if (cand) {
      t.command = cand.command;
      if (!t.description && cand.description) t.description = cand.description;
    }
  }
  if (ev.kind === 'finished') {
    t.status = normStatus(ev.status, 'completed');
    if (!TERMINAL.has(t.status)) t.status = 'completed';
    t.endedAt = at;
  } else if (ev.kind === 'updated') {
    const next = normStatus(ev.status, t.status);
    if (TERMINAL.has(next) && !TERMINAL.has(t.status)) t.endedAt = at;
    t.status = next;
  } else if (ev.kind === 'started') {
    if (!TERMINAL.has(t.status)) t.status = 'running';
    t.startedAt = at;
  }
  return true;
}

/** Apply one TRANSIENT bg_task_progress event: live usage + (for a Workflow
 *  run) the per-sub-agent fan-out. Never touches status (progress must not
 *  resurrect a terminal task); materializes a running entry if the 'started'
 *  was missed. Returns true if anything changed. */
export function applyBgTaskProgress(
  map: Map<string, BgTask>,
  ev: BgTaskProgressEventLike,
  at: number,
): boolean {
  if (!ev || !ev.taskId) return false;
  let t = map.get(ev.taskId);
  if (!t) {
    t = {
      taskId: ev.taskId, description: ev.description ?? null, command: null,
      toolUseId: null, taskType: null, status: 'running', startedAt: at,
      endedAt: null, outputFile: null, summary: null,
      workflowName: ev.workflowName ?? null, usage: null, lastToolName: null, agents: null,
    };
    map.set(ev.taskId, t);
  }
  if (ev.description) t.description = ev.description;
  if (ev.workflowName) t.workflowName = ev.workflowName;
  if (ev.lastToolName) t.lastToolName = ev.lastToolName;
  if (ev.usage) {
    t.usage = {
      tokens: ev.usage.tokens ?? null,
      toolUses: ev.usage.tool_uses ?? null,
      durationMs: ev.usage.duration_ms ?? null,
    };
  }
  if (Array.isArray(ev.agents)) {
    t.agents = ev.agents.map((a) => ({
      index: a.index ?? null, label: a.label ?? null, state: a.state ?? null,
      model: a.model ?? null, phaseTitle: a.phaseTitle ?? null, tokens: a.tokens ?? null,
      toolCalls: a.toolCalls ?? null, durationMs: a.durationMs ?? null,
      resultPreview: a.resultPreview ?? null,
    }));
  }
  return true;
}

/** The CLI process died or restarted (session sleeping/error): its background
 *  children are gone with it — running tasks can never notify again. */
export function markRunningBgTasksStale(map: Map<string, BgTask>): boolean {
  let changed = false;
  const now = Math.floor(Date.now() / 1000);
  for (const t of map.values()) {
    if (t.status === 'running') {
      t.status = 'stale';
      t.endedAt = t.endedAt ?? now;
      changed = true;
    }
  }
  return changed;
}

/** Stable display order: running first (oldest first — longest-running on
 *  top), then ended ones newest first. Returns a NEW array (React state). */
export function bgTasksToArray(map: Map<string, BgTask>): BgTask[] {
  const arr = Array.from(map.values(), (t) => ({ ...t }));
  arr.sort((a, b) => {
    const ar = a.status === 'running' ? 0 : 1;
    const br = b.status === 'running' ? 0 : 1;
    if (ar !== br) return ar - br;
    return ar === 0 ? a.startedAt - b.startedAt : (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
  });
  return arr;
}

/** True when the tool_use is a background launch we should keep as a
 *  command-string candidate for the next 'started' event. */
export function isBgLaunchToolUse(name: string | undefined, input: any): boolean {
  return name === 'Bash' && !!input && input.run_in_background === true;
}
