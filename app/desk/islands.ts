// The island selector's list: one entry per machine, in the sidebar's order
// (folders, then machines), with what its robots are up to. Derived from the
// same summaries as the board — `moodOf` and nothing else.
import type { SessionSummary } from '@/lib/sessionSummary';
import type { Vps, VpsFolder } from '@/lib/types/api';
import { moodOf, type Mood } from './game/model';

export type IslandInfo = {
  id: string;
  name: string;
  folderId: string;
  folderName: string;
  total: number;
  tally: Record<Mood, number>;
  /** What the island most needs, loudest first; null on an empty machine. */
  top: Mood | null;
  /** Its agent daemon is unreachable. */
  offline: boolean;
};

const RANK: Mood[] = ['blocked', 'question', 'error', 'done', 'work', 'bg', 'idle', 'sleep'];

export function islandsOf(sessions: SessionSummary[], vps: Vps[], folders: VpsFolder[]): IslandInfo[] {
  const byVps = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const list = byVps.get(s.vpsId);
    if (list) list.push(s);
    else byVps.set(s.vpsId, [s]);
  }
  const order = new Map(folders.map((f, i) => [f.id, i] as const));
  const names = new Map(folders.map((f) => [f.id, f.name] as const));
  return vps
    .map((v, at) => ({ v, at, folder: order.get(v.folderId) ?? folders.length }))
    .sort((a, b) => a.folder - b.folder || a.at - b.at)
    .map(({ v }) => {
      const tally: Record<Mood, number> = { blocked: 0, question: 0, done: 0, error: 0, work: 0, bg: 0, idle: 0, sleep: 0 };
      const here = byVps.get(v.id) ?? [];
      for (const s of here) tally[moodOf(s)] += 1;
      return {
        id: v.id, name: v.name, folderId: v.folderId, folderName: names.get(v.folderId) ?? '',
        total: here.length, tally, top: RANK.find((m) => tally[m] > 0) ?? null,
        offline: v.agentStatus === 'error' || v.agentStatus === 'missing',
      };
    });
}

/** How loudly an island calls: lower is louder (the opening island, the sort of nothing else). */
export function islandRank(island: IslandInfo): number {
  return island.top ? RANK.indexOf(island.top) : RANK.length;
}

/**
 * The island the desk opens on: the one visited last, if it still has
 * robots; else the one that most wants you, the most crowded on a tie.
 */
export function homeIsland(islands: IslandInfo[], remembered: string | null): string | null {
  const inhabited = islands.filter((i) => i.total > 0);
  if (remembered && inhabited.some((i) => i.id === remembered)) return remembered;
  const best = [...inhabited].sort((a, b) => islandRank(a) - islandRank(b) || b.total - a.total)[0];
  return best?.id ?? islands[0]?.id ?? null;
}
