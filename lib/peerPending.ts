// What a peer target still waits on once its turn has ended (CLAUDE.md §14.93):
// the request is HELD — answered when nothing it started still runs. Carried
// by `peer_message_status` while held (agent >= 0.144.0). Browser-safe.

export type PeerPending = {
  backgroundTasks?: number;
  waitingOn?: string[];
  subSessionsStarting?: number;
};

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function build(bg: unknown, waiting: unknown, starting: unknown): PeerPending | null {
  const out: PeerPending = {};
  const b = count(bg);
  if (b) out.backgroundTasks = b;
  if (Array.isArray(waiting)) {
    const handles = waiting.filter((h): h is string => typeof h === 'string' && !!h).slice(0, 10);
    if (handles.length) out.waitingOn = handles;
  }
  const s = count(starting);
  if (s) out.subSessionsStarting = s;
  return Object.keys(out).length ? out : null;
}

/** The agent's wire shape (snake_case). */
export function peerPendingFromWire(raw: unknown): PeerPending | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return build(r.background_tasks, r.waiting_on, r.sub_sessions_starting);
}

/** A hub frame / persisted row (camelCase), read defensively. */
export function asPeerPending(raw: unknown): PeerPending | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return build(r.backgroundTasks, r.waitingOn, r.subSessionsStarting);
}
