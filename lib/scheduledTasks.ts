// A session's SCHEDULED TASKS (CronCreate / ScheduleWakeup / /loop): prompts
// the Claude CLI will submit to the session by itself later. Browser-safe.
//
// The CLI owns them: they live in its memory, it restores them when the session
// resumes, and its Stop hook lists them at every turn end — the agent forwards
// that list with each task's next fire computed the CLI's way
// (agent/charon_agent/crons.py). The hub keeps the latest list per session
// (`agent_sessions.scheduled_tasks`, scheduledTaskState.ts) and ships it in
// the session summary (§14.108). A task fires only while the CLI runs: a
// sleeping session's list is dormant, not gone.

export type ScheduledTask = {
  id: string;
  /** 5-field cron, in the VPS's local time (`ScheduledTasksState.tz`). */
  schedule: string;
  /** false ⇒ fires once, then the CLI deletes it. */
  recurring: boolean;
  /** Submitted as a turn when it fires. The CLI clips it at 1000 chars,
   *  ending a clipped one with "… [+N chars]". */
  prompt: string;
  /** Epoch ms of the next fire, the CLI's per-task offset included. null =
   *  unknown: a one-shot whose time passed while the session was busy or
   *  asleep, or a cron the agent cannot read. */
  nextFireAt: number | null;
  /** Epoch ms of its CronCreate result, else when the hub first saw it. */
  createdAt: number;
};

export type ScheduledTasksState = {
  tasks: ScheduledTask[];
  /** Epoch ms of the turn end that reported the list. */
  asOf: number;
  /** The VPS zone the cron fields are written in. */
  tz?: { name: string; offsetMin: number };
};

/** The agent's `turn_end.scheduled_tasks[]` / `schedule_tz` (crons.py). */
export type WireScheduledTask = {
  id?: unknown; schedule?: unknown; recurring?: unknown; prompt?: unknown; next_fire_at?: unknown;
};
export type WireScheduleTz = { name?: unknown; offset_min?: unknown };

/** The CLI deletes a recurring task this long after its creation. */
export const RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function parseScheduledTasks(json: string | null | undefined): ScheduledTasksState | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as ScheduledTasksState;
    return v && Array.isArray(v.tasks) ? v : null;
  } catch {
    return null;
  }
}

/** The title a task goes by: the bracketed label a prompt opens with
 *  ("[Recheck 2/3 — …] La condition…" ⇒ "Recheck 2/3 — …"), else its first
 *  line. */
export function scheduledTaskTitle(t: Pick<ScheduledTask, 'prompt' | 'id'>): string {
  const text = t.prompt.trim();
  const label = /^\[([^\]\n]{1,200})\]/.exec(text);
  if (label) return label[1].trim();
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line ? (line.length > 120 ? `${line.slice(0, 120)}…` : line) : `task ${t.id}`;
}

/** The prompt without the bracketed label its title already shows. */
export function scheduledTaskBody(t: Pick<ScheduledTask, 'prompt'>): string {
  return t.prompt.trim().replace(/^\[[^\]\n]{1,200}\]\s*/, '');
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NUM = /^\d+$/;

function hhmm(h: string, m: string): string {
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/** The schedule in words, in the cron's own (VPS) time; the raw cron for a
 *  shape this does not know. */
export function describeSchedule(schedule: string, recurring: boolean): string {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return schedule;
  const [mi, h, dom, mon, dow] = f;
  const every = /^\*\/(\d+)$/;
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') {
    if (mi === '*') return recurring ? 'every minute' : 'in the next minute';
    const n = every.exec(mi);
    if (n) return n[1] === '1' ? 'every minute' : `every ${n[1]} minutes`;
    if (NUM.test(mi)) return recurring ? `every hour at :${mi.padStart(2, '0')}` : `at :${mi.padStart(2, '0')}`;
    return `cron ${schedule}`;
  }
  if (!NUM.test(mi)) return `cron ${schedule}`;
  const nh = every.exec(h);
  if (nh && dom === '*' && mon === '*' && dow === '*') return `every ${nh[1]} hours at :${mi.padStart(2, '0')}`;
  if (!NUM.test(h)) return `cron ${schedule}`;
  const at = hhmm(h, mi);
  if (dom === '*' && mon === '*') {
    if (dow === '*') return recurring ? `every day at ${at}` : `at ${at}`;
    if (dow === '1-5') return `weekdays at ${at}`;
    if (NUM.test(dow) && DAYS[Number(dow) % 7]) return `${recurring ? 'every ' : ''}${DAYS[Number(dow) % 7]} at ${at}`;
    return `cron ${schedule}`;
  }
  if (NUM.test(dom) && dow === '*') {
    if (mon === '*') return recurring ? `monthly on day ${dom} at ${at}` : `on day ${dom} at ${at}`;
    if (NUM.test(mon) && MONTHS[Number(mon) - 1]) {
      const day = `${MONTHS[Number(mon) - 1]} ${dom}`;
      return recurring ? `every year on ${day} at ${at}` : `${day} at ${at}`;
    }
  }
  return `cron ${schedule}`;
}

/** A `scheduled_fire` row (event payload) as the transcript Msg carries it:
 *  JSON in `content`, decoded by `parseScheduledFire`. */
export type ScheduledFire = {
  prompt: string; source: string; taskId?: string; schedule?: string; recurring?: boolean;
};

export function scheduledFireContent(ev: Record<string, unknown>): string {
  const fire: ScheduledFire = {
    prompt: typeof ev.prompt === 'string' ? ev.prompt : '',
    source: typeof ev.source === 'string' ? ev.source : 'schedule_wakeup',
    ...(typeof ev.taskId === 'string' ? { taskId: ev.taskId } : {}),
    ...(typeof ev.schedule === 'string' ? { schedule: ev.schedule } : {}),
    ...(typeof ev.recurring === 'boolean' ? { recurring: ev.recurring } : {}),
  };
  return JSON.stringify(fire);
}

export function parseScheduledFire(content: string): ScheduledFire | null {
  try {
    const v = JSON.parse(content) as ScheduledFire;
    return v && typeof v.prompt === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** How early the CLI may fire a task (a one-shot on :00/:30 up to 90 s), plus
 *  clock skew between the VPS and the hub. */
export const FIRE_EARLY_MS = 2 * 60 * 1000;

/** One fire of a task: a recurring task fires once per `nextFireAt`. */
export function fireKey(t: Pick<ScheduledTask, 'id' | 'nextFireAt'>): string {
  return `${t.id}@${t.nextFireAt ?? 'due'}`;
}

/** The task a turn the CLI opened by itself at `atMs` is the fire of: the
 *  most overdue one that is due by then (a one-shot whose time passed while
 *  the session was busy or asleep counts as due), never a fire `fired`
 *  already named. Null ⇒ that turn was something else. */
export function dueScheduledTask(
  tasks: readonly ScheduledTask[], atMs: number, fired: ReadonlySet<string> = new Set(),
): ScheduledTask | null {
  let best: ScheduledTask | null = null;
  const rank = (t: ScheduledTask) => t.nextFireAt ?? -Infinity;
  for (const t of tasks) {
    const due = t.nextFireAt != null ? t.nextFireAt <= atMs + FIRE_EARLY_MS : !t.recurring;
    if (!due || fired.has(fireKey(t))) continue;
    if (!best || rank(t) < rank(best)) best = t;
  }
  return best;
}

/** The task a fired prompt belongs to: its listed prompt (unclipped part)
 *  opens the fired one. Longest match wins; null when none does. */
export function matchFiredTask(tasks: readonly ScheduledTask[], prompt: string): ScheduledTask | null {
  const fired = prompt.trim();
  let best: ScheduledTask | null = null;
  let bestLen = 0;
  for (const t of tasks) {
    const head = t.prompt.replace(/… \[\+\d+ chars\]$/, '').trim();
    if (head && fired.startsWith(head) && head.length > bestLen) { best = t; bestLen = head.length; }
  }
  return best;
}
