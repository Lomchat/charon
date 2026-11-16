// A session's goal (CLAUDE.md §14.119): Claude's `/goal <condition>` (a
// Stop hook the CLI evaluates after each turn, read agent-side from the
// transcript) and Codex's `thread/goal/*` (an objective with a token budget
// the thread keeps working toward). One shape for both; the agent's `goal`
// event carries it in snake_case, the hub stores it camelCased on the session
// row (`agent_sessions.goal`), the summary carries it to every tab.

export type SessionGoalStatus =
  | 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'met' | 'failed';

export type SessionGoal = {
  objective: string;
  status: SessionGoalStatus;
  /** Claude: how many times the evaluator judged it (each "not yet" re-runs). */
  iterations?: number | null;
  /** Claude: the evaluator's last verdict, in its words. */
  reason?: string | null;
  /** Tokens spent on it (Claude: once met; Codex: live). */
  tokensUsed?: number | null;
  /** Codex: the budget it stops at. */
  tokenBudget?: number | null;
  /** Codex: seconds spent; Claude: from its duration once met. */
  timeUsedS?: number | null;
  setAt: number | null;
  updatedAt: number | null;
  /** The user closed this (reached / impossible) goal from its bar. Kept, not
   *  deleted: the agent re-reports the transcript's last goal at each start,
   *  and the same goal must not come back. */
  dismissed?: boolean;
};

export type WireSessionGoal = {
  objective?: unknown; status?: unknown; iterations?: unknown; reason?: unknown;
  tokens_used?: unknown; token_budget?: unknown; time_used_s?: unknown; duration_ms?: unknown;
  set_at?: unknown; updated_at?: unknown;
};

const STATUSES: ReadonlySet<string> = new Set([
  'active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'met', 'failed',
]);

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/** The agent's wire goal → the stored shape; garbage or null ⇒ null. */
export function goalFromWire(raw: WireSessionGoal | null | undefined): SessionGoal | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.objective !== 'string' || !raw.objective.trim()) return null;
  const status = typeof raw.status === 'string' && STATUSES.has(raw.status)
    ? raw.status as SessionGoalStatus : 'active';
  const durationMs = num(raw.duration_ms);
  return {
    objective: raw.objective.slice(0, 4000),
    status,
    iterations: num(raw.iterations),
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason.slice(0, 2000) : null,
    tokensUsed: num(raw.tokens_used),
    tokenBudget: num(raw.token_budget),
    timeUsedS: num(raw.time_used_s) ?? (durationMs != null ? Math.round(durationMs / 1000) : null),
    setAt: num(raw.set_at),
    updatedAt: num(raw.updated_at),
  };
}

export function parseSessionGoal(json: string | null | undefined): SessionGoal | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as SessionGoal;
    return v && typeof v.objective === 'string' && typeof v.status === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** What the goal bar shows: nothing for a dismissed one. */
export function shownGoal(g: SessionGoal | null | undefined): SessionGoal | null {
  return g && !g.dismissed ? g : null;
}

/** Still being worked toward (the session may re-open itself for it). */
export function goalIsLive(g: Pick<SessionGoal, 'status'> | null | undefined): boolean {
  return !!g && g.status !== 'met' && g.status !== 'failed';
}

export const GOAL_STATUS_LABEL: Record<SessionGoalStatus, string> = {
  active: 'working on it',
  paused: 'paused',
  blocked: 'blocked',
  usage_limited: 'waiting for usage limit',
  budget_limited: 'budget spent',
  met: 'reached',
  failed: 'judged impossible',
};

/** One line for a `/goal` command: the CLI reads the rest of the line as the
 *  condition, so whitespace collapses to single spaces. */
export function claudeGoalCommand(objective: string | null): string {
  return objective == null ? '/goal clear' : `/goal ${objective.replace(/\s+/g, ' ').trim()}`;
}
