import type { AgentActivity, AgentTranscriptInfo } from '@/lib/subagentActivity';
import type { WorkflowOutputResponse } from '@/lib/types/api';
export type ActivityView = {
  activityTop: number; outputTop: number; followActivity: boolean; followOutput: boolean;
  expanded: string[]; missionOpen: boolean; filesOpen: boolean;
  activitySnapshot?: AgentActivity[]; outputSnapshot?: AgentActivity[];
};
export type ActivityCacheEntry = {
  entries: AgentActivity[]; info: AgentTranscriptInfo; agentId: string; fileId: string;
  before: number | null; after: number; cursor: string; linked: boolean; checkedAt: number;
  view: ActivityView;
};
const cache = new Map<string, ActivityCacheEntry>();
const MAX_BYTES = 24 * 1024 * 1024;
export function newActivityEntry(): ActivityCacheEntry {
  return { entries: [], info: {}, agentId: '', fileId: '', before: null, after: 0, cursor: '', linked: false, checkedAt: 0,
    view: { activityTop: 0, outputTop: 0, followActivity: true, followOutput: true, expanded: [], missionOpen: false, filesOpen: false } };
}
export function getActivityEntry(key: string) {
  const item = cache.get(key);
  if (!item) return newActivityEntry();
  cache.delete(key); cache.set(key, item);
  return item;
}
export function saveActivityEntry(key: string, item: ActivityCacheEntry) {
  cache.delete(key); cache.set(key, item);
  const size = (v: ActivityCacheEntry) => v.entries.reduce((n,e) => n + 300 + 2 * ((e.content?.length || 0) + (e.detail?.length || 0) + (e.target?.length || 0)), 0);
  let charged = [...cache.values()].reduce((n,v) => n + size(v), 0);
  // Evict entire least-recently-used nodes, never individual loaded pages.
  while (cache.size && (charged > MAX_BYTES || cache.size > 20)) {
    const oldest = cache.keys().next().value!;
    charged -= size(cache.get(oldest)!); cache.delete(oldest);
  }
}
export function mergeActivityPage(item: ActivityCacheEntry, page: Extract<WorkflowOutputResponse, { ok: true }>, older: boolean) {
  if (page.entries.length) {
    const byId = new Map(item.entries.map(e => [e.id, e]));
    for (const event of page.entries) byId.set(event.id, event);
    item.entries = [...byId.values()].sort((a,b) => {
      const [ar,ab] = a.id.split(':').map(Number), [br,bb] = b.id.split(':').map(Number);
      return ar - br || ab - bb;
    });
  }
  if (!item.linked || older) item.before = page.nextBefore;
  if (!older) { item.after = page.nextAfter; item.cursor = page.cursor; }
  item.info = { ...item.info, ...page.info };
  item.agentId = page.agentId; item.fileId = page.fileId; item.linked = true; item.checkedAt = Date.now();
}
