// A session's sub-sessions as its background work (§14.91/93): the Charon
// agents it launched, theirs under them, read from the session summaries
// (§14.108). The hub counts the same ones (`runningSubSessionIds`).
import { useSyncExternalStore } from 'react';
import { getSessionList, subscribeSummaries } from './sync/summaryStore';
import { WORKING_STATUSES } from './sessionUnread';
import type { SessionSummary } from '@/lib/sessionSummary';

export type CharonAgent = {
  id: string;
  name: string;
  handle: string | null;
  kind: string;
  /** Live status (`liveStatus ?? status`). */
  status: string;
  running: boolean;
  /** 0 = launched by the session itself. */
  depth: number;
  parentId: string;
  startMs: number;
  /** null while it runs. */
  endMs: number | null;
  model: string | null;
  effort: string | null;
};

/** Deeper than any sub-session tree may grow. */
const MAX_DEPTH = 8;
const EMPTY: CharonAgent[] = [];

/** Tree order: each child (oldest first) followed by its own. */
export function charonAgentsOf(rootId: string, list: readonly SessionSummary[]): CharonAgent[] {
  const children = new Map<string, SessionSummary[]>();
  for (const s of list) {
    if (!s.parentSessionId) continue;
    const kids = children.get(s.parentSessionId);
    if (kids) kids.push(s); else children.set(s.parentSessionId, [s]);
  }
  if (!children.has(rootId)) return EMPTY;
  const out: CharonAgent[] = [];
  const seen = new Set([rootId]);
  const walk = (parentId: string, depth: number) => {
    if (depth >= MAX_DEPTH) return;
    const kids = [...(children.get(parentId) ?? [])].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (const s of kids) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const status = String(s.liveStatus ?? s.status);
      const running = WORKING_STATUSES.has(status);
      const startMs = (s.createdAt ?? 0) * 1000;
      const lastMs = s.lastActivityMs ?? (s.lastUsedAt ?? s.createdAt ?? 0) * 1000;
      out.push({
        id: s.id, name: s.name || (s.handle ? `@${s.handle}` : s.id.slice(0, 8)), handle: s.handle ?? null,
        kind: s.kind, status, running, depth, parentId, startMs,
        endMs: running ? null : Math.max(startMs, lastMs),
        model: s.effectiveModel ?? s.model ?? null, effort: s.effort ?? null,
      });
      walk(s.id, depth + 1);
    }
  };
  walk(rootId, 0);
  return out;
}

// Per root: the same array back until something it shows changes (§14.38).
const cache = new Map<string, { list: readonly SessionSummary[]; key: string; value: CharonAgent[] }>();

function snapshot(rootId: string): CharonAgent[] {
  const list = getSessionList();
  const hit = cache.get(rootId);
  if (hit && hit.list === list) return hit.value;
  const value = charonAgentsOf(rootId, list);
  const key = value === EMPTY ? '' : JSON.stringify(value);
  if (hit && hit.key === key) { hit.list = list; return hit.value; }
  cache.set(rootId, { list, key, value });
  return value;
}

/** The Charon agents under `rootId`, live. */
export function useCharonAgents(rootId: string): CharonAgent[] {
  return useSyncExternalStore(subscribeSummaries, () => snapshot(rootId), () => EMPTY);
}
