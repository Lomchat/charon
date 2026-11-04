import 'server-only';
import { foldSessionEventRows } from '@/lib/server/agent/sessionRowCache';
import {
  applyBgTaskEvent, BG_TASK_MAX_AGE_S, bgTasksToArray, isTerminalBgStatus,
  type BgTask,
} from '@/app/bgTasks';

/**
 * "Does this session still have background work running?" — hub-side.
 *
 * There is no bg-task table: the lifecycle is PERSISTED as ordinary `event`
 * rows (`sessionOps § case 'bg_task'`) and the registry is derived from them,
 * client-side by `app/bgTasks.ts` and here for the two server-side readers —
 * the session's own `background` status (§14.91) and the auto-update quiet gate
 * (`sdkWatch § isVpsBusy`). One reducer for both, because the two used to
 * disagree about what "still running" means and the answer decides whether a
 * VPS gets restarted from under a running task.
 */

/** A "running" task older than this counts as gone: a lost `finished` event
 *  would otherwise wedge a session as forever-busy. Re-exported from the
 *  shared client reducer — the cap must be the same number on both sides or
 *  the bar and the session status disagree about what is still running. */
export { BG_TASK_MAX_AGE_S };

/** The terminal-event rule, shared so the two callers cannot drift — and now
 *  sharing its VOCABULARY with `app/bgTasks.ts` too. The word list used to be
 *  duplicated as a regex here, and the copies disagreed: `error`/`timeout`
 *  ended the task client-side but not here (session stuck violet
 *  `background`), and `stop` — the word a stop_task kill reports — ended it
 *  nowhere. `updated` carries a free-form status string from the SDK, hence
 *  matching on the word rather than on an enum. */
export function isBgTaskDone(
  ev: { kind?: unknown; status?: unknown; terminal?: unknown },
): boolean {
  if (ev.kind === 'finished') return true;
  // agent >= 0.36.0 ships the SDK's own verdict on the event. It outranks our
  // word list: that list is a reimplementation of the SDK constant, and the
  // failure it was written about is precisely "a status word we didn't think
  // of". Older agents omit the flag → fall through to the words.
  if (typeof ev.terminal === 'boolean') return ev.kind === 'updated' && ev.terminal;
  return ev.kind === 'updated' && isTerminalBgStatus(ev.status);
}

/** taskId → startedAt (unix seconds), rebuilt from the persisted event rows —
 *  the alternative is a column that can silently disagree with the rows it is
 *  derived from. The full history is read through an incremental row cache
 *  (sessionRowCache.ts): after the first fold only newer rows are read.
 *
 *  The fold keeps the REDUCED registry, each row parsed once by `step`: a
 *  session's lifetime bg history grows without bound (thousands of rows for a
 *  sub-agent-heavy session), so a reader that re-parsed it was O(history) on
 *  hot paths — every live `started`, every Stop hook, every window GET (G1).
 *  Readers cost O(running) or O(their candidates); the per-task maps are
 *  O(tasks) MEMORY only (a re-run or a late event needs the task's prior
 *  state, `applyBgTaskEvent`).
 *
 *  The cold fold SCANS every row of the session (one LIKE per event row), so
 *  two kinds of readers:
 *  - STRICT (the stream's own status decisions, event-time closures): need
 *    the complete registry now — a cold fold runs to its end synchronously
 *    (it finishes a warming one);
 *  - TOLERANT (`…IfWarm`: the window GET, the session list, the auto-update
 *    quiet gate, a codex stream's attach): get null while a cold fold warms
 *    in 20 k-row slices in the background (G1), and answer conservatively. */
type BgRowStamp = { seq: number | null; tsMs: number | null; createdAt: number };
/** A task's latest `started` row naming a launcher tool_use. */
type BgLaunchAnchor = { rowId: number; toolUseId: string };

type BgRegistry = {
  /** Every task, reduced in id order (`applyBgTaskEvent`). */
  details: Map<string, BgTask>;
  /** taskId → startedAt of the tasks whose reduced status is `running`, in
   *  the order the full reduce inserts them. */
  running: Map<string, number>;
  /** Each task's LATEST lifecycle row (`bgTaskIdsBeforeEventFromDb`). */
  last: Map<string, BgRowStamp>;
  /** taskType as last stated, and the tasks ever flagged `ownedBySubagent`
   *  (`bgTasksHiddenFromStopHook`). */
  types: Map<string, string>;
  owned: Set<string>;
  /** Each task's latest `started` row that names its launcher (row id +
   *  tool_use id): the backward seek origin of the conversation view's
   *  launcher lookup (conversationSources.ts § withBgTaskLaunchers). */
  launch: Map<string, BgLaunchAnchor>;
};

/** Session rows per synchronous slice of a TOLERANT cold fold. */
export const BG_FOLD_SLICE_ROWS = 20_000;

function stepBgRegistry(reg: BgRegistry, row: { id: number; content: string; createdAt: number; seq: number | null; tsMs: number | null }): void {
  let ev: any;
  try { ev = JSON.parse(row.content); } catch { return; }   // a corrupt row must not blind the whole registry
  if (ev?.type !== 'bg_task') return;
  if (typeof ev.taskId === 'string') {
    // Malformed lifecycle rows cannot authorize a closure; a corrupt row flags nothing.
    reg.last.set(ev.taskId, { seq: row.seq, tsMs: row.tsMs, createdAt: row.createdAt });
    if (typeof ev.taskType === 'string') reg.types.set(ev.taskId, ev.taskType);
    if (ev.ownedBySubagent === true) reg.owned.add(ev.taskId);
    // Same rule as `applyBgTaskEvent`'s toolUseId: a `started` row naming a
    // launcher sets it; a later one without a launcher keeps the earlier.
    if (ev.kind === 'started' && typeof ev.toolUseId === 'string' && ev.toolUseId) {
      reg.launch.set(ev.taskId, { rowId: row.id, toolUseId: ev.toolUseId });
    }
  }
  if (!ev.taskId) return;
  try {
    applyBgTaskEvent(reg.details, ev, row.createdAt);
    const task = reg.details.get(ev.taskId)!;
    if (task.status !== 'running') reg.running.delete(ev.taskId);
    else reg.running.set(ev.taskId, task.startedAt);
  } catch { /* a corrupt row must not blind the whole registry */ }
}

// The fold hands its accumulator to the readers below WITHOUT a copy (a copy
// is O(tasks) per read): they only READ it, synchronously, and every value
// they return is a fresh Map/Set/array. Never export the registry itself.
function bgFold(sessionId: string, sliceRows?: number): { state: BgRegistry; complete: boolean } {
  return foldSessionEventRows<BgRegistry>('bg', sessionId, {
    likes: ['%"bg_task"%'],
    init: () => ({
      details: new Map(), running: new Map(), last: new Map(), types: new Map(), owned: new Set(), launch: new Map(),
    }),
    clone: (reg) => reg,
    step: (reg, row) => {
      stepBgRegistry(reg, row);
      return true;
    },
    ...(sliceRows != null ? { sliceRows, onComplete: () => publishBgWarm(sessionId) } : {}),
  });
}

/** A tolerant cold fold finished: a codex stream whose attach found it cold
 *  seeds its checks now (the same completion whoever started the fold). */
function publishBgWarm(sessionId: string): void {
  void import('@/lib/server/agent/sessionOps')
    .then((m) => m.bgRegistryWarmed(sessionId))
    .catch(() => { /* the next attach seeds it */ });
}

const EMPTY_REGISTRY: BgRegistry = {
  details: new Map(), running: new Map(), last: new Map(), types: new Map(), owned: new Set(), launch: new Map(),
};

/** STRICT: the complete registry. A failing read answers an empty one (a
 *  broken registry never blocks). */
function bgRegistry(sessionId: string): BgRegistry {
  try { return bgFold(sessionId).state; } catch { return EMPTY_REGISTRY; }
}

/** TOLERANT: the complete registry, or null while a cold fold warms. */
function bgRegistryIfWarm(sessionId: string): BgRegistry | null {
  try {
    const { state, complete } = bgFold(sessionId, BG_FOLD_SLICE_ROWS);
    return complete ? state : null;
  } catch { return EMPTY_REGISTRY; }
}

/** A plain, deep copy of the registry (the incremental-equals-full-scan
 *  tests); null while a cold fold warms when `tolerant`. Not for hot paths. */
export function bgRegistrySnapshotFromDb(sessionId: string, tolerant = false): {
  details: BgTask[]; running: Array<[string, number]>; last: Array<[string, BgRowStamp]>;
  types: Array<[string, string]>; owned: string[]; launch: Array<[string, BgLaunchAnchor]>;
} | null {
  const reg = tolerant ? bgRegistryIfWarm(sessionId) : bgRegistry(sessionId);
  if (!reg) return null;
  const byKey = <V>(m: Map<string, V>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    details: byKey(reg.details).map(([, t]) => ({ ...t })),
    running: [...reg.running.entries()],
    last: byKey(reg.last).map(([id, st]) => [id, { ...st }] as [string, BgRowStamp]),
    types: byKey(reg.types),
    owned: [...reg.owned].sort(),
    launch: byKey(reg.launch).map(([id, a]) => [id, { ...a }] as [string, BgLaunchAnchor]),
  };
}

/** TOLERANT: the launch anchors of the listed tasks (O(tasks asked)), or null
 *  while a cold fold warms. */
export function bgTaskLaunchAnchorsIfWarm(
  sessionId: string, taskIds: Iterable<string>,
): Map<string, BgLaunchAnchor> | null {
  const reg = bgRegistryIfWarm(sessionId);
  if (!reg) return null;
  const out = new Map<string, BgLaunchAnchor>();
  for (const taskId of taskIds) {
    const a = reg.launch.get(taskId);
    if (a) out.set(taskId, { ...a });
  }
  return out;
}

/** True when the task's latest lifecycle row predates the boundary. Prefer
 * event time across sequence resets, then seq for same-ms/legacy rows.
 * Missing ordering evidence is deliberately not permission to close work. */
function bgRowBefore(row: BgRowStamp, boundary: { seq: number | null; tsMs: number | null }): boolean {
  if (boundary.tsMs != null && row.tsMs != null && row.tsMs !== boundary.tsMs) return row.tsMs < boundary.tsMs;
  if (boundary.seq != null && row.seq != null) return row.seq < boundary.seq;
  // createdAt has only second precision: an equal second is ambiguous.
  if (boundary.tsMs != null) return row.createdAt < Math.floor(boundary.tsMs / 1000);
  return false;
}

/** Tasks whose latest recorded activity predates a native snapshot. A replay
 * sees the CURRENT DB registry, which may contain tasks created after that
 * snapshot. Absence from an older snapshot cannot close those tasks (§14.91).
 * `candidates`: the tasks the caller may close (its running set) — the answer
 * is then O(candidates); without, every task of the history is examined. */
export function bgTaskIdsBeforeEventFromDb(
  sessionId: string,
  boundary: { seq: number | null; tsMs: number | null },
  candidates?: Iterable<string>,
): Set<string> {
  const reg = bgRegistry(sessionId);
  const eligible = new Set<string>();
  const check = (taskId: string) => {
    const row = reg.last.get(taskId);
    if (row && bgRowBefore(row, boundary)) eligible.add(taskId);
  };
  if (candidates) for (const taskId of candidates) check(taskId);
  else for (const taskId of reg.last.keys()) check(taskId);
  return eligible;
}

/** Task kinds that run tools of their own, hence can own a sub-agent command. */
const BG_OWNER_TASK_TYPES = new Set(['local_agent', 'local_workflow', 'in_process_teammate']);

/** The Stop hook's `background_tasks` skips foreground commands, i.e. those a
 * SUB-AGENT runs itself (agent >= 0.98.3 flags them `ownedBySubagent`). Its
 * silence about one proves nothing while a task that could own it is listed
 * alive; once none is, silence means gone again. Returns the tasks a hook
 * listing `alive` must NOT close — among `candidates` when given (O(alive +
 * candidates)). Unflagged rows (older agents) stay closable. */
export function bgTasksHiddenFromStopHook(
  sessionId: string, alive: ReadonlySet<string>, candidates?: Iterable<string>,
): Set<string> {
  const reg = bgRegistry(sessionId);
  const ownerAlive = [...alive].some((id) => BG_OWNER_TASK_TYPES.has(reg.types.get(id) ?? ''));
  if (!ownerAlive) return new Set();
  if (!candidates) return new Set(reg.owned);
  const hidden = new Set<string>();
  for (const taskId of candidates) if (reg.owned.has(taskId)) hidden.add(taskId);
  return hidden;
}

/** STRICT (see `bgRegistry`): taskId → startedAt of the running tasks, a copy
 *  the caller owns. */
export function runningBgTasksFromDb(sessionId: string): Map<string, number> {
  return new Map(bgRegistry(sessionId).running);
}

/** STRICT, O(1): whether the persisted registry calls this task running. */
export function bgTaskRunningInDb(sessionId: string, taskId: string): boolean {
  return bgRegistry(sessionId).running.has(taskId);
}

/** TOLERANT: null while a cold fold warms (the caller answers conservatively). */
export function runningBgTasksIfWarm(sessionId: string): Map<string, number> | null {
  const reg = bgRegistryIfWarm(sessionId);
  return reg ? new Map(reg.running) : null;
}

/** Compact ACTIVE-task projection for the session-detail API. Unlike the
 * chat window it covers the complete lifecycle, then applies the same 24h
 * belief cap as the status/quiet-gate reducer. STRICT. */
export function runningBgTaskDetailsFromDb(
  sessionId: string,
  nowS = Math.floor(Date.now() / 1000),
): BgTask[] {
  return bgTaskDetails(bgRegistry(sessionId), nowS);
}

/** TOLERANT `runningBgTaskDetailsFromDb`: null while a cold fold warms (the
 *  window GET then omits it — the client keeps its window's registry). */
export function runningBgTaskDetailsIfWarm(
  sessionId: string,
  nowS = Math.floor(Date.now() / 1000),
): BgTask[] | null {
  const reg = bgRegistryIfWarm(sessionId);
  return reg ? bgTaskDetails(reg, nowS) : null;
}

function bgTaskDetails(reg: BgRegistry, nowS: number): BgTask[] {
  const running = new Map(reg.running);
  pruneStaleBgTasks(running, nowS);
  const active = new Map<string, BgTask>();
  for (const [taskId, startedAt] of running) {
    const detail = reg.details.get(taskId);
    active.set(taskId, {
      taskId,
      description: detail?.description ?? null,
      command: detail?.command ?? null,
      toolUseId: detail?.toolUseId ?? null,
      taskType: detail?.taskType ?? null,
      status: 'running',
      startedAt,
      endedAt: null,
      outputFile: detail?.outputFile ?? null,
      summary: null,
      workflowName: detail?.workflowName ?? null,
      usage: null,
      lastToolName: null,
      agents: null,
    });
  }
  return bgTasksToArray(active);
}

/** Drop the tasks too old to still be believed. Mutates, and answers whether
 *  anything is left. */
export function pruneStaleBgTasks(running: Map<string, number>, nowS: number): boolean {
  for (const [id, startedAt] of running) {
    if (nowS - startedAt >= BG_TASK_MAX_AGE_S) running.delete(id);
  }
  return running.size > 0;
}
